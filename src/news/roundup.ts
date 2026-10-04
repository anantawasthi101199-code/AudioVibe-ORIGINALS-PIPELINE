/**
 * The rapid-fire roundup: the day's top story from each region on the desk,
 * one article each, read out one after another (owner, 2026-10-05).
 *
 *   [free] WIRE      one Brave News search per region, last 24 hours
 *   [free] STORY     the most-carried story per region, never one already
 *                    picked for another region or reported this week
 *   [free] ARTICLE   the same rules as a single report: desk outlet, fetches,
 *                    full-length, fresh by its own date
 *   [paid] WRITE     one call over all of them, each article cut to its top
 *
 * Everything else is the single report's: the same outlets, the same free
 * checks (every figure in an article, every outlet named), the same gate.
 */
import { Persona } from '../canon/schema';
import { FetchDeps } from '../evidence/fetch';
import { Source } from '../evidence/source';
import { EpisodeFormat } from '../formats/schema';
import { signoffFor } from '../script/storyScript';
import { wordsForBeat } from '../script/write';
import { Desk } from './desk';
import { NEWS_INSTRUCTION, spokenDate, ukClock } from './newsScript';
import { AlreadyCovered, clusterStories, headlineTokens, normaliseUrl, pickArticle } from './pick';
import { NewsSearch, screenWire, sweepWire } from './wire';

/**
 * How much of each article the writer reads. A roundup item is three or four
 * sentences, which the top of an article always holds, and five articles read
 * in full would cost more than the rest of the report put together.
 */
export const ROUNDUP_ARTICLE_CHARS = 4_000;

/** Fewer than this and it is not a roundup, so the run stops before paying. */
export const MIN_ROUNDUP_STORIES = 3;

export interface RoundupItem {
  region: string;
  outlet: string;
  publishedAt: string;
  headline: string;
  url: string;
}

export const gatherRoundup = async (
  desk: Desk,
  wire: NewsSearch,
  fetchDeps: FetchDeps,
  now: Date,
  covered: AlreadyCovered,
  say: (message: string) => void,
  sleep?: (ms: number) => Promise<void>
): Promise<Array<{ item: RoundupItem; source: Source }>> => {
  const picked: Array<{ item: RoundupItem; source: Source }> = [];
  // What is already in the roundup counts as covered, so the US and the world
  // searches cannot both lead with the same summit.
  const seen: AlreadyCovered = { urls: new Set(covered.urls), titles: [...covered.titles] };

  for (const region of desk.roundup?.regions ?? []) {
    const raw = await sweepWire(region.queries, desk, wire, sleep, say);
    const { kept } = screenWire(raw, desk);
    // ABOUT THE REGION. The first live roundup filled India's slot with a
    // Ukraine story an "India" search returned.
    const about = region.match.length
      ? new RegExp(`\\b(${region.match.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z])`)
      : null;
    const stories = clusterStories(about ? kept.filter((k) => about.test(k.title)) : kept);
    if (!stories.length) {
      say(`${region.name}: nothing from a desk outlet in the last 24 hours`);
      continue;
    }
    const got = await pickArticle(stories, desk, fetchDeps, now, seen, say);
    if (!got) {
      say(`${region.name}: no fresh, full-length article that fetched`);
      continue;
    }
    seen.urls.add(normaliseUrl(got.source.url));
    seen.titles.push(headlineTokens(got.item.title));
    picked.push({
      source: got.source,
      item: {
        region: region.name,
        outlet: got.item.outlet,
        publishedAt: got.publishedAt,
        headline: got.item.title,
        url: got.source.url,
      },
    });
    say(`${region.name}: ${got.item.outlet}, "${got.item.title}"`);
  }
  return picked;
};

export const buildRoundupPrompt = (input: {
  persona: Persona;
  format: EpisodeFormat;
  beat: string;
  now: Date;
  stories: Array<{ item: RoundupItem; text: string }>;
}): string => {
  const host = input.persona.hosts[0]!;
  const speaker = host.id;
  const signoff = signoffFor(input.persona, 'short', input.stories[0]!.item.url);
  const ceiling = input.format.beats.reduce((n, b) => n + wordsForBeat(b).max, 0);

  const parts = input.format.beats
    .map((beat) => {
      const { min, max } = wordsForBeat(beat);
      return [
        `--- ${beat.id} ---`,
        `MUST: ${beat.function.trim().replace(/\s+/g, ' ')}`,
        ...beat.constraints.map((c) => `- ${c.trim().replace(/\s+/g, ' ')}`),
        `LENGTH: ${min} to ${max} words.`,
      ].join('\n');
    })
    .join('\n\n');

  // The single report's rules on facts, fairness and sound, with its SHAPE
  // replaced: that one explains one story, this one moves through several.
  const rules = NEWS_INSTRUCTION.replace(/\{HOST\}/g, host.name)
    .replace(/\{SHOW\}/g, input.persona.name)
    .replace(/\{OUTLET\}/g, 'the outlet named for each story')
    .replace(/THE SHAPE[\s\S]*?(?=THE FACTS COME FROM)/, '')
    .replace('THE FACTS COME FROM ONE PLACE: THE ARTICLE BELOW.', 'THE FACTS COME FROM THE ARTICLES BELOW, each story from its own article only.')
    .replace('REPORT ONLY THE STORY IN THE HEADLINE.', 'REPORT ONLY THE STORY IN EACH HEADLINE.')
    .replace('NAME THE SOURCE ON AIR, once, early:', 'NAME EACH STORY\'S SOURCE ON AIR, once, inside that story:');

  return [
    'THIS IS A RAPID-FIRE ROUNDUP, not one story explained. Several stories, one after another,',
    'quick and clear, each one complete in three or four sentences.',
    '',
    rules,
    '',
    `TODAY IS ${spokenDate(input.now)}, UK time.`,
    `THIS CHANNEL'S BEAT: ${input.beat}`,
    signoff
      ? `HOW THIS CHANNEL SIGNS OFF, at the very end, in your own words:\n  ${signoff}`
      : `The last part asks the listener to follow for more, then goodbye.`,
    '',
    `Return JSON only: {"title": "...", "description": "...", "beats": [{"beatId": "...", ` +
      `"turns": [{"speaker": "${speaker}", "text": "..."}]}]}`,
    `THE ONLY SPEAKER ID IS "${speaker}". In "headlines", one turn per story, in the order below.`,
    `THE TITLE names the places and says it is today's top news, about eight words, no date.`,
    '',
    `THE WHOLE ROUNDUP IS AT MOST ${ceiling} WORDS, goodbye included. Over that it runs past three ` +
      'minutes and cannot be used. Shorten every story evenly rather than dropping one.',
    '',
    'THE PARTS, in order:',
    '',
    parts,
    '',
    ...input.stories.flatMap(({ item, text }, i) => [
      '=========================================================',
      `STORY ${i + 1} OF ${input.stories.length}: ${item.region.toUpperCase()}, from ${item.outlet}, ` +
        `reported ${spokenDate(new Date(item.publishedAt))} at ${ukClock(new Date(item.publishedAt))} UK time`,
      '=========================================================',
      `HEADLINE: ${item.headline}`,
      '',
      text.slice(0, ROUNDUP_ARTICLE_CHARS),
      '',
    ]),
  ].join('\n');
};
