/**
 * The psychology lane: how your mind works, explained warmly and very simply.
 * Episodes of nine to twelve minutes, and shorts under three.
 *
 * EPISODE
 *   [free] SEARCH      the curriculum's queries, one per question the episode asks
 *   [free] CORPUS      refused hosts dropped, the best few kept by preference
 *   [paid] EXTRACT     the relevant context out of each document, separately   ~5p
 *   [paid] FUSE        one coherent understanding: the picture, the mechanism,
 *                      the moments, what helps. Disagreements decided here.    ~4p
 *   [paid] WRITE       the whole episode in one call                           ~6p
 *   [free] CHECK       safety, jargon, statistics, the picture, the outro
 *   [paid] RENDER      OpenAI voice                                           ~14p
 *   [free] GATE        again at publish
 *
 * SHORT
 *   [free] SEARCH + one article, chosen by preference and length
 *   [paid] WRITE       one call, one idea, no jargon                           ~4p
 *   [paid] RENDER                                                              ~3p
 *
 * The two-stage research is the owner's instruction and the lane's whole point:
 * "the first step needs to be the best extract most relevant context, then
 * combine into 1 source of truth, like a coherent thing, then make script". See
 * psych/understand.ts for why that beats handing six documents to one call.
 *
 * ITS OWN LANE. Nothing here is reached from the news, business, story or
 * fiction pipelines and nothing there is reached from here. What is shared is
 * the plumbing every lane shares: the run store, the renderer, the voice
 * registry, the gate and the corpus fetcher.
 */
import { formatForRun } from '../formats/forRun';
import { musicFor } from '../render/musicFor';
import { z } from 'zod';
import { loadPersona } from '../canon/load';
import {
  assertVoiceUnchanged,
  loadVoiceRegistry,
  recordVoices,
  saveVoiceRegistry,
} from '../canon/voiceRegistry';
import { budgetFor } from './budget';
import { stageFlags, stagesOff } from '../config/stages';
import { claimSchema } from '../evidence/claim';
import { gatherCorpus } from '../evidence/research';
import { SearchProvider } from '../evidence/search';
import { Source, sourceSchema } from '../evidence/source';
import { loadFormat } from '../formats/load';
import { GateReport } from '../qa/gate';
import { renderResultSchema, renderScript } from '../render/assemble';
import { Run } from '../run/store';
import { Script, scriptSchema } from '../script/write';
import { estimatedSeconds, psychDraftProblems, psychGate } from '../psych/check';
import {
  Curriculum,
  bonusOf,
  loadCurriculum,
  preferenceOf,
  refusedReason,
} from '../psych/curriculum';
import { buildEpisodePrompt, buildShortPrompt, writePsychScript } from '../psych/psychScript';
import {
  Findings,
  Understanding,
  buildUnderstanding,
  extractFindings,
  findingsSchema,
  renderUnderstanding,
  understandingSchema,
} from '../psych/understand';
import type { PipelineDeps } from './episode';
import { withOutro } from '../script/outro';

export interface PsychDeps {
  now?: () => Date;
  curriculum?: Curriculum;
}

export const psychRecordSchema = z.object({
  psych: z.object({
    topic: z.string(),
    understanding: understandingSchema.optional(),
    /** What a short was written from instead of an understanding. */
    article: z.object({ id: z.string(), title: z.string(), url: z.string() }).optional(),
    considered: z.array(z.object({ url: z.string(), reason: z.string() })).default([]),
  }),
});

const corpusArtifactSchema = z.object({
  sources: z.array(sourceSchema),
  rejected: z.array(z.object({ url: z.string(), reason: z.string() })),
});

/**
 * The one-entry ledger the listener-facing Sources sheet is built from.
 *
 * Same reason as the news and business lanes: publishing lists only sources a
 * claim rests on, and an episode with an empty Sources sheet would say the
 * opposite of the truth about how it was made.
 */
const anchorClaim = (source: Source, topic: string, beatId: string) => {
  const sentence = (source.text.match(/[^.!?\n]{60,400}[.!?]/g) ?? [source.text.slice(0, 300)])[0]!.trim();
  return claimSchema.parse({
    id: 'psych-1',
    text: `What is understood about ${topic}`,
    type: 'attribution',
    beatId,
    sourceId: source.id,
    quote: sentence,
    status: 'unverified',
  });
};

/**
 * The curriculum's refused list, applied to search results before anything is
 * fetched.
 *
 * `gatherCorpus` does the searching and fetching and cannot know one channel's
 * rules. Filtering only afterwards, which is what this did first, meant a
 * forum thread and a therapy marketplace were downloaded and then discarded -
 * and worse, they counted towards the quota and pushed out documents the show
 * would actually have read.
 */
export const onlyAllowed = (search: SearchProvider, book: Curriculum): SearchProvider => ({
  name: search.name,
  search: async (query: string, limit: number) =>
    (await search.search(query, limit)).filter((r) => !refusedReason(r.url, book)),
});

/**
 * Drop what the curriculum refuses, then keep the best few.
 *
 * The refusal check runs again here, after the fetch, and that is not
 * redundant: a fetch follows redirects and a source is tiered and cited by the
 * address it ENDED at, so a tidy-looking link can still land on a refused host.
 */
export const chooseSources = (
  sources: Source[],
  book: Curriculum,
  keep: number
): { kept: Source[]; dropped: Array<{ url: string; reason: string }> } => {
  const dropped: Array<{ url: string; reason: string }> = [];
  const usable: Source[] = [];
  for (const source of sources) {
    const no = refusedReason(source.url, book);
    if (no) dropped.push({ url: source.url, reason: no });
    else usable.push(source);
  }

  // Preference first, then the longer document, which on this subject is the
  // one that explains rather than the one that lists.
  const ranked = [...usable].sort(
    (a, b) =>
      preferenceOf(a.url, book) - preferenceOf(b.url, book) ||
      b.text.length - a.text.length
  );
  for (const extra of ranked.slice(keep)) {
    dropped.push({ url: extra.url, reason: 'enough documents already, and these were preferred' });
  }
  return { kept: ranked.slice(0, keep), dropped };
};

/** The single article a short is written from. */
export const chooseArticle = (sources: Source[], book: Curriculum, minChars: number): Source | null => {
  const usable = sources.filter((s) => !refusedReason(s.url, book) && s.text.length >= minChars);
  if (!usable.length) return null;
  return usable.sort(
    (a, b) =>
      bonusOf(b.url, book) - bonusOf(a.url, book) ||
      preferenceOf(a.url, book) - preferenceOf(b.url, book) ||
      b.text.length - a.text.length
  )[0]!;
};

export const runPsych = async (
  run: Run,
  deps: PipelineDeps,
  psychDeps: PsychDeps = {}
): Promise<{ run: Run; script: Script; gate: GateReport }> => {
  const budget = budgetFor(run);
  const say = (stage: string) => (message: string) => {
    (deps.log ?? (() => undefined))(message, stage);
    run.journal({ stage, event: message });
  };
  let stage = 'pipeline';
  const spend = (pence: number) => {
    run.journal({ stage, event: 'spend', pence });
    run.spend(pence, budget);
  };

  const flags = stageFlags(deps.stages);
  const skipped = stagesOff(flags);
  const persona = loadPersona(run.manifest.personaId);
  const format = formatForRun(run);
  const book = psychDeps.curriculum ?? loadCurriculum(persona.id);
  const short = format.kind === 'short';
  const topic = run.manifest.topic;
  run.journal({ stage: 'pipeline', event: 'start', detail: topic });
  assertVoiceUnchanged(persona, deps.tts.name, loadVoiceRegistry());

  // --- 1. What there is to read ----------------------------------------------
  let sources: Source[];
  if (run.hasArtifact('corpus')) {
    sources = run.readArtifact('corpus', corpusArtifactSchema).sources;
    say('corpus')(`reusing ${sources.length} document(s) already fetched`);
  } else {
    stage = 'corpus';
    const queries = (short ? book.shortQueries : book.queries).map((q) =>
      q.replace(/\{topic\}/g, topic)
    );
    say('corpus')(`reading up on "${topic}": ${queries.map((q) => `"${q}"`).join(', ')}`);
    // A few more than are kept, because the refused list takes some out after
    // the fetch and a corpus that arrives one document short is not worth a
    // second search.
    const wanted = short ? 4 : book.sources + 4;
    const corpus = await gatherCorpus(queries, onlyAllowed(deps.search, book), deps.fetchDeps, {
      targetSources: wanted,
      perQuery: 8,
    });

    if (short) {
      const article = chooseArticle(corpus.sources, book, book.shortMinChars);
      if (!article) {
        const reason = `nothing readable and long enough about "${topic}" from a source this channel trusts`;
        run.abandon(reason);
        throw new Error(`abandoned ${run.id}: ${reason}`);
      }
      sources = [article];
      say('corpus')(`writing it from ${article.title} (${article.text.length.toLocaleString()} chars)`);
    } else {
      const { kept, dropped } = chooseSources(corpus.sources, book, book.sources);
      if (kept.length < 3) {
        const reason =
          `only ${kept.length} usable document(s) about "${topic}". ` +
          `An episode needs several, because no one page has both the mechanism and the lived experience`;
        run.abandon(reason);
        throw new Error(`abandoned ${run.id}: ${reason}`);
      }
      sources = kept;
      for (const source of kept) {
        say('corpus')(
          `${new URL(source.url).hostname.replace(/^www\./, '')} (${source.text.length.toLocaleString()} chars)`
        );
      }
      if (dropped.length) say('corpus')(`${dropped.length} other document(s) not used`);
    }

    run.writeArtifact('corpus', {
      sources,
      rejected: corpus.rejected.concat(
        corpus.sources
          .filter((s) => !sources.some((k) => k.id === s.id))
          .map((s) => ({ url: s.url, reason: refusedReason(s.url, book) ?? 'not among the best few' }))
      ),
    });
    run.markComplete('corpus');
  }

  // --- 2. Extract, then fuse into one understanding ---------------------------
  let understanding: Understanding | undefined;
  if (!short) {
    if (run.hasArtifact('reference')) {
      understanding = run.readArtifact('reference', psychRecordSchema).psych.understanding;
      say('reference')('reusing the understanding');
    } else {
      stage = 'reference';
      const queries = book.queries.map((q) => q.replace(/\{topic\}/g, topic));

      // CHECKPOINTED BETWEEN THE TWO CALLS. Extraction is the longest read in
      // the lane, and a run that died at the fusion used to pay for it twice.
      let findings: Findings | null = run.readCheckpoint('reference', findingsSchema);
      if (findings) {
        say('reference')('reusing what was pulled out of the documents');
      } else {
        say('reference')(`pulling the useful parts out of ${sources.length} documents`);
        findings = await extractFindings(
          { topic, sources, queries, charsPerSource: book.extractCharsPerSource },
          deps.writer,
          spend
        );
        run.writeCheckpoint('reference', findings);
        const counted = findings.sources.reduce(
          (n, f) => n + f.mechanism.length + f.corrections.length + f.experiences.length + f.strategies.length,
          0
        );
        say('reference')(`${counted} usable things across ${findings.sources.length} documents`);
      }

      say('reference')('combining them into one understanding');
      understanding = await buildUnderstanding({ topic, findings, sources }, deps.writer, spend);
      say('reference')(`the picture: ${understanding.picture.name}`);
      if (understanding.variants.length) {
        say('reference')(
          `${understanding.variants.length} disagreement(s) between the documents, decided here and ` +
            `kept out of the script. They are in reference.json.`
        );
      }
      if (understanding.careNote) say('reference')('this subject carries a care note');

      run.writeArtifact('reference', {
        psych: {
          topic,
          understanding,
          considered: run.readArtifact('corpus', corpusArtifactSchema).rejected,
        },
      });
      run.markComplete('reference');
      run.clearCheckpoint('reference');
    }
  } else if (!run.hasArtifact('reference')) {
    run.writeArtifact('reference', {
      psych: {
        topic,
        article: { id: sources[0]!.id, title: sources[0]!.title, url: sources[0]!.url },
        considered: [],
      },
    });
    run.markComplete('reference');
  }

  // The ledger and the verification record, so publishing works unchanged.
  if (!run.hasArtifact('claims')) {
    run.writeArtifact('claims', {
      claims: [anchorClaim(sources[0]!, topic, format.beats[0]!.id)],
      unsupported: [],
    });
    run.markComplete('claims');
    run.writeArtifact('verification', {
      verification: {
        results: [],
        blocking: [],
        costPence: 0,
        verifierModel:
          'none: written from one fused understanding, with safety and statistics checked deterministically',
      },
      counterEvidence: [],
    });
    run.markComplete('verification');
  }

  /** What the script is allowed to draw on, and what the checks hold it to. */
  const research = [
    understanding ? renderUnderstanding(understanding) : '',
    sources.map((s) => s.text).join('\n'),
  ].join('\n');

  // --- 3. Write ---------------------------------------------------------------
  let script: Script;
  if (run.hasArtifact('script')) {
    script = run.readArtifact('script', scriptSchema);
    say('script')(`reusing "${script.title}"`);
  } else {
    stage = 'script';
    say('script')(short ? 'writing the short in one go' : 'writing the whole episode in one go');
    const prompt = short
      ? buildShortPrompt({
          persona,
          format,
          topic,
          article: { title: sources[0]!.title, url: sources[0]!.url, text: sources[0]!.text },
          readChars: book.shortReadChars,
        })
      : buildEpisodePrompt({ persona, format, understanding: understanding! });

    const written = await writePsychScript(
      { persona, format, prompt },
      deps.writer,
      (draft) =>
        psychDraftProblems(withOutro(draft, persona, format.kind, run.manifest.topic).beats, {
          topic,
          research,
          kind: short ? 'short' : 'long',
          keywords: understanding?.picture.keywords,
          closingBeatId: format.beats[format.beats.length - 1]!.id,
        }),
      spend,
      say('script'),
      flags.scriptRevisions
    );
    script = withOutro(written.script, persona, format.kind, run.manifest.topic);
    run.writeArtifact('script', script);
    run.markComplete('script');
    say('script')(`"${script.title}", about ${Math.round(estimatedSeconds(script))}s read aloud`);
  }

  const gateFor = (durationS: number, measured: boolean) =>
    psychGate({
      persona,
      format,
      script,
      topic,
      sources,
      research,
      understanding,
      durationS,
      measured,
      trusted: sources.filter((src) => bonusOf(src.url, book) > 0).length,
      priorTexts: deps.priorTexts,
      stagesOff: skipped,
    });

  // --- 4. The approval break --------------------------------------------------
  if (run.awaitingApproval) {
    const held = gateFor(estimatedSeconds(script), false);
    const gate: GateReport = {
      ...held,
      needsHumanReview: true,
      humanReviewReasons: [...held.humanReviewReasons, 'held before the render; approve to voice it.'],
    };
    run.writeArtifact('qa', gate);
    deps.next?.([
      'HELD before the render.',
      `  npm run foundry -- script  --run ${run.id}`,
      `  npm run foundry -- approve --run ${run.id}`,
    ]);
    return { run, script, gate };
  }

  // --- 5. Render --------------------------------------------------------------
  const rendered = run.hasArtifact('render')
    ? run.audioFile(run.readArtifact('render', renderResultSchema).audioFile)
    : null;
  let durationS: number;
  if (rendered) {
    durationS = run.readArtifact('render', renderResultSchema).durationS;
    say('render')(`reusing ${Math.round(durationS)}s of audio`);
  } else {
    stage = 'render';
    const render = await renderScript(
      {
        beats: script.beats,
        voices: Object.fromEntries(persona.hosts.map((h) => [h.id, h.voice])),
        beatPathFor: (name) => run.mediaPath(name),
        outputPath: run.mediaPath('episode.wav'),
        music: musicFor(deps.music, persona, run.manifest.formatId),
        musicSeed: topic,
        musicPhraseFile: deps.musicPhraseFile,
      },
      deps.tts,
      {},
      spend,
      say('render')
    );
    run.writeArtifact('render', render);
    run.markComplete('render');
    durationS = render.durationS;
    say('render')(`${Math.round(durationS)}s`);

    const { registry, recorded } = recordVoices(persona, deps.tts.name, run.id, loadVoiceRegistry());
    if (recorded.length) {
      saveVoiceRegistry(registry);
      for (const r of recorded) {
        say('voice')(`${persona.name} speaks as "${r.voiceId}" on ${deps.tts.name} from now on`);
      }
    }
  }

  // --- 6. Gate ----------------------------------------------------------------
  const gate = gateFor(durationS, true);
  run.writeArtifact('qa', gate);
  run.markComplete('qa');
  run.journal({
    stage: 'pipeline',
    event: gate.passed ? 'done' : 'gate-failed',
    detail: script.title,
    pence: run.manifest.spentPence,
  });
  return { run, script, gate };
};

/** The gate again from what is on disk, for `gate --run`, the studio and publish. */
export const regatePsych = (run: Run, script: Script): GateReport | null => {
  try {
    const persona = loadPersona(run.manifest.personaId);
    const format = loadFormat(run.manifest.formatId);
    const sources = run.readArtifact('corpus', corpusArtifactSchema).sources;
    if (!sources.length) return null;
    const record = run.readArtifact('reference', psychRecordSchema).psych;
    const render = run.hasArtifact('render') ? run.readArtifact('render', renderResultSchema) : null;
    const research = [
      record.understanding ? renderUnderstanding(record.understanding) : '',
      sources.map((s) => s.text).join('\n'),
    ].join('\n');

    return psychGate({
      persona,
      format,
      script,
      topic: record.topic,
      sources,
      research,
      understanding: record.understanding,
      durationS: render?.durationS ?? estimatedSeconds(script),
      measured: !!render,
      trusted: sources.filter((src) => bonusOf(src.url, loadCurriculum(persona.id)) > 0).length,
      stagesOff: stagesOff(stageFlags(run.manifest.stages as never)),
    });
  } catch {
    return null;
  }
};
