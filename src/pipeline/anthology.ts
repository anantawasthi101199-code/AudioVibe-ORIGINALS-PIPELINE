/**
 * Cutting a source script into the shorts it was written to become.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE SHORT LANE. That lane derives a short from
 * a finished NARRATIVE episode: it picks a moment, works out an angle, and
 * writes new prose, because a minute out of the middle of a fifteen-minute
 * story is not a short - it starts in the wrong place and ends in the wrong
 * place.
 *
 * An anthology has no such problem. Its beats were written to be heard alone,
 * each with its own opening and its own landing, so there is nothing to rewrite
 * and nothing to select. The beat IS the short. That is the whole reason the
 * format exists, and it is why ten of these cost about what one derived short
 * costs: no brief, no corpus, no extraction, no verification, no writing. A
 * title and a render.
 *
 * EVERY SHORT IS ITS OWN RUN, gated and published separately, and that is not
 * bookkeeping. A short is what a listener actually meets; it is the thing that
 * needs a provenance trail, a claim ledger and a gate report of its own. A
 * single run producing ten published items would have one gate report covering
 * ten things that succeed and fail independently.
 *
 * THE SOURCE IS NEVER PUBLISHED. It has no audio at all - runEpisode stops
 * before the render for a sourceOnly format - so there is nothing here that
 * could accidentally go out whole.
 */
import { z } from 'zod';
import { loadPersona } from '../canon/load';
import { loadFormat, oneBeatFormat } from '../formats/load';
import { episodeBudgetPence } from '../config';
import { Claim, checkLedger, claimSchema } from '../evidence/claim';
import { corpusSchema, counterEvidenceSchema } from '../evidence/research';
import { verificationReportSchema } from '../evidence/verify';
import { renderResultSchema, renderScript } from '../render/assemble';
import { Script, beatText, scriptSchema, writeTitle } from '../script/write';
import { GateReport, runGate } from '../qa/gate';
import { Run } from '../run/store';
import { PipelineDeps } from './episode';

export interface CutResult {
  run: Run;
  gate: GateReport;
  script: Script;
  /** Which story of the set this was. */
  story: number;
}

/**
 * Cut every story out of a source run.
 *
 * Resumable in the same way every other stage is. A story whose run already
 * exists keeps its title and its audio, so a cut interrupted after six stories
 * pays for four on the second attempt rather than ten - and, more importantly,
 * does not leave six duplicate runs sitting beside the originals, which a
 * directory listing cannot tell apart.
 *
 * The gate is recomputed every time regardless, because it is deterministic
 * arithmetic that costs nothing and a stored report goes stale the moment a
 * check changes.
 */
export const cutStories = async (
  input: { source: Run; only?: number[] },
  deps: PipelineDeps
): Promise<CutResult[]> => {
  const log = deps.log ?? (() => undefined);
  const persona = loadPersona(input.source.manifest.personaId);
  const format = loadFormat(input.source.manifest.formatId);

  if (!format.sourceOnly) {
    throw new Error(
      `"${format.id}" is not a source format. Use "short" to derive a short from a finished episode.`
    );
  }

  /**
   * The disconfirming searches that belong to one story.
   *
   * Filtered by claim exactly as the verification results are: a cut story
   * carries its own beat's evidence and no other beat's, so its report says
   * what was checked for the claims it actually states.
   */
  const counterEvidenceFor = (claimIds: readonly string[]) =>
    stored.counterEvidence.filter((c) => claimIds.includes(c.claimId));

  const script = input.source.readArtifact('script', scriptSchema);
  const corpus = input.source.readArtifact('corpus', corpusSchema);
  const stored = input.source.readArtifact(
    'verification',
    z.object({
      verification: verificationReportSchema,
      // PARSED, NOT DISCARDED, AND IT WAS DISCARDED. This was read as
      // `z.array(z.unknown())` and then every cut wrote `counterEvidence: []`,
      // so the disconfirming searches the source ran - fourteen of them on the
      // set that found this - reached nothing. The gate then blocked six of ten
      // stories for "marked contested but no disconfirming search was run",
      // about claims that had been searched properly hours earlier.
      counterEvidence: counterEvidenceSchema.default([]),
    })
  );

  // The repaired claims where the source has them, because those are what the
  // script was actually written from - narrowed, rebound and hedged.
  const claims: Claim[] = input.source.hasArtifact('repair')
    ? input.source
        .readArtifact('repair', z.object({ claims: z.array(claimSchema) }))
        .claims.map((c) => claimSchema.parse(c))
    : input.source
        .readArtifact('claims', z.object({ claims: z.array(claimSchema) }))
        .claims.map((c) => claimSchema.parse(c));

  const byId = new Map(claims.map((c) => [c.id, c]));
  const results: CutResult[] = [];

  // What a previous cut already made, so an interrupted one resumes instead of
  // rendering a second copy of story three beside the first.
  const alreadyCut = new Map(
    Run.derivedFrom(input.source.id)
      .filter((r) => r.manifest.story !== undefined)
      .map((r) => [r.manifest.story!, r])
  );

  for (const [i, beat] of script.beats.entries()) {
    const story = i + 1;
    if (input.only?.length && !input.only.includes(story)) continue;

    const existing = alreadyCut.get(story);
    const run =
      existing ??
      Run.create({
        personaId: persona.id,
        formatId: format.id,
        topic: input.source.manifest.topic,
        derivedFrom: input.source.id,
        parentEpisode: input.source.manifest.episode,
        story,
      });

    const budget = episodeBudgetPence();
    const spend = (pence: number) => run.spend(pence, budget);
    // The stage IS the story, so the terminal can group ten cuts into ten
    // sections instead of forty indistinguishable indented lines.
    const stage = `story ${story}`;
    const say = (message: string) => {
      log(message, stage);
      run.journal({ stage, event: message });
    };

    // ONLY THE CLAIMS THIS STORY STATES. A short carrying the whole set's
    // ledger would publish a Sources sheet listing nine documents it never
    // mentions, which is worse than none - it looks like evidence for
    // something it is not evidence for.
    const used = beat.claimIds.map((id) => byId.get(id)).filter((c): c is Claim => Boolean(c));
    const usedSourceIds = new Set(used.map((c) => c.sourceId));
    const sources = corpus.sources.filter((s) => usedSourceIds.has(s.id));

    const oneStory: Script = {
      ...script,
      beats: [beat],
      title: script.title,
      description: script.description,
    };

    // Its own title, because this is what somebody sees in a feed. One call,
    // and the only model call a cut story makes - so a resumed cut reads the
    // one it already paid for rather than buying a second, different title for
    // audio that has already been rendered under the first.
    // IS WHAT IS ON DISK STILL THIS STORY? A run id is deterministic - channel,
    // episode number, date, slug - so deleting a source and remaking it the
    // same day on the same topic produces the SAME id. The shorts cut from the
    // first one survive the deletion, this loop finds them by that id, and
    // reuses their titles and their audio for a script they were never made
    // from. It happened: shorts timestamped 10:01 were reused for a source
    // created at 12:41, so every one of them had new words and old audio.
    //
    // Comparing the stored beat against the one being cut is exact and cheap.
    // Matching on the id alone was the bug.
    const storedScript = run.hasArtifact('script')
      ? run.readArtifact('script', scriptSchema)
      : null;
    const stale =
      storedScript !== null && beatText(storedScript.beats[0] ?? { turns: [] }) !== beatText(beat);

    if (stale) {
      say('the story changed since this was cut; re-titling and re-rendering');
    }

    const titled = storedScript && !stale
      ? storedScript
      : await (async () => {
          const { title, description } = await writeTitle(
            persona,
            input.source.manifest.topic,
            [beat],
            deps.writer,
            spend
          );
          return { title, description };
        })();
    const title = titled.title;
    oneStory.title = title;
    oneStory.description = titled.description;

    run.writeArtifact('claims', { claims: used, unsupported: [] });
    run.markComplete('claims');
    run.writeArtifact('corpus', { sources, rejected: [] });
    run.markComplete('corpus');
    run.writeArtifact('verification', {
      verification: {
        ...stored.verification,
        results: stored.verification.results.filter((v) => beat.claimIds.includes(v.claimId)),
        blocking: stored.verification.blocking.filter((v) => beat.claimIds.includes(v.claimId)),
      },
      counterEvidence: counterEvidenceFor(beat.claimIds),
    });
    run.markComplete('verification');
    run.writeArtifact('script', oneStory);
    run.markComplete('script');

    const already = run.isComplete('render') && !stale;
    say(`"${title}"`);
    say(`${run.id}`);
    if (already) say('audio already rendered, reusing it');

    // THE ONLY OTHER THING THAT COSTS ANYTHING. A cut interrupted at story
    // seven is resumed by running the same command again, and re-rendering six
    // finished stories would be most of the bill for no new audio.
    const render: z.infer<typeof renderResultSchema> = already
      ? run.readArtifact('render', renderResultSchema)
      : await renderScript(
          {
            beats: oneStory.beats,
            voices: Object.fromEntries(persona.hosts.map((h) => [h.id, h.voice])),
            beatPathFor: (name) => run.mediaPath(name),
            outputPath: run.mediaPath('episode.wav'),
          },
          deps.tts,
          // A CHANGED SCRIPT IS THE CASE reuseExisting exists for. Without it
          // the renderer finds the beat's wav already on disk and keeps it, so
          // forcing a re-render at this level still produced the old audio -
          // the same stale-reuse fault one layer down.
          stale ? { reuseExisting: false } : {},
          spend,
          say
        );
    if (!already) {
      run.writeArtifact('render', render);
      run.markComplete('render');
    }

    const gate = runGate({
      persona,
      // THE STORY'S OWN FORMAT, WHICH IS ONE BEAT LONG.
      //
      // Passing the whole ten-beat format to gate a one-beat script made the
      // gate ask after nine beats that were never meant to be there: "beat
      // story_02 cites 0 claims, below its floor of 6" and the same for
      // story_03 through story_10. Every short failed with ten to seventeen
      // blocking findings, almost all of them about beats belonging to other
      // shorts.
      //
      // A cut story IS a format of one beat: that beat's job, that beat's claim
      // floor, that beat's length. The set's 900 to 1800 second target belongs
      // to the source, which is never rendered and never gated as audio.
      format: oneBeatFormat(format, i),
      script: oneStory,
      claims: used,
      ledger: checkLedger(used, sources),
      verification: {
        ...stored.verification,
        results: stored.verification.results.filter((v) => beat.claimIds.includes(v.claimId)),
        blocking: stored.verification.blocking.filter((v) => beat.claimIds.includes(v.claimId)),
      },
      counterEvidence: counterEvidenceFor(beat.claimIds),
      durationS: render.durationS,
      sources,
      corpusText: sources.map((s) => s.text).join('\n'),
      castNames: script.plan?.cast.map((c) => c.name) ?? [],
      // NEITHER ITSELF NOR THE SET IT CAME OUT OF.
      //
      // A cut story IS a beat of the source, word for word, so comparing the
      // two reports a hundred percent overlap with something that is never
      // published - and a rerun compares a short against the copy of itself
      // the previous cut left on disk, which reports a hundred percent overlap
      // with itself. Both were blocking every short in the set, and both are
      // the same mistake the episode lane made once and fixed: the check is
      // for covering ground somebody ELSE has covered.
      priorTexts: (deps.priorTexts ?? []).filter(
        (prior) => prior.label !== input.source.id && prior.label !== run.id
      ),

    });

    run.writeArtifact('qa', gate);
    run.markComplete('qa');
    const blocking = gate.findings.filter((f) => f.blocking).length;
    say(
      `${Math.round(render.durationS)}s of audio, gate ${gate.passed ? 'PASSED' : `FAILED with ${blocking} blocking`}`
    );

    results.push({ run, gate, script: oneStory, story });
  }

  return results;
};
