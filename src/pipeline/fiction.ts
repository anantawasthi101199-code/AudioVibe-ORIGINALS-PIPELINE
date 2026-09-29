/**
 * The fiction pipeline: a premise in, an episode of a serial out.
 *
 * WHAT IT SKIPS, AND WHY THAT IS MOST OF THE COST. No brief, no search, no
 * corpus, no fetching, no quote binding, no verifier per claim, no
 * counter-evidence pass. Those five stages are where a factual episode spends
 * most of its money and nearly all of its wall-clock time, and none of them has
 * anything to do with an invented scene. There is no document that entails a
 * conversation nobody had.
 *
 *   Factual episode   ~80p   MEASURED over six runs, 81p to 93p on a clean
 *                             one. Research and verification are 43p of it.
 *   Fiction episode   ~40p   ESTIMATED, because this lane has never been run.
 *                             It is the factual figure minus the four stages
 *                             below, plus one continuity call.
 *
 * Both were written here as £3.40 and £0.90 when the lane was built, and both
 * were badly out of date within a fortnight - claim extraction was chunked, the
 * screener arrived, and the factual lane came down by three quarters. Numbers
 * in a comment rot; `make --dry-run` computes them from the live price table
 * and the actual beat count, and is the thing to trust.
 *
 * That makes fiction the cheapest full-length content the studio can make, and
 * it is worth being clear that cheapness is not the argument for it. The
 * argument is that a serial is the only format here where a listener has a
 * reason to come back for the NEXT one rather than for the topic, and that is
 * the difference between a catalogue and a show.
 *
 * WHAT IT DOES NOT SKIP. Everything that makes the audio worth hearing. Style
 * scoring, hook competition, loop structure, voice distinctness, self
 * similarity, duration - all unchanged, because they are properties of the
 * audio rather than of how it was sourced. And it gains a check the factual
 * lane does not have: continuity against the series bible.
 *
 * THE DISCLOSURE IS IDENTICAL. Fiction publishes under the same AI label. "It
 * is obviously a story" is not a disclosure, and the EU AI Act has no fiction
 * exemption.
 */
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
import { renderResultSchema, renderScript } from '../render/assemble';
import { Script, scriptProgressSchema, scriptSchema, writeScript } from '../script/write';
import { runGate, GateReport } from '../qa/gate';
import { Run } from '../run/store';
import {
  Bible,
  bibleSchema,
  castBrief,
  loadBible,
  saveBible,
  storySoFar,
} from '../fiction/bible';
import {
  ContinuityReport,
  applyEpisode,
  checkContinuity,
  extractEstablished,
} from '../fiction/continuity';
import { briefForEpisode, locateEpisode, planDrift } from '../fiction/season';
import { PipelineDeps } from './episode';

export interface FictionResult {
  run: Run;
  gate: GateReport;
  script: Script;
  /** The bible AFTER this episode, if it passed. Unchanged if it did not. */
  bible: Bible;
}

/**
 * The series so far, as the writer should see it.
 *
 * Stored as the run's `brief` artifact, which is exactly what it is: the thing
 * the episode is written against. Reusing the stage name keeps a fiction run
 * directory readable by anyone who knows a factual one, and keeps the resume
 * logic identical rather than nearly identical.
 */
const seriesBriefSchema = z.object({
  premise: z.string().min(1),
  cast: z.string(),
  storySoFar: z.string(),
  episodeNumber: z.number().int().positive(),
  /**
   * The season plan's brief for this episode, already rendered.
   *
   * STORED RATHER THAN RECOMPUTED, because a plan is a file a person is meant
   * to edit. A run resumed after somebody rewrote episode four's card would
   * otherwise write the second half of an episode against a different brief
   * from the first half, and nothing anywhere would say so.
   *
   * Absent for a show with no plan, which is a serial being improvised rather
   * than an error.
   */
  seasonBrief: z.string().optional(),
  /** Which season, and which episode of it. For the log. */
  season: z.number().int().positive().optional(),
  episodeOfSeason: z.number().int().positive().optional(),
});

export const runFiction = async (
  input: { run: Run; premise?: string },
  deps: PipelineDeps
): Promise<FictionResult> => {
  const { run } = input;

  // Same journal as the factual pipeline, for the same reason: a run that dies
  // should leave a record ending exactly where it died.
  const say = (stage: string) => (message: string) => {
    (deps.log ?? (() => undefined))(message);
    run.journal({ stage, event: message });
  };
  const log = say('pipeline');

  const persona = loadPersona(run.manifest.personaId);
  const format = loadFormat(run.manifest.formatId);

  // A SERIAL IS WHERE A CHANGED VOICE HURTS MOST, because listeners follow it
  // rather than dipping into it. See canon/voiceRegistry.ts.
  assertVoiceUnchanged(persona, deps.tts.name, loadVoiceRegistry());

  if (!persona.fiction) {
    throw new Error(
      `${persona.name} is not a fiction show. runFiction skips the entire evidence ` +
        `pipeline, so running a factual show through it would publish unsourced claims ` +
        `under a show whose whole claim on a listener is that it read the documents.`
    );
  }

  const budget = episodeBudgetPence();
  let stage = 'pipeline';
  const spend = (pence: number) => {
    run.journal({ stage, event: 'spend', pence });
    run.spend(pence, budget);
  };

  run.journal({ stage: 'pipeline', event: 'start', detail: run.manifest.topic });

  let bible = loadBible(persona.id);

  // --- 1. The series so far ------------------------------------------------
  // No model call. A factual brief needs one because turning a topic into
  // searchable queries is real work; here the brief is a view over the bible,
  // which is already structured. Free, and deterministic, so a resumed run
  // reads the same series it started with.
  let brief: z.infer<typeof seriesBriefSchema>;
  if (run.hasArtifact('brief')) {
    brief = run.readArtifact('brief', seriesBriefSchema);
    log(`series: reusing episode ${brief.episodeNumber}`);
  } else {
    const episodeNumber = bible.episodes.length + 1;

    // THE SEASON PLAN, IF THERE IS ONE. Free: the plan is a file on disk and
    // the brief is assembled from it deterministically. A show without one
    // still runs, on the bible alone, which is what every episode made before
    // the planner existed did.
    const located = locateEpisode(persona.id, episodeNumber);

    brief = {
      premise: input.premise ?? run.manifest.topic,
      cast: castBrief(bible),
      storySoFar: storySoFar(bible),
      episodeNumber,
      seasonBrief: located ? briefForEpisode(located.plan, bible, located.number) : undefined,
      season: located?.plan.seasonNumber,
      episodeOfSeason: located?.number,
    };
    run.writeArtifact('brief', brief);
    run.markComplete('brief');

    if (located) {
      // locateEpisode only returns a number the season actually has, so this is
      // always present. Named rather than inlined so the log reads.
      const title = located.plan.episodes[located.number - 1]?.title ?? '(untitled)';
      log(
        `series: season ${located.plan.seasonNumber} episode ${located.number}, ` +
          `"${title}", written against the plan`
      );
      // ADVISORY, NEVER BLOCKING. The plan is intention and the bible is
      // history; when they disagree, the history is what happened.
      for (const note of planDrift(located.plan, bible)) log(`  drift: ${note}`);
    } else {
      // Said out loud rather than passed over. The difference between a planned
      // serial and an improvised one is the difference between an episode that
      // can foreshadow and one that cannot.
      log(
        `series: episode ${episodeNumber} is not covered by any season plan, so it ` +
          `is written from the bible alone. Break a season with ` +
          `"foundry season --show ${persona.id}".`
      );
    }
    log(
      `series: ${bible.entities.length} established entities across ` +
        `${bible.episodes.length} episode(s)`
    );
  }

  // --- 2. Script ----------------------------------------------------------
  let script: Script;
  if (run.hasArtifact('script')) {
    script = run.readArtifact('script', scriptSchema);
    log(`script: reusing "${script.title}"`);
  } else {
    stage = 'script';
    log('script: writing');
    script = await writeScript(
      {
        persona,
        format,
        // No claims. A fiction beat is grounded in the series rather than in a
        // document, and that grounding arrives through the angle below, which
        // carries the cast and the story so far.
        claims: [],
        // THE SEASON BRIEF ALREADY CARRIES THE CAST AND THE STORY SO FAR, plus
        // the things only a plan knows: what this episode has to answer, what it
        // has to plant, and where the next one picks up. Concatenating both would
        // hand the writer the same cast twice and the episode's job once.
        angle:
          brief.seasonBrief ??
          [
            brief.premise,
            '',
            'THE CAST, as established. Do not contradict any of this, and do not',
            'introduce someone new unless this episode is about them:',
            brief.cast,
            '',
            'WHAT HAS HAPPENED SO FAR, in the order a listener heard it:',
            brief.storySoFar,
          ].join('\n'),
        isoDate: new Date().toISOString().slice(0, 10),
      },
      deps.writer,
      spend,
      {
        progress: run.readCheckpoint('script', scriptProgressSchema) ?? { beats: [] },
        save: (progress) => run.writeCheckpoint('script', progress),
      },
      say('script')
    );
    run.writeArtifact('script', script);
    run.markComplete('script');
    run.clearCheckpoint('script');
    log(`script: "${script.title}", ${script.beats.length} beats`);
  }

  // --- 3. Continuity ------------------------------------------------------
  // The verifier, not the writer, and for the identical reason the factual lane
  // uses a different family: a writer asked whether its own episode contradicts
  // the series reconstructs why it does not. Fiction is if anything worse here,
  // because producing a plausible reconciliation is what a story writer is for.
  let continuity: ContinuityReport;
  if (run.hasArtifact('verification')) {
    continuity = run.readArtifact('verification', z.custom<ContinuityReport>());
    log(`continuity: reusing ${continuity.findings.length} checked fact(s)`);
  } else {
    stage = 'continuity';
    log('continuity: checking against the series bible');
    continuity = await checkContinuity(script, bible, deps.verifier, spend);
    run.writeArtifact('verification', continuity);
    run.markComplete('verification');
    log(
      `continuity: ${continuity.blocking.length} contradiction(s) across ` +
        `${continuity.findings.length} established fact(s)`
    );
  }

  // --- 4. Render ----------------------------------------------------------
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

  // --- 5. Gate ------------------------------------------------------------
  log('gate: checking');
  const gate = runGate({
    persona,
    format,
    script,
    claims: [],
    ledger: { ok: true, problems: [], claimsByBeat: {}, tierByBeat: {} },
    verification: { results: [], blocking: [], costPence: 0, verifierModel: continuity.checkerModel },
    counterEvidence: [],
    durationS: render.durationS,
    priorTexts: deps.priorTexts,
    continuity,
  });

  run.writeArtifact('qa', gate);
  run.markComplete('qa');
  log(gate.passed ? 'gate: passed' : `gate: FAILED (${gate.findings.filter((f) => f.blocking).length} blocking)`);

  // --- 6. The bible -------------------------------------------------------
  // ONLY ON A PASS, and this is the ordering that matters most in the file. An
  // episode that failed must not enter the bible: every later episode would be
  // checked against something nobody ever heard, and would be marked as
  // contradicting the series for disagreeing with an episode that does not
  // exist. A failed run leaves the series exactly as it found it.
  //
  // AND ONLY ONCE. Guarded on the artifact it writes, because every other stage
  // is resumable and this one has a side effect OUTSIDE the run directory. A
  // resumed passing run that re-ran this would append the same episode to the
  // series a second time, and the bible is append-only - nothing downstream
  // would ever notice the duplicate, it would just quietly become two episodes
  // that both happened.
  if (gate.passed && run.hasArtifact('claims')) {
    log('bible: already recorded for this run');
  } else if (gate.passed) {
    log('bible: recording what this episode established');
    // The writer, not the clerk. This is the fiction lane's claim extraction,
    // and the rule in clerkConfig is explicit that extraction is not clerical
    // work: a sloppy fact here is not a bad episode, it is a wrong entry that
    // every future episode gets checked against for the life of the series.
    const extracted = await extractEstablished(script, bible, deps.writer, spend);
    bible = applyEpisode(bible, extracted, { id: run.id, title: script.title });
    saveBible(bible);
    run.writeArtifact('claims', extracted);
    run.markComplete('claims');
    log(
      `bible: +${extracted.newEntities.length} entities, +${extracted.facts.length} facts ` +
        `(${bible.entities.length} total)`
    );
  } else {
    log('bible: unchanged, because the episode did not pass');
  }

  return { run, gate, script, bible };
};

/** Re-export so a caller does not need to know where the schema lives. */
export { bibleSchema };
