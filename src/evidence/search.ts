/**
 * Finding candidate documents.
 *
 * WHY SEARCH AT ALL, RATHER THAN ASKING THE MODEL FOR URLS. Because a model
 * asked for sources will produce URLs that look exactly right and resolve to
 * nothing, or resolve to something entirely different. That is the same
 * citation-hallucination failure source.ts is built to make impossible, and
 * letting a model supply the addresses would smuggle it back in through the
 * front door.
 *
 * So the division is strict: the MODEL proposes search queries, which is a
 * judgement about what to look for and cannot be false in the relevant sense.
 * The SEARCH ENGINE proposes URLs. The fetcher proves they exist. A model never
 * originates an address.
 */
import { z } from 'zod';

export interface SearchResult {
  url: string;
  title: string;
  /** Engine-supplied snippet. Used for ranking only, never quoted. */
  snippet?: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, limit: number): Promise<SearchResult[]>;
}

export type HttpGetJson = (
  url: string,
  headers: Record<string, string>
) => Promise<{ status: number; json: unknown; text: string }>;

export const nodeGetJson: HttpGetJson = async (url, headers) => {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Left null; the caller reports raw text, which is what an error page is.
  }
  return { status: res.status, json, text };
};

const braveShape = z.object({
  web: z
    .object({
      results: z
        .array(
          z.object({
            url: z.string(),
            title: z.string().optional(),
            description: z.string().optional(),
          })
        )
        .optional(),
    })
    .optional(),
});

export class BraveSearch implements SearchProvider {
  readonly name = 'brave';

  constructor(
    private apiKey: string,
    private get: HttpGetJson = nodeGetJson
  ) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(limit, 20)}`;
    const res = await this.get(url, {
      accept: 'application/json',
      'x-subscription-token': this.apiKey,
    });

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`brave search failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
    }

    const parsed = braveShape.safeParse(res.json);
    if (!parsed.success) return [];

    return (parsed.data.web?.results ?? []).map((r) => ({
      url: r.url,
      title: r.title ?? r.url,
      snippet: r.description,
    }));
  }
}

/**
 * Rank and thin a pile of search results before anything is fetched.
 *
 * Fetching is the expensive, slow, rate-limited step, so the ordering here
 * decides what the corpus is made of. Primary and official sources first,
 * because an episode built on reporting about a filing is weaker than one built
 * on the filing, and the whole show's claim on attention is that it read the
 * document.
 */
export const rankCandidates = (
  results: SearchResult[],
  tierOf: (url: string) => 'T1' | 'T2' | 'T3' | 'T4'
): SearchResult[] => {
  const rank = { T1: 0, T2: 1, T3: 2, T4: 3 };
  const seen = new Set<string>();
  const unique: SearchResult[] = [];

  for (const r of results) {
    // Dedupe by host+path so the same document from two queries is one
    // candidate rather than reading as corroboration.
    let key = r.url;
    try {
      const u = new URL(r.url);
      key = `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      // Unparseable: keep as-is rather than dropping a possibly good result.
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  return unique.sort((a, b) => rank[tierOf(a.url)] - rank[tierOf(b.url)]);
};
