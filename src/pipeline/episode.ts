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
import {
  BLOCKING_VERDICTS,
  verificationReportSchema,
  verificationSchema,
  verifyAll,
  verifyClaim,
} from '../evidence/verify';
import { repairAll, repairReportSchema } from '../evidence/repair';
import { LlmClient } from '../models/client';
import { renderResultSchema, renderScript } from '../render/assemble';
import { TtsProvider } from '../render/tts';
import { Script, scriptProgressSchema, scriptSchema, writeScript } from '../script/write';
import { runGate, GateReport } from '../qa/gate';
import { Run } from '../run/store';

export interface PipelineDeps {
  writer: LlmClient;
  verifier: LlmClient;
  /**
   * A cheap model for mechanical work. See clerkConfig in config/index.ts for
   * the rule governing what may and may not be given to it.
   *
   * Optional, and falls back to the writer. A missing clerk must never be a
   * reason a run does not happen - it is a cost optimisation, not a dependency.
   */
  clerk?: LlmClient;
  /**
   * A cheap first pass over the claims, which may only ever confirm a clean
   * pass and must escalate everything else. See verifyAll.
   *
   * Optional. Without it every claim goes straight to the verifier, which is
   * more expensive and exactly as correct.
   */
  screener?: LlmClient;
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
  const budget = episodeBudgetPence();

  // EVERY LINE THE PIPELINE PRINTS ALSO GOES TO THE RUN'S JOURNAL. A run that
  // dies leaves a journal ending exactly where it died, which is the single
  // most useful artifact for working out what happened - and it is readable
  // with `tail -f` while the run is still going.
  const say = (stage: string) => (message: string) => {
    (deps.log ?? (() => undefined))(message);
    run.journal({ stage, event: message });
  };
  const log = say('pipeline');

  // Spend is journalled per call rather than only totalled, so "where did the
  // money go" is answerable after the fact rather than only in aggregate.
  let stage = 'pipeline';
  const spend = (pence: number) => {
    run.journal({ stage, event: 'spend', pence });
    run.spend(pence, budget);
  };

  run.journal({ stage: 'pipeline', event: 'start', detail: run.manifest.topic });

  const persona = loadPersona(run.manifest.personaId);
  const format = loadFormat(run.manifest.formatId);

  // --- 1. Brief -----------------------------------------------------------
  let brief: Brief;
  if (run.hasArtifact('brief')) {
    brief = run.readArtifact('brief', briefSchema);
    log(`brief: reusing "${brief.angle}"`);
  } else {
    stage = 'brief';
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
    stage = 'corpus';
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
    stage = 'claims';
    log('claims: extracting and binding to quotes');
    claimSet = await extractClaims(
      brief,
      corpus,
      format,
      deps.writer,
      spend,
      say('claims'),
      // Chunk-level checkpointing, for the same reason beats have it: each
      // chunk is thousands of tokens over a corpus that had to be searched and
      // fetched first, and a real run lost three of four to the fourth coming
      // back in an unexpected shape.
      {
        done: run.readCheckpoint('claims', z.array(claimSetSchema)) ?? [],
        save: (done) => run.writeCheckpoint('claims', done),
      }
    );
    run.writeArtifact('claims', claimSet);
    run.markComplete('claims');
    run.clearCheckpoint('claims');
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
    stage = 'verification';
    log('verification: checking every claim against its quote');
    verification = await verifyAll(
      claims,
      corpus.sources,
      deps.verifier,
      spend,
      deps.screener,
      say('verification'),
      // Per-claim, because this is the slowest stage whenever a rate limit is
      // tight: thirty-five claims at three requests a minute is twelve
      // minutes, and losing that to a failure on the last one is the most
      // expensive kind of waste in the pipeline.
      {
        done: run.readCheckpoint('verification', z.record(verificationSchema)) ?? {},
        save: (d) => run.writeCheckpoint('verification', d),
      }
    );

    log('verification: searching for evidence against contested claims');
    // The clerk writes these queries. It is generating search strings from a
    // claim, and a weak one simply finds nothing - the failure is visible and
    // cheap. Everything downstream of the search is unchanged.
    counterEvidence = await gatherCounterEvidence(
      claims,
      deps.search,
      deps.fetchDeps,
      deps.clerk ?? deps.writer,
      {},
      spend
    );

    run.writeArtifact('verification', { verification, counterEvidence });
    run.markComplete('verification');
    run.clearCheckpoint('verification');
    log(
      `verification: ${verification.blocking.length} blocking, ` +
        `${counterEvidence.filter((c) => c.sources.length).length} contested claims with counter-sources`
    );
  }

  // --- 4c. Repair ---------------------------------------------------------
  //
  // A CLAIM THAT SAYS MORE THAN ITS QUOTE USED TO BE DELETED, AND THE FACT WENT
  // WITH IT. One episode named six men and gave sentences for two, because the
  // claim carrying the other four said "Collins, Jones and Perkins each got
  // seven years" against a quote saying "three ringleaders each received seven
  // years". The seven years was solid; the names were the extractor filling in
  // from context. Binning it lost both.
  //
  // Narrow, then rebind, then keep it with a hedge the script has to say out
  // loud. See evidence/repair.ts for why the third route is honest rather than
  // a loophole - and section 7a of the gate for what stops it becoming one.
  let workingClaims: Claim[] = claims;
  if (run.hasArtifact('repair')) {
    const stored = run.readArtifact(
      'repair',
      z.object({ claims: z.array(claimSchema), report: repairReportSchema })
    );
    workingClaims = stored.claims;
    log(`repair: reusing (${stored.report.repaired.length} claims repaired)`);
  } else {
    stage = 'repair';
    // BOTH KINDS OF FAILURE GO THROUGH THE SAME REPAIR, which is the point of
    // doing it here rather than inside the verifier. The semantic failures come
    // from verification ("says more than the quote"); the structural ones come
    // from the ledger ("typed as a quotation but its wording does not appear in
    // the quote", "typed as a statistic but states no number").
    //
    // They look different and they are the same fault: a claim describing
    // itself as more than it is. Narrowing returns a corrected TYPE as well as
    // corrected text, so the one pass fixes both - and a run that fixed the
    // semantics while still failing the shape would have gained nothing.
    const semantic = verification.results.filter((v) => BLOCKING_VERDICTS.includes(v.verdict));
    const structural = checkLedger(claims, corpus.sources)
      .problems.filter((p) => p.kind === 'shape')
      .map((p) => ({
        claimId: p.claimId,
        verdict: 'partially_entailed' as const,
        reason: p.detail,
      }));

    // One repair per claim. A claim that failed both ways is narrowed once
    // against the more specific complaint, because two passes would mean the
    // second one narrowing the first one's output against a stale reason.
    const seen = new Set(semantic.map((v) => v.claimId));
    const failing = [...semantic, ...structural.filter((v) => !seen.has(v.claimId))];

    if (failing.length) {
      log(`repair: ${failing.length} claims say more than their quotes`);
      const repaired = await repairAll(claims, failing, {
        sources: corpus.sources,
        // The CLERK narrows. It is subtraction against a complaint that has
        // already been written by the verifier, with a deterministic re-check
        // after it - which is exactly the shape of work the clerk rule allows.
        narrower: deps.clerk ?? deps.writer,
        // Re-checked by the same verifier that rejected it. A repair judged by
        // a softer standard than the rejection would mean nothing.
        reverify: async (claim) => {
          const source = corpus.sources.find((src) => src.id === claim.sourceId);
          if (!source) {
            return {
              claimId: claim.id,
              verdict: 'not_entailed' as const,
              reason: 'its source is not in the corpus',
            };
          }
          const { verification: v, costPence } = await verifyClaim(claim, source, deps.verifier);
          spend(costPence);
          return v;
        },
        onCost: spend,
        onProgress: say('repair'),
      });
      workingClaims = repaired.claims;
      run.writeArtifact('repair', repaired);

      const counts = repaired.report.repaired.reduce<Record<string, number>>((acc, r) => {
        acc[r.method] = (acc[r.method] ?? 0) + 1;
        return acc;
      }, {});
      log(
        `repair: ${counts.narrowed ?? 0} narrowed, ${counts.rebound ?? 0} rebound, ` +
          `${counts.unverified ?? 0} kept as unsettled`
      );
    } else {
      run.writeArtifact('repair', { claims, report: { repaired: [], costPence: 0 } });
    }
    run.markComplete('repair');
  }

  // --- 5. Script ----------------------------------------------------------
  let script: Script;
  if (run.hasArtifact('script')) {
    script = run.readArtifact('script', scriptSchema);
    log(`script: reusing "${script.title}"`);
  } else {
    stage = 'script';
    log('script: writing beats');
    script = await writeScript(
      {
        persona,
        format,
        // THE REPAIRED CLAIMS, WHICH IS THE POINT OF THE REPAIR STAGE. This
        // used to filter out everything the verifier rejected, which is how an
        // episode lost four of its six sentences: the claim was dropped, and
        // the fact inside it went too.
        //
        // What reaches the writer now is the narrowed version where narrowing
        // worked, the rebound version where the corpus supported it elsewhere,
        // and the unsettled version - marked, with the words that must be said
        // about it - where neither did. A contradicted claim is not here at
        // all; repairAll drops those.
        claims: workingClaims,
        angle: brief.angle,
        isoDate: new Date().toISOString().slice(0, 10),
      },
      deps.writer,
      spend,
      // Beat-level checkpointing. Writing a ten-beat script is thirty model
      // calls; before this, a failure on beat eight discarded the twenty-one
      // that had already succeeded, because the whole script is one stage.
      {
        progress: run.readCheckpoint('script', scriptProgressSchema) ?? { beats: [] },
        save: (progress) => run.writeCheckpoint('script', progress),
      },
      say('script')
    );
    run.writeArtifact('script', script);
    run.markComplete('script');
    // The checkpoint has served its purpose the moment the stage artifact
    // exists, and leaving it would mean a re-run reads partial work in
    // preference to a finished script.
    run.clearCheckpoint('script');
    log(`script: "${script.title}", ${script.beats.length} beats`);
  }

  // --- 6. Render ----------------------------------------------------------
  let render: z.infer<typeof renderResultSchema>;
  if (run.hasArtifact('render')) {
    render = run.readArtifact('render', renderResultSchema);
    log(`render: reusing ${Math.round(render.durationS)}s of audio`);
  } else {
    stage = 'render';
    log('render: synthesising each beat');
    render = await renderScript(
      {
        beats: script.beats,
        // Voice per host id. Built from the cast rather than passed as one
        // voice, so a dialogue beat can be rendered as an exchange.
        voices: Object.fromEntries(persona.hosts.map((h) => [h.id, h.voice])),
        beatPathFor: (name) => run.mediaPath(name),
        outputPath: run.mediaPath('episode.wav'),
      },
      deps.tts,
      {},
      spend,
      say('render')
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
    claims: workingClaims,
    ledger: checkLedger(workingClaims, corpus.sources),
    verification,
    counterEvidence,
    durationS: render.durationS,
    priorTexts: deps.priorTexts,
    // The corpus and the roster, for the one check that looks outside the
    // claims. See GateInput.corpusText.
    corpusText: corpus.sources.map((s) => s.text).join('\n'),
    castNames: script.plan?.cast.map((c) => c.name) ?? [],
  });

  run.writeArtifact('qa', gate);
  run.markComplete('qa');
  log(gate.passed ? 'gate: passed' : `gate: FAILED (${gate.findings.filter((f) => f.blocking).length} blocking)`);
  run.journal({
    stage: 'pipeline',
    event: gate.passed ? 'done' : 'gate-failed',
    detail: script.title,
    pence: run.manifest.spentPence,
  });

  return { run, gate, script };
};
