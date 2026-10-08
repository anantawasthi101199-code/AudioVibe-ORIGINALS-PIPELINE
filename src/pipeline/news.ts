/**
 * The news lane: today's most important story on a beat, reported from one
 * dependable article, under three minutes.
 *
 *   [free] WIRE      Brave News, last 24 hours, the desk's queries
 *   [free] SCREEN    desk outlets only; no live blogs, opinion or off-beat
 *   [free] STORY     cluster headlines; most outlets carrying it wins
 *   [free] ARTICLE   the best outlet's page that fetches, is full-length and
 *                    is fresh by its own date. ONE source, nothing blended.
 *   [paid] WRITE     one call: headline, lede, report, close and goodbye  ~2-4p
 *   [free] CHECK     every figure is in the article, source named on air,
 *                    outro asks for the follow, under three minutes
 *   [paid] RENDER    OpenAI voice                                         ~2-3p
 *   [free] GATE      and again at publish, which refuses a stale report
 *
 * WHY ITS OWN PIPELINE RATHER THAN A THIRD BRANCH IN runEpisode. The story
 * lanes open with a model writing a research brief and search queries, then a
 * model choosing documents. News inverts both: the queries are the desk's, fixed
 * every morning, and the choice of story is arithmetic over what trusted outlets
 * are carrying. Sharing the research half would mean sharing nothing but an
 * `if`. Everything AFTER the research is shared: the run store, the renderer,
 * the voice registry and the gate, so publish, the studio, `resume` and
 * `script --run` treat a news run like any other.
 *
 * RESUMABLE LIKE EVERYTHING ELSE. The article is the corpus artifact, so a
 * resumed run reports the story it started with rather than whatever is top of
 * the wire an hour later.
 */
import { musicFor } from '../render/musicFor';
import { z } from 'zod';
import { loadPersona } from '../canon/load';
import {
  assertVoiceUnchanged,
  loadVoiceRegistry,
  recordVoices,
  saveVoiceRegistry,
} from '../canon/voiceRegistry';
import { budgetFor, targetFor } from './budget';
import { stageFlags, stagesOff } from '../config/stages';
import { claimSchema } from '../evidence/claim';
import { retrievalKeys } from '../evidence/providers';
import { Source, sourceSchema } from '../evidence/source';
import { loadFormat } from '../formats/load';
import { GateReport } from '../qa/gate';
import { renderResultSchema, renderScript } from '../render/assemble';
import { Run } from '../run/store';
import { Script, scriptSchema } from '../script/write';
import { draftProblems, estimatedSeconds, namesSource, newsGate } from '../news/check';
import { Desk, ROUNDUP_FORMAT, loadDesk } from '../news/desk';
import { MIN_ROUNDUP_STORIES, RoundupItem, buildRoundupPrompt, gatherRoundup } from '../news/roundup';
import { countriesByName } from '../news/countries';
import { writeNewsScript } from '../news/newsScript';
import {
  AlreadyCovered,
  clusterStories,
  headlineTokens,
  normaliseUrl,
  pickArticle,
} from '../news/pick';
import { BraveNews, NewsSearch, screenWire, sweepWire } from '../news/wire';
import type { PipelineDeps } from './episode';
import { withOutro } from '../script/outro';

export interface NewsDeps {
  /** The news index. Built from BRAVE_SEARCH_API_KEY when absent. */
  wire?: NewsSearch;
  /** Wall clock, for freshness. Injected so tests are not flaky at midnight. */
  now?: () => Date;
  /** Spacing between wire queries. Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  desk?: Desk;
}

/**
 * What the run recorded about its article, beyond the source itself. Stored on
 * the `reference` artifact, which is otherwise unused on this lane, so the
 * record survives alongside the story lanes' shape without a new stage.
 */
export const newsRecordSchema = z.object({
  news: z.object({
    outlet: z.string(),
    publishedAt: z.string(),
    headline: z.string(),
    url: z.string(),
    /** Other desk outlets carrying the same story. Importance, never content. */
    alsoCarrying: z.array(z.string()),
    queries: z.array(z.string()),
  }),
});

export type NewsRecord = z.infer<typeof newsRecordSchema>['news'];

/** A roundup's stories, kept beside `news` (which holds the first, for old readers). */
const roundupRecordSchema = z.object({
  roundup: z
    .array(
      z.object({
        region: z.string(),
        outlet: z.string(),
        publishedAt: z.string(),
        headline: z.string(),
        url: z.string(),
      })
    )
    .default([]),
});

/** A roundup reads several articles; the checks treat them as one text. */
const combined = (sources: Source[]): Source => ({
  ...sources[0]!,
  text: sources.map((s) => s.text).join('\n\n'),
});

const outletsOf = (items: RoundupItem[]): string[] => [...new Set(items.map((i) => i.outlet))];

/** The oldest article sets how stale the whole roundup is. */
const oldest = (items: RoundupItem[]): string =>
  [...items].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))[0]!.publishedAt;

const corpusArtifactSchema = z.object({
  sources: z.array(sourceSchema),
  rejected: z.array(z.object({ url: z.string(), reason: z.string() })),
});

/** How far back "already reported" looks. */
export const COVERED_DAYS = 7;

/** What this channel has reported recently, from its own runs on disk. */
export const coveredBy = (personaId: string, now: Date): AlreadyCovered => {
  const covered: AlreadyCovered = { urls: new Set(), titles: [] };
  for (const id of Run.list()) {
    if (!id.startsWith(`${personaId}/`)) continue;
    try {
      const run = Run.open(id);
      if (Date.parse(run.manifest.createdAt) < now.getTime() - COVERED_DAYS * 86_400_000) continue;
      // VOICED, OR IT REPORTED NOTHING. A held run that never got audio is a
      // draft, and counting it made the first real report skip the day's top
      // story because two unvoiced test scripts had looked at it.
      if (!run.hasArtifact('reference') || !run.isComplete('render')) continue;
      const { news } = run.readArtifact('reference', newsRecordSchema);
      covered.urls.add(normaliseUrl(news.url));
      covered.titles.push(headlineTokens(news.headline));
      for (const item of run.readArtifact('reference', roundupRecordSchema).roundup) {
        covered.urls.add(normaliseUrl(item.url));
        covered.titles.push(headlineTokens(item.headline));
      }
    } catch {
      // A half-made or foreign run says nothing about what was reported.
    }
  }
  return covered;
};

/** The one claim the Sources sheet is built from. See `anchorClaim`. */
const firstSentence = (text: string): string => {
  const sentences = text.match(/[^.!?\n]{60,400}[.!?]/g) ?? [];
  return (sentences[0] ?? text.slice(0, 300)).trim();
};

/**
 * The run's claim ledger, which on this lane is one entry: "this report rests on
 * this article", bound to a verbatim sentence of it.
 *
 * WHY WRITE A LEDGER AT ALL. Publishing builds the listener-facing Sources
 * sheet from claims, listing only sources a claim rests on. A report with an
 * empty ledger would publish with an empty Sources sheet, which says the
 * opposite of the truth. `unverified`, because nothing checked it semantically,
 * and saying so is the point of the field.
 */
const anchorClaim = (source: Source, headline: string, beatId: string, n = 1) =>
  claimSchema.parse({
    id: `news-${n}`,
    text: headline,
    type: 'attribution',
    beatId,
    sourceId: source.id,
    quote: firstSentence(source.text),
    status: 'unverified',
  });

export const runNews = async (
  run: Run,
  deps: PipelineDeps,
  newsDeps: NewsDeps = {}
): Promise<{ run: Run; script: Script; gate: GateReport }> => {
  const budget = budgetFor(run);
  const now = newsDeps.now ?? (() => new Date());
  const say = (stage: string) => (message: string) => {
    (deps.log ?? (() => undefined))(message, stage);
    run.journal({ stage, event: message });
  };
  let stage = 'pipeline';
  const spend = (pence: number) => {
    run.journal({ stage, event: 'spend', pence });
    run.spend(pence, budget, targetFor(run));
  };

  const flags = stageFlags(deps.stages);
  const skipped = stagesOff(flags);

  const persona = loadPersona(run.manifest.personaId);
  const format = loadFormat(run.manifest.formatId);
  const desk = newsDeps.desk ?? loadDesk(persona.id);
  run.journal({ stage: 'pipeline', event: 'start', detail: run.manifest.topic });

  // BEFORE ANYTHING IS SPENT, as on every other lane.
  assertVoiceUnchanged(persona, deps.tts.name, loadVoiceRegistry());

  // --- 1. The wire, the story and the one article ---------------------------
  // OR THE ROUNDUP: one story per region, one article each. See news/roundup.ts.
  const roundup = format.id === ROUNDUP_FORMAT;
  let source: Source;
  let record: NewsRecord;
  let items: RoundupItem[] = [];
  let sources: Source[] = [];
  if (roundup) {
    if (run.hasArtifact('corpus') && run.hasArtifact('reference')) {
      sources = run.readArtifact('corpus', corpusArtifactSchema).sources;
      items = run.readArtifact('reference', roundupRecordSchema).roundup;
      say('wire')(`reusing ${items.length} stories`);
    } else {
      stage = 'wire';
      const key = retrievalKeys().brave;
      const wire = newsDeps.wire ?? (key ? new BraveNews(key) : null);
      if (!wire) throw new Error('the news lane needs BRAVE_SEARCH_API_KEY in .env');
      // THE COUNTRIES CHOSEN FOR THIS RUN, or the desk's own regions.
      const chosen = run.manifest.countries?.length ? countriesByName(run.manifest.countries) : null;
      const regions = chosen ?? desk.roundup?.regions;
      if (!regions?.length) throw new Error(`${persona.name}'s desk has no roundup regions`);
      // Three chosen countries make a roundup of whichever of them had news;
      // the desk's five need three, as before.
      const needed = chosen ? Math.min(2, chosen.length) : MIN_ROUNDUP_STORIES;
      say('wire')(`rapid fire: the top story from ${regions.map((r) => r.name).join(', ')}`);
      const picked = await gatherRoundup(
        desk,
        regions,
        wire,
        deps.fetchDeps,
        now(),
        coveredBy(persona.id, now()),
        say('wire'),
        newsDeps.sleep
      );
      if (picked.length < needed) {
        const reason =
          `only ${picked.length} region(s) had a fresh story from a desk outlet; ` +
          `this roundup needs ${needed}`;
        run.abandon(reason);
        throw new Error(`abandoned ${run.id}: ${reason}`);
      }
      sources = picked.map((x) => x.source);
      items = picked.map((x) => x.item);
      run.writeArtifact('corpus', { sources, rejected: [] });
      run.markComplete('corpus');
      run.writeArtifact('reference', {
        news: { ...items[0]!, alsoCarrying: [], queries: regions.flatMap((r) => r.queries) },
        roundup: items,
      });
      run.markComplete('reference');
      run.writeArtifact('claims', {
        claims: sources.map((s, i) => anchorClaim(s, items[i]!.headline, format.beats[1]!.id, i + 1)),
        unsupported: [],
      });
      run.markComplete('claims');
      run.writeArtifact('verification', {
        verification: {
          results: [],
          blocking: [],
          costPence: 0,
          verifierModel: 'none: each story from one named source, figures checked deterministically',
        },
        counterEvidence: [],
      });
      run.markComplete('verification');
    }
    source = combined(sources);
    record = { ...items[0]!, publishedAt: oldest(items), alsoCarrying: [], queries: [] };
  } else if (run.hasArtifact('corpus') && run.hasArtifact('reference')) {
    source = run.readArtifact('corpus', corpusArtifactSchema).sources[0]!;
    record = run.readArtifact('reference', newsRecordSchema).news;
    say('wire')(`reusing ${record.outlet}: "${record.headline}"`);
  } else {
    stage = 'wire';
    const wire =
      newsDeps.wire ??
      (() => {
        const key = retrievalKeys().brave;
        if (!key) throw new Error('the news lane needs BRAVE_SEARCH_API_KEY in .env');
        return new BraveNews(key);
      })();

    // THE BEAT, OR ONE STORY. A topic equal to the desk's beat (the default)
    // means "today's most important story on this beat", and runs the desk's
    // sweep. Anything else is a specific story somebody asked for.
    const asked = run.manifest.topic.trim();
    const queries =
      asked.toLowerCase() === desk.beat.toLowerCase() ? desk.queries : [asked];

    say('wire')(`checking the last 24 hours: ${queries.map((q) => `"${q}"`).join(', ')}`);
    const raw = await sweepWire(queries, desk, wire, newsDeps.sleep, say('wire'));
    const { kept, rejected } = screenWire(raw, desk);
    say('wire')(`${raw.length} headlines, ${kept.length} from desk outlets and on the beat`);

    const stories = clusterStories(kept);
    if (!stories.length) {
      const reason = `nothing on the wire from a desk outlet in the last 24 hours for ${queries.join(', ')}`;
      run.abandon(reason);
      throw new Error(`abandoned ${run.id}: ${reason}`);
    }
    for (const s of stories.slice(0, 3)) {
      say('story')(`${s.outlets} outlet(s): "${s.items[0]!.title}"`);
    }

    stage = 'article';
    const picked = await pickArticle(
      stories,
      desk,
      deps.fetchDeps,
      now(),
      coveredBy(persona.id, now()),
      say('article')
    );
    if (!picked) {
      const reason =
        'no story had a fresh, full-length article from a desk outlet that could be fetched';
      run.abandon(reason);
      throw new Error(`abandoned ${run.id}: ${reason}`);
    }

    source = picked.source;
    record = {
      outlet: picked.item.outlet,
      publishedAt: picked.publishedAt,
      headline: picked.item.title,
      url: source.url,
      alsoCarrying: [...new Set(picked.story.items.map((i) => i.outlet))].filter(
        (o) => o !== picked.item.outlet
      ),
      queries,
    };

    run.writeArtifact('corpus', {
      sources: [source],
      rejected: [...picked.rejected, ...rejected].slice(0, 60),
    });
    run.markComplete('corpus');
    run.writeArtifact('reference', { news: record });
    run.markComplete('reference');
    // The ledger publishing reads. See anchorClaim.
    run.writeArtifact('claims', {
      claims: [anchorClaim(source, record.headline, format.beats[0]!.id)],
      unsupported: [],
    });
    run.markComplete('claims');
    run.writeArtifact('verification', {
      verification: {
        results: [],
        blocking: [],
        costPence: 0,
        verifierModel: 'none: one named source, figures checked against it deterministically',
      },
      counterEvidence: [],
    });
    run.markComplete('verification');

    say('article')(
      `reporting from ${record.outlet}, published ${record.publishedAt.slice(0, 16).replace('T', ' ')} UTC, ` +
        `${source.text.length.toLocaleString()} chars` +
        (record.alsoCarrying.length ? `. Also carried by ${record.alsoCarrying.join(', ')}` : '')
    );
  }

  // --- 2. Write ---------------------------------------------------------------
  const closingBeatId = format.beats[format.beats.length - 1]!.id;
  let script: Script;
  if (run.hasArtifact('script')) {
    script = run.readArtifact('script', scriptSchema);
    say('script')(`reusing "${script.title}"`);
  } else {
    stage = 'script';
    say('script')(
      roundup ? `writing the rapid fire from ${items.length} stories` : `writing the report from ${record.outlet}`
    );
    const written = await writeNewsScript(
      {
        persona,
        format,
        prompt: roundup
          ? buildRoundupPrompt({
              persona,
              format,
              beat: desk.beat,
              now: now(),
              stories: items.map((item, i) => ({ item, text: sources[i]!.text })),
            })
          : undefined,
        article: {
          title: record.headline,
          url: source.url,
          text: source.text,
          outlet: record.outlet,
          publishedAt: record.publishedAt,
        },
        beat: desk.beat,
        now: now(),
      },
      deps.writer,
      (draft) => [
        ...draftProblems(withOutro(draft, persona, format.kind, run.manifest.topic).beats, {
          article: source.text,
          outlet: record.outlet,
          now: now(),
          closingBeatId,
        }),
        // A roundup names every outlet it reports from, not only the first.
        ...outletsOf(items)
          .filter((o) => o !== record.outlet)
          .filter((o) => !namesSource(draft.beats.flatMap((b) => b.turns.map((t) => t.text)).join(' '), o))
          .map((o) => `the report never says a story comes from ${o}`),
      ],
      spend,
      say('script'),
      flags.scriptRevisions
    );
    script = withOutro(written.script, persona, format.kind, run.manifest.topic);
    run.writeArtifact('script', script);
    run.markComplete('script');
    say('script')(`"${script.title}", about ${Math.round(estimatedSeconds(script))}s read aloud`);
  }

  // Same-channel reports on an ongoing story share vocabulary by design; the
  // "already reported" rule is what stops a true repeat. See pick.ts.
  const priorTexts = (deps.priorTexts ?? []).filter((p) => !p.label.startsWith(`${persona.id}/`));
  const gateFor = (durationS: number, measured: boolean) =>
    newsGate({
      persona,
      format,
      desk,
      script,
      source,
      outlet: record.outlet,
      outlets: roundup ? outletsOf(items) : undefined,
      publishedAt: record.publishedAt,
      durationS,
      measured,
      now: now(),
      priorTexts,
      stagesOff: skipped,
    });

  // --- 3. The approval break, when the run asked for one ----------------------
  if (run.awaitingApproval) {
    const held = gateFor(estimatedSeconds(script), false);
    const gate: GateReport = {
      ...held,
      needsHumanReview: true,
      humanReviewReasons: [
        ...held.humanReviewReasons,
        'held before the render. News goes stale: approve it today or remake it.',
      ],
    };
    run.writeArtifact('qa', gate);
    deps.next?.([
      'This report is HELD before the render.',
      `  npm run foundry -- script  --run ${run.id}`,
      `  npm run foundry -- approve --run ${run.id}`,
    ]);
    return { run, script, gate };
  }

  // --- 4. Render --------------------------------------------------------------
  const renderedAudio = run.hasArtifact('render')
    ? run.audioFile(run.readArtifact('render', renderResultSchema).audioFile)
    : null;
  let durationS: number;
  if (renderedAudio) {
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
        // The run's choice wins; otherwise the desk or the channel opts in.
        music: deps.music ?? (desk.music || musicFor(undefined, persona, run.manifest.formatId)),
        musicSeed: run.manifest.topic,
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

  // --- 5. Gate ----------------------------------------------------------------
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

/**
 * The gate again from what is on disk, for `gate --run`, the studio and publish.
 *
 * THIS IS WHERE "STALE" BITES. The clock is read now, not when the run was
 * made, so a report that sat unpublished past the desk's window is refused at
 * the moment somebody tries to send it out.
 */
export const regateNews = (run: Run, script: Script, now: Date = new Date()): GateReport | null => {
  try {
    const persona = loadPersona(run.manifest.personaId);
    const format = loadFormat(run.manifest.formatId);
    const desk = loadDesk(persona.id);
    const sources = run.readArtifact('corpus', corpusArtifactSchema).sources;
    if (!sources.length) return null;
    const { news } = run.readArtifact('reference', newsRecordSchema);
    const items = run.readArtifact('reference', roundupRecordSchema).roundup;
    const source = items.length ? combined(sources) : sources[0]!;
    const render = run.hasArtifact('render') ? run.readArtifact('render', renderResultSchema) : null;

    return newsGate({
      persona,
      format,
      desk,
      script,
      source,
      outlet: news.outlet,
      outlets: items.length ? outletsOf(items) : undefined,
      publishedAt: items.length ? oldest(items) : news.publishedAt,
      durationS: render?.durationS ?? estimatedSeconds(script),
      measured: !!render,
      now,
      stagesOff: stagesOff(stageFlags(run.manifest.stages as never)),
    });
  } catch {
    // Absent rather than passing, exactly as the shared regate does.
    return null;
  }
};
