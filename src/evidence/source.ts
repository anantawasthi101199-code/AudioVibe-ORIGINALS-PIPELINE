/**
 * A source is something that was FETCHED. It cannot be written down.
 *
 * THIS IS THE WHOLE ANTI-HALLUCINATION DESIGN, and it is structural rather than
 * a check. Citation hallucination - plausible-looking references to papers that
 * do not exist, or real papers with corrupted metadata - is not a problem you
 * solve by asking a model to be careful, and the research is clear it is still
 * getting worse rather than plateauing. The only reliable fix is to make
 * inventing a citation impossible rather than discouraged.
 *
 * So `Source` has no public constructor path from generated text. The only
 * function that produces one is `fetchSource`, which requires an HTTP response.
 * A model can SELECT from sources that exist; it has no way to create one. A
 * reference that was never fetched cannot appear in an episode, because there
 * is nowhere for it to come from.
 *
 * Everything else here - tiers, hashes, retrieval dates - is bookkeeping on top
 * of that one property.
 */
import crypto from 'crypto';
import { z } from 'zod';

/**
 * How much weight a claim resting on this may carry.
 *
 * A claim is tagged with the LOWEST tier that supports it, so one T4 blog post
 * cannot be laundered into fact by sitting next to three T1 papers. A claim
 * whose only support is T4 is either cut or narrated explicitly as one person's
 * account - never as fact.
 */
export const sourceTierSchema = z.enum([
  /** Peer-reviewed research, primary documents, official filings, court records. */
  'T1',
  /** Reputable secondary reporting with named authorship. */
  'T2',
  /** Expert commentary, industry analysis, trade press. */
  'T3',
  /** Anecdote, forum posts, single self-reports. */
  'T4',
]);

export type SourceTier = z.infer<typeof sourceTierSchema>;

export const TIER_RANK: Record<SourceTier, number> = { T1: 1, T2: 2, T3: 3, T4: 4 };

/** The weakest tier in a set, which is the tier a claim resting on all of them gets. */
export const weakestTier = (tiers: SourceTier[]): SourceTier | null => {
  if (!tiers.length) return null;
  return tiers.reduce((worst, t) => (TIER_RANK[t] > TIER_RANK[worst] ? t : worst));
};

export const sourceSchema = z.object({
  /** Deterministic from the URL, so the same document is the same source across runs. */
  id: z.string().min(1),
  url: z.string().url(),
  /** DOI when the document has one. Not a substitute for having fetched it. */
  doi: z.string().optional(),

  title: z.string(),
  author: z.string().optional(),
  publisher: z.string().optional(),
  /** ISO date of publication, when the document states one. */
  publishedAt: z.string().optional(),

  /** When WE fetched it. Not optional: a claim is only as current as its retrieval. */
  retrievedAt: z.string().datetime(),

  /**
   * SHA-256 of the extracted text.
   *
   * Lets a re-fetch prove whether the document changed under a published
   * episode. A source that silently rewrote itself is a claim that quietly
   * stopped being supported, and without this nothing would ever notice.
   */
  contentHash: z.string().length(64),

  tier: sourceTierSchema,

  /** Extracted plain text. Quote spans are matched against exactly this. */
  text: z.string(),

  /** HTTP status the fetch returned, kept so a 200-with-error-page is auditable. */
  httpStatus: z.number().int(),
});

export type Source = z.infer<typeof sourceSchema>;

/**
 * Stable id for a URL.
 *
 * Normalised first so that the same document reached two ways is one source:
 * tracking parameters, fragments and a trailing slash are noise, and treating
 * them as distinct would let the same page be cited twice as if it were
 * corroboration.
 */
export const sourceIdFor = (url: string): string => {
  let normalised = url.trim();
  try {
    const u = new URL(url);
    u.hash = '';
    // Campaign and referrer junk. Not exhaustive, and does not need to be:
    // anything left over only risks a duplicate, never a wrong document.
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$|source$)/i.test(p)) u.searchParams.delete(p);
    }
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    u.protocol = 'https:';
    normalised = u.toString();
  } catch {
    // Not a parseable URL: hash it as given rather than losing it.
  }
  return crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 16);
};

export const hashText = (text: string): string =>
  crypto.createHash('sha256').update(text).digest('hex');

/**
 * Tier a source by where it came from.
 *
 * Deliberately conservative: anything unrecognised is T3, never T1. Guessing
 * upward is how a blog post becomes evidence, and the cost of guessing downward
 * is only that a good source is under-weighted until someone says otherwise.
 *
 * This is a starting point a human can override on the source record, not a
 * final judgement. Domain is a weak signal for authority and pretending
 * otherwise would be its own kind of dishonesty.
 */
const T1_HOSTS = [
  'doi.org',
  'arxiv.org',
  'pubmed.ncbi.nlm.nih.gov',
  'ncbi.nlm.nih.gov',
  'nature.com',
  'science.org',
  'thelancet.com',
  'nejm.org',
  'bmj.com',
  'jamanetwork.com',
  'sec.gov',
  'gov.uk',
  'legislation.gov.uk',
  'europa.eu',
  'judiciary.uk',
  'bailii.org',
  'courtlistener.com',
  'companieshouse.gov.uk',
  'ons.gov.uk',
  'oecd.org',
  'who.int',
];

const T2_HOSTS = [
  'reuters.com',
  'apnews.com',
  'bbc.co.uk',
  'bbc.com',
  'ft.com',
  'economist.com',
  'wsj.com',
  'nytimes.com',
  'theguardian.com',
  'bloomberg.com',
  'propublica.org',
];

const T4_PATTERNS = [
  /(^|\.)reddit\.com$/i,
  /(^|\.)quora\.com$/i,
  /(^|\.)medium\.com$/i,
  /(^|\.)substack\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)tiktok\.com$/i,
  /(^|\.)youtube\.com$/i,
  /(^|\.)wordpress\.com$/i,
  /(^|\.)blogspot\./i,
];

export const tierForUrl = (url: string): SourceTier => {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'T4';
  }

  const matches = (list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

  if (T4_PATTERNS.some((re) => re.test(host))) return 'T4';
  if (matches(T1_HOSTS)) return 'T1';
  if (matches(T2_HOSTS)) return 'T2';
  // Government and academic institutions generally, beyond the named list.
  if (/(^|\.)(gov|mil)(\.[a-z]{2})?$/.test(host)) return 'T1';
  if (/(^|\.)(ac\.[a-z]{2}|edu)$/.test(host)) return 'T1';
  return 'T3';
};
