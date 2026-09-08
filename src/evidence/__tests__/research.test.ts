import { LlmClient, LlmRequest, LlmResponse } from '../../models/client';
import { parseFormat } from '../../formats/load';
import { parsePersona } from '../../canon/load';
import { buildBrief, gatherCorpus, gatherCounterEvidence } from '../research';
import { rankCandidates, SearchProvider, SearchResult, BraveSearch } from '../search';
import { tierForUrl } from '../source';
import { HttpResponse } from '../fetch';

const PERSONA = parsePersona(`
id: t
handle: t
name: T
category: Educational
thesis: A show.
audience: People.
register: Plain.
hosts: [{id: host, name: Host, role: Narrates the show., voice: {provider: elevenlabs, voiceId: v}}]
styleCard:
  sentenceWordsMean: 15
  sentenceWordsStdDevMin: 5
  questionsPer100Words: 1
  secondPersonPer100Words: 1
  hedgesPer100WordsMax: 2
  metaphorDomains: [x]
formats: [f]
episodeSeconds: [300, 400]
allowedRiskTiers: [general]
`);

const FORMAT = parseFormat(`
id: f
name: F
kind: long
intent: x
targetSeconds: [30, 60]
beats:
  - {id: cold_open, type: cold_open, seconds: [8, 14], function: Open.}
  - {id: payoff, type: payoff, seconds: [20, 40], function: Land.}
tensionCurve: [0.9, 1.0]
`);

const fakeLlm = (reply: string): LlmClient & { seen: LlmRequest[] } => {
  const seen: LlmRequest[] = [];
  return {
    name: 'fake',
    model: 'fake-1',
    seen,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      seen.push(req);
      return { text: reply, inputTokens: 1, outputTokens: 1, costPence: 0.5, model: 'fake-1' };
    },
  };
};

const fakeSearch = (byQuery: Record<string, SearchResult[]>): SearchProvider => ({
  name: 'fake',
  async search(q) {
    if (byQuery[q]) return byQuery[q]!;
    if (byQuery['*']) return byQuery['*']!;
    throw new Error(`no stub for query: ${q}`);
  },
});

const page = (chars = 900) =>
  `<html><head><title>Doc</title></head><body><p>${'word '.repeat(chars / 5)}</p></body></html>`;

const fetchDeps = (byUrl: Record<string, HttpResponse | Error>) => ({
  httpGet: async (url: string) => {
    const r = byUrl[url] ?? byUrl['*'];
    if (!r) throw new Error('not stubbed');
    if (r instanceof Error) throw r;
    return r;
  },
  now: () => new Date('2026-09-08T00:00:00.000Z'),
});

const ok = (finalUrl: string): HttpResponse => ({
  status: 200,
  body: page(),
  finalUrl,
  contentType: 'text/html',
});

describe('buildBrief', () => {
  it('parses a brief and reports cost', async () => {
    const llm = fakeLlm(
      '{"angle":"the alarm","mustEstablish":["it was disabled"],"queries":["a","b","c"],"likelyContested":["x"]}'
    );
    const costs: number[] = [];
    const brief = await buildBrief('A topic', PERSONA, FORMAT, llm, (c) => costs.push(c));

    expect(brief.angle).toBe('the alarm');
    expect(brief.queries).toHaveLength(3);
    expect(costs).toEqual([0.5]);
  });

  it('does not ask the model for URLs', async () => {
    // The division that keeps citation hallucination impossible: the model
    // proposes what to LOOK FOR, the search engine proposes addresses.
    const llm = fakeLlm('{"angle":"a","mustEstablish":["b"],"queries":["c","d","e"]}');
    await buildBrief('A topic', PERSONA, FORMAT, llm);
    expect(llm.seen[0]!.system).not.toMatch(/\burls?\b/i);
    expect(llm.seen[0]!.system).toMatch(/queries/i);
  });

  it('rejects a brief with too few queries rather than searching on one idea', async () => {
    const llm = fakeLlm('{"angle":"a","mustEstablish":["b"],"queries":["only one"]}');
    await expect(buildBrief('T', PERSONA, FORMAT, llm)).rejects.toThrow();
  });
});

describe('rankCandidates', () => {
  it('puts primary sources first', () => {
    // An episode built on reporting about a filing is weaker than one built on
    // the filing, and fetching is the expensive step, so order decides the
    // corpus.
    const ranked = rankCandidates(
      [
        { url: 'https://someblog.com/a', title: 'a' },
        { url: 'https://www.sec.gov/f', title: 'b' },
        { url: 'https://www.reuters.com/c', title: 'c' },
      ],
      tierForUrl
    );
    expect(ranked.map((r) => new URL(r.url).hostname)).toEqual([
      'www.sec.gov',
      'www.reuters.com',
      'someblog.com',
    ]);
  });

  it('dedupes the same document reached from two queries', () => {
    // Otherwise one document counts twice and reads as corroboration.
    const ranked = rankCandidates(
      [
        { url: 'https://www.sec.gov/f', title: 'a' },
        { url: 'https://sec.gov/f/', title: 'b' },
      ],
      tierForUrl
    );
    expect(ranked).toHaveLength(1);
  });
});

describe('gatherCorpus', () => {
  it('fetches ranked candidates up to the target', async () => {
    const corpus = await gatherCorpus(
      ['q1'],
      fakeSearch({
        '*': [
          { url: 'https://www.sec.gov/a', title: 'a' },
          { url: 'https://www.sec.gov/b', title: 'b' },
          { url: 'https://www.sec.gov/c', title: 'c' },
        ],
      }),
      fetchDeps({ '*': ok('https://www.sec.gov/x') }),
      { targetSources: 2, perQuery: 5 }
    );
    expect(corpus.sources.length).toBeLessThanOrEqual(2);
  });

  it('RECORDS why a document was rejected rather than swallowing it', async () => {
    // A thin corpus should say whether the topic is obscure or whether fifteen
    // paywalls said no. Those call for completely different responses.
    const corpus = await gatherCorpus(
      ['q1'],
      fakeSearch({ '*': [{ url: 'https://www.sec.gov/a', title: 'a' }] }),
      fetchDeps({ '*': { status: 403, body: '', finalUrl: 'https://www.sec.gov/a' } }),
      { targetSources: 3, perQuery: 5 }
    );
    expect(corpus.sources).toHaveLength(0);
    expect(corpus.rejected[0]).toMatchObject({ url: 'https://www.sec.gov/a' });
    expect(corpus.rejected[0]!.reason).toMatch(/403/);
  });

  it('survives one failing query without losing the others', async () => {
    const search: SearchProvider = {
      name: 'flaky',
      async search(q) {
        if (q === 'bad') throw new Error('engine down');
        return [{ url: 'https://www.sec.gov/a', title: 'a' }];
      },
    };
    const corpus = await gatherCorpus(['bad', 'good'], search, fetchDeps({ '*': ok('https://www.sec.gov/a') }), {
      targetSources: 3,
      perQuery: 5,
    });
    expect(corpus.sources).toHaveLength(1);
  });

  it('does not add the same source twice', async () => {
    const corpus = await gatherCorpus(
      ['q1', 'q2'],
      fakeSearch({ '*': [{ url: 'https://www.sec.gov/a', title: 'a' }] }),
      fetchDeps({ '*': ok('https://www.sec.gov/a') }),
      { targetSources: 5, perQuery: 5 }
    );
    expect(corpus.sources).toHaveLength(1);
  });
});

describe('gatherCounterEvidence', () => {
  const claim = {
    id: 'c1',
    text: 'Shorter shifts caused fewer incidents.',
    type: 'causal' as const,
    beatId: 'payoff',
    sourceId: 's1',
    quote: 'x'.repeat(50),
    contested: true,
  };

  it('only runs for contested claims', async () => {
    const llm = fakeLlm('{"queries":["q"]}');
    const out = await gatherCounterEvidence(
      [{ ...claim, contested: false }],
      fakeSearch({ '*': [] }),
      fetchDeps({}),
      llm
    );
    expect(out).toHaveLength(0);
    expect(llm.seen).toHaveLength(0);
  });

  it('asks for disconfirming queries, not confirming ones', async () => {
    // The step that separates a grounded show from a confident one.
    const llm = fakeLlm('{"queries":["failed replication shifts incidents"]}');
    await gatherCounterEvidence([claim], fakeSearch({ '*': [] }), fetchDeps({}), llm);
    expect(llm.seen[0]!.system).toMatch(/AGAINST/);
    expect(llm.seen[0]!.system).toMatch(/failed replications|retractions|contrary/i);
  });

  it('collects counter-sources that fetch', async () => {
    const llm = fakeLlm('{"queries":["q"]}');
    const out = await gatherCounterEvidence(
      [claim],
      fakeSearch({ '*': [{ url: 'https://www.nature.com/x', title: 'x' }] }),
      fetchDeps({ '*': ok('https://www.nature.com/x') }),
      llm
    );
    expect(out[0]!.sources).toHaveLength(1);
  });

  it('does not fail the run when a counter-source will not fetch', async () => {
    const llm = fakeLlm('{"queries":["q"]}');
    const out = await gatherCounterEvidence(
      [claim],
      fakeSearch({ '*': [{ url: 'https://www.nature.com/x', title: 'x' }] }),
      fetchDeps({ '*': new Error('timeout') }),
      llm
    );
    expect(out[0]!.sources).toHaveLength(0);
    expect(out[0]!.queries).toEqual(['q']);
  });
});

describe('BraveSearch', () => {
  it('maps results', async () => {
    const search = new BraveSearch('k', async () => ({
      status: 200,
      json: { web: { results: [{ url: 'https://a.com', title: 'A', description: 'd' }] } },
      text: '',
    }));
    expect(await search.search('q', 5)).toEqual([{ url: 'https://a.com', title: 'A', snippet: 'd' }]);
  });

  it('throws with the status on failure', async () => {
    const search = new BraveSearch('k', async () => ({ status: 401, json: null, text: 'nope' }));
    await expect(search.search('q', 5)).rejects.toThrow(/HTTP 401/);
  });

  it('returns nothing rather than throwing on an unexpected body', async () => {
    const search = new BraveSearch('k', async () => ({ status: 200, json: { unexpected: true }, text: '' }));
    expect(await search.search('q', 5)).toEqual([]);
  });
});
