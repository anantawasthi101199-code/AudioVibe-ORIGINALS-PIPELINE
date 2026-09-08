/**
 * The pipeline: topic in, published episode out.
 *
 * RESUMABLE BY DESIGN. Every stage checks whether it has already run and skips
 * if so. That is not a nicety - rendering is the expensive step and scripting
 * the slow one, so a QA failure must not mean paying for both again. It also
 * means a run that dies halfway through a fifteen-minute render picks up where
 * it stopped rather than starting over.
 *
 * STOPS AT THE GATE, ALWAYS. `runEpisode` never publishes. Publishing is a
 * separate command a person invokes after reading the gate report, because the
 * two checks the gate defers to a human - has the script acknowledged the
 * counter-evidence, is that T4 source framed as an anecdote - are exactly the
 * ones an automated pipeline would wave through. A studio that publishes
 * without anyone reading the first episodes is the failure mode this whole
 * design exists to avoid.
 */
import { z } from 'zod';
import { loadPersona } from '../canon/load';
import { loadFormat } from '../formats/load';
import { episodeBudgetPence } from '../config';
import { checkLedger, Claim, claimSchema } from '../evidence/claim';
import { FetchDeps } from '../evidence/fetch';
import {
  Brief,
  briefSchema,
  buildBrief,
  ClaimSet,
  claimSetSchema,
  corpusSchema,
  extractClaims,
  gatherCorpus,
  gatherCounterEvidence,
  DEFAULT_GATHER,
} from '../evidence/research';
import { SearchProvider } from '../evidence/search';
import { Source } from '../evidence/source';
import { verificationReportSchema, verifyAll } from '../evidence/verify';
import { LlmClient } from '../models/client';
import { renderResultSchema, renderScript } from '../render/assemble';
import { TtsProvider } from '../render/tts';
import { Script, scriptSchema, writeScript } from '../script/write';
import { runGate, GateReport } from '../qa/gate';
import { Run } from '../run/store';

export interface PipelineDeps {
  writer: LlmClient;
  verifier: LlmClient;
  search: SearchProvider;
  tts: TtsProvider;
  fetchDeps: FetchDeps;
  /** Prior episodes to check self-similarity against. */
  priorTexts?: Array<{ label: string; text: string }>;
  log?: (message: string) => void;
}

const counterEvidenceSchema = z.array(
  z.object({
    claimId: z.string(),
    sources: z.array(z.custom<Source>()),
    queries: z.array(z.string()),
  })
);

export interface EpisodeResult {
  run: Run;
  gate: GateReport;
  script: Script;
}

/**
 * Run every stage up to and including the gate.
 *
 * The budget is checked after each costed call rather than at the end, so a run
 * that overspends stops at the call that overspent instead of after paying for
 * everything.
 */
export const runEpisode = async (run: Run, deps: PipelineDeps): Promise<EpisodeResult> => {
  const log = deps.log ?? (() => undefined);
  const budget = episodeBudgetPence();
  const spend = (pence: number) => run.spend(pence, budget);

  const persona = loadPersona(run.manifest.personaId);
  const format = loadFormat(run.manifest.formatId);

  // --- 1. Brief -----------------------------------------------------------
  let brief: Brief;
  if (run.hasArtifact('brief')) {
    brief = run.readArtifact('brief', briefSchema);
    log(`brief: reusing "${brief.angle}"`);
  } else {
    log('brief: planning the research');
    brief = await buildBrief(run.manifest.topic, persona, format, deps.writer, spend);
    run.writeArtifact('brief', brief);
    run.markComplete('brief');
    log(`brief: "${brief.angle}" with ${brief.queries.length} queries`);
  }

  // --- 2. Corpus ----------------------------------------------------------
  let corpus: { sources: Source[]; rejected: Array<{ url: string; reason: string }> };
  if (run.hasArtifact('corpus')) {
    corpus = run.readArtifact('corpus', corpusSchema);
    log(`corpus: reusing ${corpus.sources.length} sources`);
  } else {
    log('corpus: searching and fetching');
    corpus = await gatherCorpus(brief.queries, deps.search, deps.fetchDeps, DEFAULT_GATHER);
    run.writeArtifact('corpus', corpus);
    run.markComplete('corpus');
    log(`corpus: ${corpus.sources.length} sources, ${corpus.rejected.length} rejected`);
  }

  // A corpus this thin cannot support an episode, and going on would produce a
  // script whose claims are all drawn from three documents. Abandoning here is
  // cheaper than discovering it at the gate.
  if (corpus.sources.length < 4) {
    const reason =
      `only ${corpus.sources.length} usable sources. ` +
      `Rejections: ${corpus.rejected.slice(0, 5).map((r) => r.reason).join('; ') || 'none'}`;
    run.abandon(reason);
    throw new Error(`abandoned ${run.id}: ${reason}`);
  }

  // --- 3. Claims ----------------------------------------------------------
  let claimSet: ClaimSet;
  if (run.hasArtifact('claims')) {
    claimSet = run.readArtifact('claims', claimSetSchema);
    log(`claims: reusing ${claimSet.claims.length}`);
  } else {
    log('claims: extracting and binding to quotes');
    claimSet = await extractClaims(brief, corpus, format, deps.writer, spend);
    run.writeArtifact('claims', claimSet);
    run.markComplete('claims');
    log(`claims: ${claimSet.claims.length} bound, ${claimSet.unsupported.length} unsupported`);
  }

  const claims: Claim[] = claimSet.claims.map((c) => claimSchema.parse(c));

  // --- 4. Verification + counter-evidence ---------------------------------
  let verification: z.infer<typeof verificationReportSchema>;
  let counterEvidence: z.infer<typeof counterEvidenceSchema>;

  if (run.hasArtifact('verification')) {
    const stored = run.readArtifact(
      'verification',
      z.object({ verification: verificationReportSchema, counterEvidence: counterEvidenceSchema })
    );
    verification = stored.verification;
    counterEvidence = stored.counterEvidence;
    log(`verification: reusing (${verification.blocking.length} blocking)`);
  } else {
    log('verification: checking every claim against its quote');
    verification = await verifyAll(claims, corpus.sources, deps.verifier, spend);

    log('verification: searching for evidence against contested claims');
    counterEvidence = await gatherCounterEvidence(
      claims,
      deps.search,
      deps.fetchDeps,
      deps.writer,
      {},
      spend
    );

    run.writeArtifact('verification', { verification, counterEvidence });
    run.markComplete('verification');
    log(
      `verification: ${verification.blocking.length} blocking, ` +
        `${counterEvidence.filter((c) => c.sources.length).length} contested claims with counter-sources`
    );
  }

  // --- 5. Script ----------------------------------------------------------
  let script: Script;
  if (run.hasArtifact('script')) {
    script = run.readArtifact('script', scriptSchema);
    log(`script: reusing "${script.title}"`);
  } else {
    log('script: writing beats');
    script = await writeScript(
      {
        persona,
        format,
        // Only verified claims reach the writer. A claim the verifier rejected
        // must not be available to write from, or the gate becomes the only
        // thing standing between a bad claim and an episode.
        claims: claims.filter(
          (c) => !verification.blocking.some((b) => b.claimId === c.id)
        ),
        angle: brief.angle,
        isoDate: new Date().toISOString().slice(0, 10),
      },
      deps.writer,
      spend
    );
    run.writeArtifact('script', script);
    run.markComplete('script');
    log(`script: "${script.title}", ${script.beats.length} beats`);
  }

  // --- 6. Render ----------------------------------------------------------
  let render: z.infer<typeof renderResultSchema>;
  if (run.hasArtifact('render')) {
    render = run.readArtifact('render', renderResultSchema);
    log(`render: reusing ${Math.round(render.durationS)}s of audio`);
  } else {
    log('render: synthesising each beat');
    render = await renderScript(
      {
        beats: script.beats,
        voice: persona.voice,
        beatPathFor: (name) => run.mediaPath(name),
        outputPath: run.mediaPath('episode.wav'),
      },
      deps.tts,
      {},
      spend
    );
    run.writeArtifact('render', render);
    run.markComplete('render');
    log(`render: ${Math.round(render.durationS)}s across ${render.beatMap.length} beats`);
  }

  // --- 7. Gate ------------------------------------------------------------
  log('gate: checking');
  const gate = runGate({
    persona,
    format,
    script,
    claims,
    ledger: checkLedger(claims, corpus.sources),
    verification,
    counterEvidence,
    durationS: render.durationS,
    priorTexts: deps.priorTexts,
  });

  run.writeArtifact('qa', gate);
  run.markComplete('qa');
  log(gate.passed ? 'gate: passed' : `gate: FAILED (${gate.findings.filter((f) => f.blocking).length} blocking)`);

  return { run, gate, script };
};
