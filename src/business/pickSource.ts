/**
 * Finding the ONE source that tells a business story from start to finish.
 *
 * NO MODEL CHOOSES IT. What makes a source right for this show is measurable:
 *
 *   complete     long enough to carry the format, read whole
 *   chronological  many distinct years across a long span, which is what a
 *                life story from a first shop to an empire looks like on paper
 *   on subject   the subject's own words appear throughout, not once
 *   top tier     an encyclopedia, the company's own history, the business
 *                press, scored above a content-farm "success story" post
 *
 * So each candidate is fetched and scored on exactly those, for free, and the
 * best one wins. A first live probe of "Haldiram history founder story"
 * returned Wikipedia, Business Standard and Financial Express alongside
 * LinkedIn, Quora and three blog farms; the score is built to pull the first
 * group to the top and the refused list removes the rest before any fetch.
 *
 * Like every search in this repo: the search engine proposes URLs and the
 * fetcher proves they exist. A model never originates an address.
 */
import { FetchDeps, fetchSource, SourceFetchError } from '../evidence/fetch';
import { SearchProvider } from '../evidence/search';
import { Source, tierForUrl } from '../evidence/source';
import { Casebook } from './casebook';

const QUESTION_WORDS = new Set(
  (
    'how did does do why when what who is was the a an of story history rise become became ' +
    'build built grow grew get got make made and in to its their his her from into full life'
  ).split(' ')
);

/**
 * The subject a topic is about, for search: "how did reliance group ambani
 * become the richest in asia" -> "reliance group ambani".
 *
 * Takes the text before the first "become"/"build"-style verb when the topic is
 * a question, because what follows it is the outcome, not the subject.
 */
export const subjectOf = (topic: string): string => {
  const t = topic
    .trim()
    .replace(/[?!.]+$/, '')
    .replace(/^(the (full |whole )?story of|the history of|history of|story of)\s+/i, '')
    .replace(/^(how|why|when)\s+(did|does|do|is|was|has|have)\s+/i, '');
  const cut = t.split(/\s+(?:become|became|get|got|build|built|grow|grew|make|made|turn|turned|go|went)\b/i)[0]!;
  return cut.trim() || topic.trim();
};

/** Words of the subject that must appear in a source about it. */
export const subjectTokens = (subject: string): string[] =>
  subject
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !QUESTION_WORDS.has(w));

/**
 * The part of a fetched page a writer should read: citation markers and the
 * back matter (references, external links) removed. The same function feeds
 * the writer and the checks, so a "figure" that is really footnote [12] can
 * never make an invented number look supported.
 */
export const cleanStoryText = (text: string): string => {
  let t = text
    // Spaces allowed inside: the live Reliance page came through as "[ 20 ]".
    .replace(/\[\s*(?:\d+|[a-z]|citation needed|edit|note \d+|nb \d+)\s*\]/gi, '')
    .replace(/[ \t]+\n/g, '\n');
  const back = /\n\s*(References|External links|See also|Notes|Further reading|Bibliography|Sources)\s*\n/gi;
  let cutAt = -1;
  for (const m of t.matchAll(back)) if (m.index! > t.length * 0.5) { cutAt = m.index!; break; }
  if (cutAt > 0) t = t.slice(0, cutAt);
  return t.trim();
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

const matchesHost = (host: string, want: string) => host === want || host.endsWith(`.${want}`);

export const isRefused = (url: string, book: Casebook): string | null => {
  const host = hostOf(url);
  if (!host) return 'not a valid address';
  const refused = book.refused.find((r) => matchesHost(host, r));
  if (refused) return `${refused} is on the casebook's refused list`;
  if (tierForUrl(url) === 'T4') return 'a social, forum or blog platform';
  if (/\.(pdf|mp4|mp3)(\?|$)/i.test(url)) return 'not a web page';
  return null;
};

export interface Scored {
  source: Source;
  /** The cleaned text the writer and the checks use. */
  text: string;
  score: number;
  years: number;
  span: number;
  mentions: number;
  reason: string;
}

/**
 * Score one fetched document. Returns null, with a reason, when it cannot be
 * the source at all: too short, or not about the subject.
 */
export const scoreSource = (
  source: Source,
  subject: string,
  book: Casebook,
  kind: 'short' | 'long',
  now: Date
): Scored | { rejected: string } => {
  const text = cleanStoryText(source.text);
  const lower = text.toLowerCase();
  if (text.length < book.minChars[kind]) {
    return { rejected: `only ${text.length.toLocaleString()} characters, too little for a whole story` };
  }

  const tokens = subjectTokens(subject);
  const present = tokens.filter((t) => lower.includes(t));
  const coverage = tokens.length ? present.length / tokens.length : 0;
  const lead = tokens[0];
  const mentions = lead ? lower.split(lead).length - 1 : 0;
  if (coverage < 0.5 || mentions < 3) {
    return { rejected: `barely mentions "${subject}", so it is not the story of it` };
  }

  const thisYear = now.getUTCFullYear();
  const years = [...new Set([...text.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)].map((m) => Number(m[1])))].filter(
    (y) => y <= thisYear
  );
  const span = years.length ? Math.max(...years) - Math.min(...years) : 0;

  const host = hostOf(source.url);
  const bonus = book.preferred.find((p) => matchesHost(host, p.host))?.bonus ?? 0;

  // COMPLETENESS WEIGHS MOST. The first live run chose a 5,121-character
  // encyclopedia stub over an 18,178-character feature telling the whole
  // story, because the tier bonus outweighed length. The owner's rule is "a
  // source that has the complete story", so length now carries the most.
  const score =
    (Math.min(text.length, 30_000) / 30_000) * 5 +
    (Math.min(years.length, 25) / 25) * 3 +
    (Math.min(span, 60) / 60) * 1 +
    coverage * 2 +
    (Math.min(mentions, 20) / 20) * 1 +
    bonus;

  return {
    source,
    text,
    score,
    years: years.length,
    span,
    mentions,
    reason:
      `${text.length.toLocaleString()} chars, ${years.length} distinct years over ${span}, ` +
      `"${lead}" x${mentions}${bonus ? `, preferred +${bonus}` : ''}`,
  };
};

export interface Candidate {
  url: string;
  title: string;
}

export interface PickResult {
  best: Scored | null;
  considered: Array<{ url: string; score?: number; reason: string }>;
}

/** Run the casebook's searches for a subject, spaced for Brave's rate limit. */
export const searchStory = async (
  subject: string,
  book: Casebook,
  search: SearchProvider,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  onProblem?: (message: string) => void
): Promise<Candidate[]> => {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < book.queries.length; i += 1) {
    if (i > 0) await sleep(1_100);
    const query = book.queries[i]!.replace(/\{subject\}/g, subject);
    try {
      for (const r of await search.search(query, 10)) {
        const key = r.url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ url: r.url, title: r.title });
      }
    } catch (err) {
      onProblem?.(`"${query}": ${(err as Error).message}`);
    }
  }
  return out;
};

/**
 * Fetch the most promising candidates and keep the best-scoring one.
 *
 * Preferred hosts are fetched first, then the rest in search order, up to the
 * casebook's candidate count. Fetches run together; they are different hosts.
 */
export const pickStorySource = async (
  candidates: Candidate[],
  subject: string,
  book: Casebook,
  kind: 'short' | 'long',
  fetchDeps: FetchDeps,
  now: Date
): Promise<PickResult> => {
  const considered: PickResult['considered'] = [];
  const usable: Candidate[] = [];
  for (const c of candidates) {
    const refused = isRefused(c.url, book);
    if (refused) considered.push({ url: c.url, reason: refused });
    else usable.push(c);
  }

  const rank = (c: Candidate) => {
    const host = hostOf(c.url);
    const p = book.preferred.findIndex((x) => matchesHost(host, x.host));
    return p === -1 ? book.preferred.length : p;
  };
  const order = usable
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .slice(0, book.candidates)
    .map(({ c }) => c);

  const results = await Promise.all(
    order.map(async (c) => {
      try {
        const source = await fetchSource(c.url, fetchDeps);
        return { c, scored: scoreSource(source, subject, book, kind, now) };
      } catch (err) {
        const reason = err instanceof SourceFetchError ? err.message : (err as Error).message;
        return { c, scored: { rejected: reason } };
      }
    })
  );

  let best: Scored | null = null;
  for (const { c, scored } of results) {
    if ('rejected' in scored) {
      considered.push({ url: c.url, reason: scored.rejected });
      continue;
    }
    considered.push({ url: c.url, score: Math.round(scored.score * 100) / 100, reason: scored.reason });
    if (!best || scored.score > best.score) best = scored;
  }
  return { best, considered };
};
