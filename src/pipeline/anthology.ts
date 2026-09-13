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
import { loadFormat } from '../formats/load';
import { episodeBudgetPence } from '../config';
import { Claim, checkLedger, claimSchema } from '../evidence/claim';
import { corpusSchema } from '../evidence/research';
import { verificationReportSchema } from '../evidence/verify';
import { renderResultSchema, renderScript } from '../render/assemble';
import { Script, scriptSchema, writeTitle } from '../script/write';
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

  const script = input.source.readArtifact('script', scriptSchema);
  const corpus = input.source.readArtifact('corpus', corpusSchema);
  const stored = input.source.readArtifact(
    'verification',
    z.object({ verification: verificationReportSchema, counterEvidence: z.array(z.unknown()) })
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
    const say = (message: string) => {
      log(`  ${message}`);
      run.journal({ stage: 'short', event: message });
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
    const titled = run.hasArtifact('script')
      ? run.readArtifact('script', scriptSchema)
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
      counterEvidence: [],
    });
    run.markComplete('verification');
    run.writeArtifact('script', oneStory);
    run.markComplete('script');

    const already = run.isComplete('render');
    log(
      `story ${story}/${script.beats.length}: "${title}" -> ${run.id}${already ? ' (already rendered)' : ''}`
    );

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
          {},
          spend,
          say
        );
    if (!already) {
      run.writeArtifact('render', render);
      run.markComplete('render');
    }

    const gate = runGate({
      persona,
      // THE STORY'S OWN LENGTH, NOT THE SET'S. The format targets 900 to 1800
      // seconds because that is ten stories; one of them is a couple of
      // minutes, so gating a cut short against the set's total reported every
      // single one as running at a tenth of its guide. Advisory, so it never
      // blocked anything - it just made the one length signal in the report
      // meaningless, which is how a check stops being read.
      format: { ...format, targetSeconds: format.beats[i]?.seconds ?? format.targetSeconds },
      script: oneStory,
      claims: used,
      ledger: checkLedger(used, sources),
      verification: {
        ...stored.verification,
        results: stored.verification.results.filter((v) => beat.claimIds.includes(v.claimId)),
        blocking: stored.verification.blocking.filter((v) => beat.claimIds.includes(v.claimId)),
      },
      counterEvidence: [],
      durationS: render.durationS,
      sources,
      corpusText: sources.map((s) => s.text).join('\n'),
      castNames: script.plan?.cast.map((c) => c.name) ?? [],
      priorTexts: deps.priorTexts,
    });

    run.writeArtifact('qa', gate);
    run.markComplete('qa');
    log(
      `  ${Math.round(render.durationS)}s, gate ${gate.passed ? 'passed' : `FAILED (${gate.findings.filter((f) => f.blocking).length} blocking)`}`
    );

    results.push({ run, gate, script: oneStory, story });
  }

  return results;
};
