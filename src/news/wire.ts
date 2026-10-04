/**
 * The wire: what the news desk hears about, from Brave's news index.
 *
 * WHY THE NEWS ENDPOINT AND NOT THE WEB SEARCH THE REST OF THE FOUNDRY USES.
 * Web search ranks by relevance over all time, so "ceasefire talks" returns the
 * best-linked page about ceasefire talks, which is usually months old. The news
 * endpoint indexes articles as they are published and takes a `freshness`
 * window, so "the last twenty-four hours" is a query parameter rather than a
 * hope. Measured 2026-09-29: every result for a live query came back dated the
 * previous day or later.
 *
 * WHAT IS THROWN AWAY BEFORE ANYTHING IS FETCHED, and why each one:
 *
 *   not a desk outlet    the "one dependable source" rule. See news/desk.ts.
 *   a live blog          a rolling page carries a dozen stories under one
 *                        headline, updated all day. It is not one article and
 *                        it cannot be one source. The first live probe of this
 *                        endpoint returned three of them in the top four.
 *   opinion / analysis   a report is built on reporting. A columnist's view
 *                        read out by a newsreader becomes the channel's view.
 *   an excluded word     the desk's own "not our beat" list.
 *
 * Like every other search in this repo: the search engine proposes URLs and the
 * fetcher proves they exist. A model never originates an address.
 */
import { z } from 'zod';
import { HttpGetJson, nodeGetJson } from '../evidence/search';
import { Desk, outletFor } from './desk';

export interface WireItem {
  url: string;
  title: string;
  description: string;
  /** When Brave first saw it, as an ISO string. Treated as UTC. */
  seenAt?: string;
  /** How the outlet is said on air. Only set for desk outlets. */
  outlet: string;
  /** Position on the desk's outlet list. Lower is preferred. */
  rank: number;
}

const braveNewsShape = z.object({
  results: z
    .array(
      z
        .object({
          url: z.string(),
          title: z.string().optional(),
          description: z.string().optional(),
          page_age: z.string().optional(),
        })
        .passthrough()
    )
    .optional(),
});

/** A news search, faked in tests. */
export interface NewsSearch {
  readonly name: string;
  latest(query: string, desk: Desk): Promise<Omit<WireItem, 'outlet' | 'rank'>[]>;
}

/** Brave returns at most fifty news results a request. */
export const BRAVE_NEWS_MAX = 50;

/** Brave's free plan allows one request a second. Spacing costs a few seconds a run. */
export const BRAVE_SPACING_MS = 1_100;

export class BraveNews implements NewsSearch {
  readonly name = 'brave-news';

  constructor(
    private apiKey: string,
    private get: HttpGetJson = nodeGetJson
  ) {}

  async latest(query: string, desk: Desk): Promise<Omit<WireItem, 'outlet' | 'rank'>[]> {
    const params = new URLSearchParams({
      q: query,
      count: String(BRAVE_NEWS_MAX),
      // THE LAST TWENTY-FOUR HOURS. The desk's own age check runs as well,
      // because Brave dates an article by when IT found it, and an old article
      // re-indexed this morning is "past day" to Brave.
      freshness: 'pd',
      search_lang: desk.language,
    });
    if (desk.country && desk.country.toUpperCase() !== 'ALL') params.set('country', desk.country);

    const res = await this.get(`https://api.search.brave.com/res/v1/news/search?${params}`, {
      accept: 'application/json',
      'x-subscription-token': this.apiKey,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`brave news search failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
    }

    const parsed = braveNewsShape.safeParse(res.json);
    if (!parsed.success) return [];
    return (parsed.data.results ?? []).map((r) => ({
      url: r.url,
      title: stripSiteSuffix(r.title ?? r.url),
      description: r.description ?? '',
      seenAt: r.page_age,
    }));
  }
}

/**
 * "Headline | Outlet Name" and "Headline - Outlet" are how most pages title
 * themselves. The outlet half is noise for clustering and for the writer.
 */
export const stripSiteSuffix = (title: string): string => {
  // A PIPE IS NEVER PART OF A HEADLINE, so everything from the first one goes,
  // however it is worded: "US-Iran talks | US-Israel war on Iran News" kept its
  // section name under a rule that only stripped suffixes free of hyphens.
  const piped = title.split(/\s+\|\s+/)[0]!;
  // A dash is, sometimes. Only a short trailing outlet name is stripped.
  return piped.replace(/\s+[–—-]\s+[^–—-]{2,30}$/, '').trim();
};

/** A rolling live page. By URL first, because the URL does not get rewritten. */
export const isLiveBlog = (url: string, title: string): boolean =>
  /\/(live|live-news|live-updates|liveblog|live-blog)(\/|-|$)/i.test(url) ||
  /\blive[- ]?(updates?|blog|coverage|results)\b|^live:|\bas it happened\b/i.test(title);

/**
 * A section front or headlines page, not an article. Seen live: "News: U.S. and
 * World News Headlines : NPR". An article's address has a story slug or an id
 * in it; a section front is one or two short path segments.
 */
export const isIndexPage = (url: string, title: string): boolean => {
  if (/\bheadlines\b|^(latest|top) news\b|^news\s*:/i.test(title)) return true;
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    // No story slug (a hyphen) and no id (a digit) in a short path: a section.
    const last = parts[parts.length - 1] ?? '';
    return parts.length === 0 || (parts.length <= 2 && !/[-\d]/.test(last));
  } catch {
    return true;
  }
};

/** Commentary, not reporting. */
export const isOpinion = (url: string, title: string): boolean =>
  /\/(opinion|opinions|commentisfree|comment|commentary|editorial|editorials|analysis|explainers?|ht-explainers|podcasts?|video|videos|av)\//i.test(
    url
  ) || /^(opinion|analysis|comment|explainer|watch|listen)\s*[:|]/i.test(title);

/**
 * Sport and entertainment, by where the outlet filed it. The first live
 * roundup picked an NFL match and the China Open tennis because their
 * headlines named neither "football" nor "tennis"; the URL section does.
 */
export const isSportOrShowbiz = (url: string): boolean =>
  /\/(sport|sports|cricket|football|soccer|tennis|golf|f1|formula-1|nfl|nba|mlb|rugby|olympics|entertainment|showbiz|lifestyle|culture|celebrity|tv-and-radio|film|music)(\/|-)/i.test(
    url
  );

export interface WireRejection {
  url: string;
  reason: string;
}

/**
 * Keep what the desk may build a report on, and say why the rest went.
 *
 * Deduplicated by URL, because the same article comes back from several of the
 * morning's queries and must not look like several outlets carrying a story.
 */
export const screenWire = (
  raw: Omit<WireItem, 'outlet' | 'rank'>[],
  desk: Desk
): { kept: WireItem[]; rejected: WireRejection[] } => {
  const kept: WireItem[] = [];
  const rejected: WireRejection[] = [];
  const seen = new Set<string>();
  const excluded = desk.excludeWords.map((w) => w.toLowerCase());

  for (const item of raw) {
    const key = item.url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const outlet = outletFor(desk, item.url);
    if (!outlet) {
      rejected.push({ url: item.url, reason: 'not one of the desk outlets' });
      continue;
    }
    if (isLiveBlog(item.url, item.title)) {
      rejected.push({ url: item.url, reason: 'a live blog, which is many stories on one page' });
      continue;
    }
    if (isIndexPage(item.url, item.title)) {
      rejected.push({ url: item.url, reason: 'a section front or headlines page, not an article' });
      continue;
    }
    if (isOpinion(item.url, item.title)) {
      rejected.push({ url: item.url, reason: 'opinion, analysis or video rather than a report' });
      continue;
    }
    if (isSportOrShowbiz(item.url)) {
      rejected.push({ url: item.url, reason: 'sport or entertainment, not news on the beat' });
      continue;
    }
    const headline = item.title.toLowerCase();
    const word = excluded.find((w) => new RegExp(`\\b${escapeRegExp(w)}\\b`).test(headline));
    if (word) {
      rejected.push({ url: item.url, reason: `off the desk's beat ("${word}")` });
      continue;
    }

    kept.push({ ...item, outlet: outlet.onAir, rank: desk.outlets.indexOf(outlet) });
  }

  return { kept, rejected };
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Brave's `page_age` has no zone and is UTC in practice; meta tags usually do.
 * Anything unparseable is `null`, which the caller treats as "cannot prove it
 * is fresh" rather than as fresh.
 */
export const parseWhen = (value: string | undefined): Date | null => {
  if (!value) return null;
  const trimmed = value.trim();
  const zoned = /[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed) ? trimmed : `${trimmed}Z`;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : zoned);
  return Number.isFinite(t) ? new Date(t) : null;
};

export const ageHours = (when: Date, now: Date): number =>
  (now.getTime() - when.getTime()) / 3_600_000;

/** Run the desk's queries one after another, spaced for the rate limit. */
export const sweepWire = async (
  queries: string[],
  desk: Desk,
  search: NewsSearch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  onProblem?: (message: string) => void
): Promise<Omit<WireItem, 'outlet' | 'rank'>[]> => {
  const all: Omit<WireItem, 'outlet' | 'rank'>[] = [];
  for (let i = 0; i < queries.length; i += 1) {
    if (i > 0) await sleep(BRAVE_SPACING_MS);
    try {
      all.push(...(await search.latest(queries[i]!, desk)));
    } catch (err) {
      // ONE FAILED QUERY COSTS ITS RESULTS, NOT THE RUN. Only a sweep that
      // found nothing at all is a failure, and the caller decides that.
      onProblem?.(`"${queries[i]}": ${(err as Error).message}`);
    }
  }
  return all;
};
