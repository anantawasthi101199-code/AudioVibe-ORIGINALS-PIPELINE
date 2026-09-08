/**
 * Optional, better retrieval. All of it opt-in by environment variable, and
 * none of it required.
 *
 * WHY NOT MCP. The obvious 2026 answer to "how should an agent reach these
 * tools" is a Model Context Protocol server per provider, and for an agent that
 * is right: MCP exists so a model can DISCOVER tools it was not built against.
 * This pipeline is not an agent. It has nine fixed stages that call the same
 * things in the same order every time, so tool discovery buys nothing and costs
 * a transport, a process and a schema round-trip per call. What MCP would
 * actually give here is a stable interface boundary, and `SearchProvider` and
 * `FetchDeps` already are one - an MCP-backed provider drops in behind either
 * without anything upstream noticing.
 *
 * WHY THESE THREE.
 *
 *   Brave    - independent index, fastest, and the free default. Benchmarks put
 *              it at or near the top for research quality among agent search
 *              APIs, so this is not a compromise.
 *   Exa      - neural search over its own crawled index. Better at "find me
 *              things ABOUT this" than at "find me pages containing these
 *              words", which is exactly what a research brief needs.
 *   Firecrawl - page fetching that renders JavaScript. This is the one that
 *              earns its keep: the plain fetcher rejects JS-only pages as
 *              "paywall or a JS shell", and on some topics that is most of the
 *              corpus.
 */
import { z } from 'zod';
import { HttpResponse } from './fetch';
import { HttpGetJson, nodeGetJson, SearchProvider, SearchResult } from './search';

// ---------------------------------------------------------------------------
// Exa: neural search
// ---------------------------------------------------------------------------

const exaShape = z.object({
  results: z
    .array(
      z.object({
        url: z.string(),
        title: z.string().nullable().optional(),
        text: z.string().nullable().optional(),
      })
    )
    .optional(),
});

export type HttpPostJson = (
  url: string,
  headers: Record<string, string>,
  body: unknown
) => Promise<{ status: number; json: unknown; text: string }>;

export const nodePostJson: HttpPostJson = async (url, headers, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Left null; the caller reports the raw text.
  }
  return { status: res.status, json, text };
};

export class ExaSearch implements SearchProvider {
  readonly name = 'exa';

  constructor(
    private apiKey: string,
    private post: HttpPostJson = nodePostJson
  ) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const res = await this.post(
      'https://api.exa.ai/search',
      { 'x-api-key': this.apiKey },
      {
        query,
        numResults: Math.min(limit, 25),
        // Neural rather than keyword: the point of using Exa at all.
        type: 'auto',
        // Snippets only. The full document is fetched separately, because a
        // source has to come from a fetch this pipeline made - see source.ts.
        contents: { text: { maxCharacters: 400 } },
      }
    );

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`exa search failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
    }

    const parsed = exaShape.safeParse(res.json);
    if (!parsed.success) return [];

    return (parsed.data.results ?? []).map((r) => ({
      url: r.url,
      title: r.title ?? r.url,
      snippet: r.text ?? undefined,
    }));
  }
}

/**
 * Run several search providers and pool their results.
 *
 * Ranking and deduplication happen downstream in `rankCandidates`, so this only
 * has to gather. One provider failing must not lose the others: an outage at
 * one search API should degrade the corpus, not end the run.
 */
export class PooledSearch implements SearchProvider {
  readonly name: string;

  constructor(private providers: SearchProvider[]) {
    if (!providers.length) throw new Error('PooledSearch needs at least one provider');
    this.name = providers.map((p) => p.name).join('+');
  }

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const results = await Promise.all(
      this.providers.map((p) => p.search(query, limit).catch(() => [] as SearchResult[]))
    );
    return results.flat();
  }
}

// ---------------------------------------------------------------------------
// Firecrawl: fetching that renders JavaScript
// ---------------------------------------------------------------------------

const firecrawlShape = z.object({
  success: z.boolean().optional(),
  data: z
    .object({
      markdown: z.string().optional(),
      metadata: z
        .object({
          sourceURL: z.string().optional(),
          url: z.string().optional(),
          statusCode: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * An `httpGet` that renders the page first.
 *
 * Returns markdown rather than HTML, and says so in the content type, so the
 * fetcher stores it as text instead of running its HTML stripper over it.
 * Markdown is also a better substrate for quote spans than stripped HTML: it
 * keeps headings and list structure that the regex extractor flattens.
 *
 * Falls back to the plain fetcher on any failure, because Firecrawl being down
 * or out of credit should cost the run some documents, not all of them.
 */
export const firecrawlGet = (
  apiKey: string,
  fallback: (url: string) => Promise<HttpResponse>,
  post: HttpPostJson = nodePostJson
): ((url: string) => Promise<HttpResponse>) => {
  return async (url: string): Promise<HttpResponse> => {
    try {
      const res = await post(
        'https://api.firecrawl.dev/v1/scrape',
        { authorization: `Bearer ${apiKey}` },
        { url, formats: ['markdown'], onlyMainContent: true, timeout: 25000 }
      );

      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);

      const parsed = firecrawlShape.safeParse(res.json);
      if (!parsed.success) throw new Error('unexpected response shape');

      const scraped = parsed.data.data;
      const markdown = scraped?.markdown;
      if (!markdown || markdown.length < 200) throw new Error('no usable content');

      return {
        status: 200,
        body: markdown,
        finalUrl: scraped?.metadata?.sourceURL ?? scraped?.metadata?.url ?? url,
        // Not HTML: tells fetch.ts to keep this text as-is.
        contentType: 'text/markdown',
      };
    } catch {
      return fallback(url);
    }
  };
};

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export interface RetrievalKeys {
  brave?: string;
  exa?: string;
  firecrawl?: string;
}

export const retrievalKeys = (): RetrievalKeys => ({
  brave: process.env.BRAVE_SEARCH_API_KEY?.trim() || undefined,
  exa: process.env.EXA_API_KEY?.trim() || undefined,
  firecrawl: process.env.FIRECRAWL_API_KEY?.trim() || undefined,
});

/**
 * Build the search provider from whatever keys are present.
 *
 * At least one is required. Refusing to start is better than a run that
 * searches nothing and then abandons itself for a thin corpus twenty seconds
 * later with a misleading reason.
 */
export const buildSearch = (
  keys: RetrievalKeys,
  make: {
    brave: (key: string) => SearchProvider;
    exa: (key: string) => SearchProvider;
  }
): SearchProvider => {
  const providers: SearchProvider[] = [];
  if (keys.brave) providers.push(make.brave(keys.brave));
  if (keys.exa) providers.push(make.exa(keys.exa));

  if (!providers.length) {
    throw new Error(
      'no search provider configured. Set BRAVE_SEARCH_API_KEY (free tier available) ' +
        'or EXA_API_KEY. Both together is better: Brave has an independent index and ' +
        'Exa searches by meaning, and they surface different documents.'
    );
  }

  return providers.length === 1 ? providers[0]! : new PooledSearch(providers);
};

export const describeRetrieval = (keys: RetrievalKeys): string => {
  const search = [keys.brave && 'brave', keys.exa && 'exa'].filter(Boolean).join(' + ') || 'none';
  const fetcher = keys.firecrawl ? 'firecrawl (renders JS)' : 'plain fetch';
  return `search: ${search}, fetch: ${fetcher}`;
};

export { nodeGetJson, type HttpGetJson };
