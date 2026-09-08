import { HttpResponse } from '../fetch';
import { SearchProvider, SearchResult } from '../search';
import {
  buildSearch,
  describeRetrieval,
  ExaSearch,
  firecrawlGet,
  PooledSearch,
} from '../providers';

const stub = (name: string, results: SearchResult[] | Error): SearchProvider => ({
  name,
  async search() {
    if (results instanceof Error) throw results;
    return results;
  },
});

describe('ExaSearch', () => {
  it('maps neural results', async () => {
    const exa = new ExaSearch('k', async () => ({
      status: 200,
      json: { results: [{ url: 'https://a.com', title: 'A', text: 'snippet' }] },
      text: '',
    }));
    expect(await exa.search('q', 5)).toEqual([{ url: 'https://a.com', title: 'A', snippet: 'snippet' }]);
  });

  it('asks for snippets only, because a source must come from OUR fetch', async () => {
    // The whole anti-hallucination design rests on fetchSource being the only
    // producer of a Source. Taking Exa's full text would create a document this
    // pipeline never retrieved.
    let body: { contents?: { text?: { maxCharacters?: number } } } = {};
    const exa = new ExaSearch('k', async (_u, _h, b) => {
      body = b as typeof body;
      return { status: 200, json: { results: [] }, text: '' };
    });
    await exa.search('q', 5);
    expect(body.contents?.text?.maxCharacters).toBeLessThanOrEqual(1000);
  });

  it('throws with the status on failure', async () => {
    const exa = new ExaSearch('k', async () => ({ status: 402, json: null, text: 'no credit' }));
    await expect(exa.search('q', 5)).rejects.toThrow(/HTTP 402/);
  });

  it('returns nothing rather than throwing on an unexpected body', async () => {
    const exa = new ExaSearch('k', async () => ({ status: 200, json: { odd: true }, text: '' }));
    expect(await exa.search('q', 5)).toEqual([]);
  });
});

describe('PooledSearch', () => {
  it('pools results from every provider', async () => {
    const pooled = new PooledSearch([
      stub('a', [{ url: 'https://a.com', title: 'a' }]),
      stub('b', [{ url: 'https://b.com', title: 'b' }]),
    ]);
    expect(await pooled.search('q', 5)).toHaveLength(2);
  });

  it('SURVIVES one provider failing', async () => {
    // An outage at one search API should degrade the corpus, not end the run.
    const pooled = new PooledSearch([
      stub('down', new Error('503')),
      stub('up', [{ url: 'https://b.com', title: 'b' }]),
    ]);
    expect(await pooled.search('q', 5)).toEqual([{ url: 'https://b.com', title: 'b' }]);
  });

  it('names itself after what it pools, so logs say what ran', () => {
    expect(new PooledSearch([stub('brave', []), stub('exa', [])]).name).toBe('brave+exa');
  });

  it('refuses to exist with no providers', () => {
    expect(() => new PooledSearch([])).toThrow(/at least one/);
  });
});

describe('buildSearch', () => {
  const make = {
    brave: (k: string) => stub(`brave:${k}`, []),
    exa: (k: string) => stub(`exa:${k}`, []),
  };

  it('uses one provider directly rather than pooling one thing', () => {
    expect(buildSearch({ brave: 'x' }, make).name).toBe('brave:x');
  });

  it('pools when both are configured', () => {
    expect(buildSearch({ brave: 'x', exa: 'y' }, make).name).toContain('+');
  });

  it('REFUSES to start with no search at all', () => {
    // Better than a run that searches nothing and then abandons itself twenty
    // seconds later for a thin corpus, with a misleading reason.
    expect(() => buildSearch({}, make)).toThrow(/no search provider configured/);
  });
});

describe('firecrawlGet', () => {
  const fallback = async (): Promise<HttpResponse> => ({
    status: 200,
    body: '<p>from the plain fetcher</p>',
    finalUrl: 'https://fallback',
    contentType: 'text/html',
  });

  it('returns rendered markdown, flagged so the fetcher keeps it as text', async () => {
    // Markdown keeps headings and list structure that the regex HTML stripper
    // flattens, which makes it a better substrate for quote spans.
    const get = firecrawlGet('k', fallback, async () => ({
      status: 200,
      json: { data: { markdown: '# Title\n\n' + 'x'.repeat(300), metadata: { sourceURL: 'https://real' } } },
      text: '',
    }));
    const res = await get('https://asked');
    expect(res.contentType).toBe('text/markdown');
    expect(res.finalUrl).toBe('https://real');
    expect(res.body).toContain('# Title');
  });

  it('FALLS BACK when firecrawl fails', async () => {
    // Being out of credit should cost documents, not the whole run.
    const get = firecrawlGet('k', fallback, async () => ({ status: 402, json: null, text: 'no credit' }));
    expect((await get('https://asked')).finalUrl).toBe('https://fallback');
  });

  it('falls back when it returns almost nothing', async () => {
    const get = firecrawlGet('k', fallback, async () => ({
      status: 200,
      json: { data: { markdown: 'tiny' } },
      text: '',
    }));
    expect((await get('https://asked')).finalUrl).toBe('https://fallback');
  });

  it('falls back on an unexpected response shape', async () => {
    const get = firecrawlGet('k', fallback, async () => ({ status: 200, json: { odd: true }, text: '' }));
    expect((await get('https://asked')).finalUrl).toBe('https://fallback');
  });
});

describe('describeRetrieval', () => {
  it('says what will actually be used', () => {
    expect(describeRetrieval({ brave: 'x', exa: 'y', firecrawl: 'z' })).toBe(
      'search: brave + exa, fetch: firecrawl (renders JS)'
    );
    expect(describeRetrieval({ brave: 'x' })).toBe('search: brave, fetch: plain fetch');
  });
});
