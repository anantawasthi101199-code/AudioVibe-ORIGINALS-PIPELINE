import { LlmClient, LlmRequest, LlmResponse } from '../../models/client';
import { parseFormat } from '../../formats/load';
import { parsePersona } from '../../canon/load';
import { buildBrief, concentrateSources, gatherCorpus, gatherCounterEvidence } from '../research';
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

  /**
   * THE FAILURE THIS EXISTS FOR, measured on a real run rather than imagined.
   *
   * A brief asked thirteen good questions about ten different Hindu myths.
   * Eleven of the fourteen documents that came back were about Ganesha, because
   * Ganesha outranks every other Puranic subject on a general web search.
   * Seven of the ten stories fetched nothing at all, and the episode written
   * from that corpus told the Ganesha story four times and then spent two beats
   * explaining that the search had not found much.
   *
   * Neither the brief nor the writer was at fault. Ranking every query's
   * results in one pool cannot see which question a document answers, so it
   * spends the whole budget on the loudest one.
   */
  it('answers every query once before answering any of them twice', async () => {
    const search: SearchProvider = {
      name: 'lopsided',
      async search(q) {
        // The popular subject has six good results; the other two have one each.
        if (q === 'popular') {
          return Array.from({ length: 6 }, (_, i) => ({
            url: `https://www.sec.gov/popular-${i}`,
            title: 'popular',
          }));
        }
        return [{ url: `https://www.sec.gov/${q}-only`, title: q }];
      },
    };

    const corpus = await gatherCorpus(
      ['popular', 'obscure-a', 'obscure-b'],
      search,
      // Echoes the requested URL, because a source's id comes from its FINAL
      // url and a stub returning one address for everything collapses the
      // whole corpus into a single deduped source.
      {
        httpGet: async (url: string) => ok(url),
        now: () => new Date('2026-09-08T00:00:00.000Z'),
      },
      { targetSources: 4, perQuery: 8 }
    );

    const urls = corpus.sources.map((s) => s.url);
    // Pooled and globally ranked, all four would have been the popular subject.
    expect(urls.some((u) => u.includes('obscure-a'))).toBe(true);
    expect(urls.some((u) => u.includes('obscure-b'))).toBe(true);
    expect(urls.filter((u) => u.includes('popular')).length).toBeLessThanOrEqual(2);
  });

  it('a query whose results are all dead costs only its turn', async () => {
    const search: SearchProvider = {
      name: 'mixed',
      async search(q) {
        return [{ url: `https://www.sec.gov/${q}`, title: q }];
      },
    };

    const corpus = await gatherCorpus(
      ['dead', 'alive'],
      search,
      fetchDeps({
        'https://www.sec.gov/dead': { status: 404, body: '', finalUrl: 'https://www.sec.gov/dead' },
        '*': ok('https://www.sec.gov/alive'),
      }),
      { targetSources: 3, perQuery: 5 }
    );

    expect(corpus.sources).toHaveLength(1);
    expect(corpus.rejected[0]!.url).toContain('dead');
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

/**
 * One story, one or two documents.
 *
 * A listener called the story built from two sources the best in a ten-story
 * set, and the story built from four the worst. A ninety-second piece stitched
 * from four documents carries four writers' emphases and four sets of names for
 * the same people, and that is heard as the thing jumping around.
 */
describe('concentrateSources', () => {
  const claim = (id: string, beatId: string, sourceId: string) =>
    ({ id, beatId, sourceId, text: id, type: 'chronology', quote: id, contested: false }) as never;

  const src = (id: string, tier: string) => ({ id, tier }) as never;

  it('keeps the two documents that carry most of the story', () => {
    const claims = [
      claim('c1', 'story_01', 'a'),
      claim('c2', 'story_01', 'a'),
      claim('c3', 'story_01', 'a'),
      claim('c4', 'story_01', 'b'),
      claim('c5', 'story_01', 'b'),
      claim('c6', 'story_01', 'c'),
    ];

    const out = concentrateSources(claims, [src('a', 'T1'), src('b', 'T1'), src('c', 'T1')]);

    expect(out.claims.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(out.dropped).toEqual([{ beatId: 'story_01', sourceId: 'c', claims: 1 }]);
  });

  it('breaks a tie on tier, because the better document tells it better', () => {
    const claims = [
      claim('c1', 'story_01', 'a'),
      claim('c2', 'story_01', 'b'),
      claim('c3', 'story_01', 'c'),
    ];

    const out = concentrateSources(claims, [src('a', 'T3'), src('b', 'T1'), src('c', 'T2')]);
    expect(out.claims.map((c) => c.sourceId).sort()).toEqual(['b', 'c']);
  });

  it('treats each story separately, which is the whole point', () => {
    // Ten stories share one corpus. The two documents that carry story one are
    // not the two that carry story seven.
    const claims = [
      claim('c1', 'story_01', 'a'),
      claim('c2', 'story_01', 'b'),
      claim('c3', 'story_02', 'c'),
      claim('c4', 'story_02', 'd'),
    ];

    const out = concentrateSources(claims, [src('a', 'T1'), src('b', 'T1'), src('c', 'T1'), src('d', 'T1')]);
    expect(out.claims).toHaveLength(4);
    expect(out.dropped).toEqual([]);
  });

  it('leaves a story alone when it already draws on two or fewer', () => {
    const claims = [claim('c1', 'story_01', 'a'), claim('c2', 'story_01', 'b')];
    const out = concentrateSources(claims, [src('a', 'T1'), src('b', 'T1')]);

    expect(out.claims).toHaveLength(2);
    expect(out.dropped).toEqual([]);
  });

  it('gives the same answer twice on the same corpus', () => {
    // Sources tied on both count and tier are ordered by id, so a rerun cannot
    // keep a different pair and produce a different script from one corpus.
    const claims = [
      claim('c1', 'story_01', 'b'),
      claim('c2', 'story_01', 'c'),
      claim('c3', 'story_01', 'a'),
    ];
    const sources = [src('a', 'T1'), src('b', 'T1'), src('c', 'T1')];

    const once = concentrateSources(claims, sources).claims.map((c) => c.id);
    const twice = concentrateSources(claims, sources).claims.map((c) => c.id);
    expect(once).toEqual(twice);
  });
});
