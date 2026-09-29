/**
 * Which story, and which ONE article it is told from.
 *
 * NO MODEL DECIDES WHAT THE NEWS IS. The story is chosen the way an aggregator
 * chooses its top story: group the morning's headlines into stories, and the
 * story the most trusted outlets are independently carrying is the one that
 * matters today. That is free, it is repeatable, and it cannot be talked into a
 * story because the story is interesting to a language model.
 *
 * THEN ONE ARTICLE. Within the chosen story, the desk's most preferred outlet
 * whose page actually fetches is the source, and it is the only source. Several
 * outlets carrying a story is used as a signal of importance and nothing else:
 * their text is never read, never blended, never quoted.
 *
 * FRESHNESS IS PROVED, NOT ASSUMED. The article's own publication time is read
 * from the page, falling back to when Brave first indexed it. An article with
 * neither cannot be shown to be news and is not used.
 */
import { FetchDeps, fetchSource, SourceFetchError } from '../evidence/fetch';
import { Source } from '../evidence/source';
import { Desk } from './desk';
import { ageHours, parseWhen, WireItem, WireRejection } from './wire';

/** Below this, a fetched page is a stub or a teaser, not a report. */
export const MIN_ARTICLE_CHARS = 1_500;

/** Fetches tried before giving up on a story and moving to the next one. */
export const FETCHES_PER_STORY = 4;

/** Stories tried before the run is abandoned. */
export const STORIES_TRIED = 3;

const STOPWORDS = new Set(
  (
    'the a an and or but of to in on at for from by with as is are was were be been has have had ' +
    'will would could should may might can after before over under into about amid against says said ' +
    'say new its it this that these those their his her they them he she we you not no than more most ' +
    'up down out off what why how who when where which while us uk live latest news report reports ' +
    'first two three one year years day days week weeks'
  ).split(' ')
);

/** The words in a headline that carry the story. */
export const headlineTokens = (title: string): Set<string> =>
  new Set(
    title
      .toLowerCase()
      .replace(/['’]s\b/g, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  );

/**
 * How much two headlines are about the same thing.
 *
 * Overlap over the SHORTER headline rather than Jaccard, because outlets title
 * one story at very different lengths and a terse headline fully contained in a
 * long one is the same story.
 */
export const headlineOverlap = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / Math.min(a.size, b.size);
};

/** Two shared words is the floor: "Iran talks" and "Iran election" share one. */
export const SAME_STORY_OVERLAP = 0.5;
export const SAME_STORY_MIN_SHARED = 2;

const sameStory = (a: Set<string>, b: Set<string>): boolean => {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared >= SAME_STORY_MIN_SHARED && headlineOverlap(a, b) >= SAME_STORY_OVERLAP;
};

export interface Story {
  items: WireItem[];
  /** Distinct desk outlets carrying it. The importance signal. */
  outlets: number;
  newest: Date | null;
}

/**
 * Group headlines into stories, most important first.
 *
 * Single-link: an item joins the first story any member of which it matches.
 * Ranked by outlet count, then by recency, then by the best outlet in it.
 */
export const clusterStories = (items: WireItem[]): Story[] => {
  const groups: Array<{ items: WireItem[]; tokens: Set<string>[] }> = [];

  for (const item of items) {
    const tokens = headlineTokens(item.title);
    const home = groups.find((g) => g.tokens.some((t) => sameStory(t, tokens)));
    if (home) {
      home.items.push(item);
      home.tokens.push(tokens);
    } else {
      groups.push({ items: [item], tokens: [tokens] });
    }
  }

  const stories: Story[] = groups.map((g) => {
    const dates = g.items.map((i) => parseWhen(i.seenAt)).filter((d): d is Date => !!d);
    return {
      items: g.items,
      outlets: new Set(g.items.map((i) => i.outlet)).size,
      newest: dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null,
    };
  });

  const best = (s: Story) => Math.min(...s.items.map((i) => i.rank));
  return stories.sort(
    (a, b) =>
      b.outlets - a.outlets ||
      (b.newest?.getTime() ?? 0) - (a.newest?.getTime() ?? 0) ||
      best(a) - best(b)
  );
};

/** Headlines this channel has already reported, for not reporting them twice. */
export interface AlreadyCovered {
  urls: Set<string>;
  titles: Set<string>[];
}

/**
 * The same article, or a headline so close it is the same development.
 *
 * DELIBERATELY STRICTER THAN "SAME STORY". An ongoing story - a war, a trial,
 * an election count - has a new development every day and each one is news. A
 * higher bar than clustering uses means the channel follows a story rather than
 * reporting one article of it twice.
 */
export const REPEAT_OVERLAP = 0.75;

export const alreadyReported = (story: Story, covered: AlreadyCovered): boolean =>
  story.items.some(
    (i) =>
      covered.urls.has(normaliseUrl(i.url)) ||
      covered.titles.some((t) => headlineOverlap(t, headlineTokens(i.title)) >= REPEAT_OVERLAP)
  );

export const normaliseUrl = (url: string): string =>
  url.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/i, '').toLowerCase();

export interface Picked {
  source: Source;
  item: WireItem;
  story: Story;
  /** When the article says it was published, else when Brave indexed it. */
  publishedAt: string;
  /** What was tried and why it was not used, for the run's record. */
  rejected: WireRejection[];
}

/**
 * The first fetchable, fresh, full-length article of the most important story.
 *
 * Returns null when nothing qualifies. The caller abandons the run, because a
 * news channel that reports something stale or thin to fill a slot is worse
 * than a channel that stays quiet for a morning.
 */
export const pickArticle = async (
  stories: Story[],
  desk: Desk,
  fetchDeps: FetchDeps,
  now: Date,
  covered: AlreadyCovered = { urls: new Set(), titles: [] },
  onProgress?: (message: string) => void
): Promise<Picked | null> => {
  const rejected: WireRejection[] = [];
  let tried = 0;

  for (const story of stories) {
    if (tried >= STORIES_TRIED) break;
    if (alreadyReported(story, covered)) {
      onProgress?.(`already reported: "${story.items[0]!.title}"`);
      continue;
    }
    tried += 1;

    const order = [...story.items].sort(
      (a, b) =>
        a.rank - b.rank ||
        (parseWhen(b.seenAt)?.getTime() ?? 0) - (parseWhen(a.seenAt)?.getTime() ?? 0)
    );

    for (const item of order.slice(0, FETCHES_PER_STORY)) {
      let source: Source;
      try {
        // T2 BY DECLARATION. Every desk outlet is named reporting with editorial
        // accountability, which is what T2 means, whatever the generic
        // host table in evidence/source.ts happens to know about it.
        source = await fetchSource(item.url, fetchDeps, { tier: 'T2' });
      } catch (err) {
        const reason =
          err instanceof SourceFetchError ? err.message : `fetch failed: ${(err as Error).message}`;
        rejected.push({ url: item.url, reason });
        onProgress?.(`${item.outlet} did not fetch: ${reason}`);
        continue;
      }

      if (source.text.length < MIN_ARTICLE_CHARS) {
        rejected.push({
          url: item.url,
          reason: `only ${source.text.length} characters, which is a teaser or a paywall`,
        });
        onProgress?.(`${item.outlet} returned only ${source.text.length} characters`);
        continue;
      }

      // THE PAGE'S OWN DATE WINS over Brave's, because Brave dates by when it
      // found the page and an old article re-indexed today looks brand new.
      const when = parseWhen(source.publishedAt) ?? parseWhen(item.seenAt);
      if (!when) {
        rejected.push({ url: item.url, reason: 'no publication time, so it cannot be shown to be news' });
        continue;
      }
      const age = ageHours(when, now);
      if (age > desk.maxAgeHours) {
        rejected.push({
          url: item.url,
          reason: `published ${Math.round(age)} hours ago, past the desk's ${desk.maxAgeHours}`,
        });
        onProgress?.(`${item.outlet}'s article is ${Math.round(age)} hours old, too old`);
        continue;
      }

      return { source, item, story, publishedAt: when.toISOString(), rejected };
    }
  }

  return null;
};
