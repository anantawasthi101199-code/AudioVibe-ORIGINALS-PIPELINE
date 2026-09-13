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
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { loadPersona } from '../canon/load';
import {
  assertVoiceUnchanged,
  loadVoiceRegistry,
  recordVoices,
  saveVoiceRegistry,
} from '../canon/voiceRegistry';
import { loadFormat } from '../formats/load';
import { episodeBudgetPence } from '../config';
import { checkLedger, Claim, claimSchema, locateQuote } from '../evidence/claim';
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
import { fillGaps, findGaps } from '../evidence/gaps';
import { LlmClient } from '../models/client';
import { renderResultSchema, renderScript } from '../render/assemble';
import { TtsProvider } from '../render/tts';
import { writeScriptOnePass } from '../script/onePass';
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
  /**
   * Write the whole script in one call instead of a beat at a time.
   *
   * THE DEFAULT SINCE THE COMPARISON WAS RUN, and the numbers are worth keeping
   * because the trigger for switching was written down in advance. Same show,
   * same topic, same corpus size:
   *
   *   beat by beat  38 of 66 facts used (58%), one fact per 24s, mean sentence
   *                 29.5 words, 26% of sentences past one breath - AND the
   *                 evidence beat, the longest in the format, cited NONE of the
   *                 21 claims researched for it.
   *   one pass      47 of 59 facts used (80%), one fact per 16s, mean sentence
   *                 25.8 words, evenly spread across every beat.
   *
   * The starved beat is the decisive one. Writing a beat at a time, a beat can
   * write around its facts and report none, and nothing notices until the gate.
   * A writer producing the whole script at once distributes the material because
   * it can see all of it.
   *
   * What it gives up: the per-beat critique loop, and any checkpoint inside the
   * write. Set false to go back, which `--beat-by-beat` does.
   */
  onePass?: boolean;
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

  // BEFORE ANY MODEL CALL. A channel whose voice has changed under it is a
  // different show to everybody following it, and finding that out after paying
  // for research, a script and audio is finding it out too late. See
  // canon/voiceRegistry.ts.
  assertVoiceUnchanged(persona, deps.tts.name, loadVoiceRegistry());

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
    // --- 4d. Go back for the names nobody placed. ---
    //
    // Extraction runs once, against a beat sheet, before anyone knows which
    // names the episode will lean on. It reliably produces a claim saying
    // Arnold Paole was bothering people at night and none saying who he was,
    // and by the time that matters the evidence stage is over - leaving the
    // writer a choice between saying a name it cannot place and dropping him.
    //
    // Nearly free, because the corpus is already on disk. No search, no fetch:
    // BM25 finds the passage that talks about the name, one cheap call reads
    // it, and the claim it produces is verified exactly like every other.
    const gaps = findGaps(workingClaims);
    if (gaps.length) {
      log(`gaps: ${gaps.length} name(s) the claims use and never introduce`);
      const found = await fillGaps(
        gaps,
        {
          sources: corpus.sources,
          // The clerk reads one passage for one fact against a deterministic
          // quote check and a verifier afterwards, which is exactly the shape
          // of work the clerk rule allows.
          model: deps.clerk ?? deps.writer,
          verify: async (candidate) => {
            const source = corpus.sources.find((src) => src.id === candidate.sourceId);
            if (!source) return false;
            if (!locateQuote(source.text, candidate.quote).found) return false;
            const { verification: v, costPence } = await verifyClaim(
              candidate,
              source,
              deps.verifier
            );
            spend(costPence);
            return v.verdict === 'entailed';
          },
          onCost: spend,
          onProgress: say('gaps'),
        },
        // Attached to the beat that introduces people, so the density floors
        // see them where a listener would meet them.
        format.beats[1]?.id ?? format.beats[0]!.id,
        1
      );

      if (found.length) {
        workingClaims = [...workingClaims, ...found];
        log(`gaps: filled ${found.length} of ${gaps.length}`);
        run.writeArtifact('repair', {
          claims: workingClaims,
          report: { repaired: [], costPence: 0 },
        });
      }
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
    // THE CLAIMS ARE THE SAME EITHER WAY, and so are the checks. The only thing
    // that differs between these two is whether the beats are written in one
    // call or in eleven, which is the whole point of being able to compare them.
    const scriptInput = {
      persona,
      format,
      // THE REPAIRED CLAIMS, WHICH IS THE POINT OF THE REPAIR STAGE. This used
      // to filter out everything the verifier rejected, which is how an episode
      // lost four of its six sentences: the claim was dropped, and the fact
      // inside it went too.
      //
      // What reaches the writer now is the narrowed version where narrowing
      // worked, the rebound version where the corpus supported it elsewhere,
      // and the unsettled version - marked, with the words that must be said
      // about it - where neither did. A contradicted claim is not here at all;
      // repairAll drops those.
      claims: workingClaims,
      angle: brief.angle,
      isoDate: new Date().toISOString().slice(0, 10),
    };

    if (deps.onePass) {
      log('script: writing the whole script in one pass');
      script = await writeScriptOnePass(
        scriptInput,
        deps.writer,
        spend,
        // The plan, and only the plan. See writeScriptOnePass.
        {
          progress: run.readCheckpoint('script', scriptProgressSchema) ?? { beats: [] },
          save: (progress) => run.writeCheckpoint('script', progress),
        },
        say('script')
      );
    } else {
      log('script: writing beats');
      script = await writeScript(
        scriptInput,
        deps.writer,
        spend,
        // Beat-level checkpointing. Writing a ten-beat script is thirty model
        // calls; before this, a failure on beat eight discarded the twenty-one
        // that had already succeeded, because the whole script is one stage.
        //
        // One pass has no equivalent and cannot have one: it is a single call,
        // so there is no partial result to keep. That is a real cost of the
        // method on a long episode.
        {
          progress: run.readCheckpoint('script', scriptProgressSchema) ?? { beats: [] },
          save: (progress) => run.writeCheckpoint('script', progress),
        },
        say('script')
      );
    }
    run.writeArtifact('script', script);
    run.markComplete('script');
    // The checkpoint has served its purpose the moment the stage artifact
    // exists, and leaving it would mean a re-run reads partial work in
    // preference to a finished script.
    run.clearCheckpoint('script');
    log(`script: "${script.title}", ${script.beats.length} beats`);
  }

  // --- 5b. A source format stops here. ---------------------------------------
  //
  // An anthology exists to be broken up. Rendering it would buy twenty minutes
  // of audio nobody will hear, and gating it as an episode would judge it as
  // something it is not trying to be - a flat list of ten unrelated stories
  // fails self-similarity, duration and half the narrative checks by design.
  //
  // The shorts are cut afterwards and each is rendered, gated and published on
  // its own, which is where those checks actually mean something.
  if (format.sourceOnly) {
    const stories = script.beats.length;
    log(`script: "${script.title}", ${stories} stories`);
    log('');
    log(`This format is a source: it is never rendered or published whole.`);
    log(`Cut the shorts with:`);
    log(`  npm run foundry -- shorts --run ${run.id}`);

    run.journal({
      stage: 'pipeline',
      event: 'source-script-ready',
      detail: script.title,
      pence: run.manifest.spentPence,
    });

    return {
      run,
      script,
      gate: {
        passed: true,
        findings: [],
        humanReviewReasons: [
          `a source script, not an episode. ${stories} stories, none rendered yet.`,
        ],
        prose: null,
      } as unknown as GateReport,
    };
  }

  // --- 6. Render -----------------------------------------------------------
  let render: z.infer<typeof renderResultSchema>;
  // THE ARTIFACT IS NOT THE AUDIO. Every other stage can be resumed from its
  // JSON because the JSON *is* the output; this one describes a file sitting
  // next to it, and the two can come apart. Deleting the media directory to
  // force a fresh render leaves render.json behind claiming nine minutes of
  // audio, and the run then "reused" a recording that does not exist, gated a
  // duration measured from a missing file, and reported "no audio created"
  // without ever saying what was wrong.
  //
  // So the audio has to be there before the record of it is believed.
  // RESOLVE RATHER THAN JOIN. The schema calls audioFile "relative to the run
  // directory" and renderScript stores the absolute path it was given, so the
  // two disagree and have since the field existed. resolve is correct for both
  // readings; join silently mangles the absolute one into a path that never
  // exists, which would make this check re-render every single time.
  const renderedAudio = run.hasArtifact('render')
    ? path.resolve(run.dir, run.readArtifact('render', renderResultSchema).audioFile)
    : null;

  if (renderedAudio && fs.existsSync(renderedAudio)) {
    render = run.readArtifact('render', renderResultSchema);
    log(`render: reusing ${Math.round(render.durationS)}s of audio`);
  } else {
    if (renderedAudio) {
      log('render: the previous audio is gone, so it is being made again');
    }
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

    // THE FIRST USE IS THE COMMITMENT. Written after a successful render rather
    // than before, so a run that fails at synthesis does not pin a show to a
    // voice nobody has heard. Never overwrites: a later run cannot quietly
    // re-point what listeners already know.
    const { registry, recorded } = recordVoices(
      persona,
      deps.tts.name,
      run.id,
      loadVoiceRegistry()
    );
    if (recorded.length) {
      saveVoiceRegistry(registry);
      for (const r of recorded) {
        log(`voice: ${persona.name} speaks as "${r.voiceId}" on ${deps.tts.name} from now on`);
      }
    }
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
