/**
 * Claim extraction, chunked by beat.
 *
 * THE FAILURE THIS FIXES KILLED A REAL RUN. Ten beats against fourteen
 * documents, every claim carrying a verbatim quote of forty characters or more,
 * ran past sixteen thousand output tokens twice - and it did so AFTER the
 * corpus had been searched, fetched and paid for, which is the worst place in
 * the pipeline to die.
 *
 * The two things that must hold: every chunk sees the same corpus (so the cache
 * works and chunking does not triple the bill), and claim ids are unique across
 * chunks (because each call starts counting at c1 and cannot see the others).
 */
import { EpisodeFormat } from '../../formats/schema';
import { LlmClient, LlmRequest, LlmResponse } from '../../models/client';
import { Source } from '../source';
import { BEATS_PER_EXTRACTION, Brief, Corpus, extractClaims } from '../research';

const QUOTE = 'The regulator fined the operator four point two million pounds in March 2024.';

const source = (id: string): Source =>
  ({
    id,
    url: `https://www.gov.uk/${id}`,
    title: `Document ${id}`,
    tier: 'T1',
    text: `${QUOTE} ${'Filler about the inquiry. '.repeat(40)}`,
    contentHash: 'a'.repeat(64),
    retrievedAt: '2026-09-11T00:00:00.000Z',
    httpStatus: 200,
  }) as Source;

const corpus: Corpus = { sources: [source('s1'), source('s2')], rejected: [] };

const brief: Brief = {
  angle: 'the thing',
  mustEstablish: ['a fact'],
  queries: ['q'],
  likelyContested: [],
};

const format = (beatCount: number): EpisodeFormat =>
  ({
    id: 'f',
    name: 'F',
    kind: 'long',
    targetSeconds: [600, 720],
    loops: [],
    beats: Array.from({ length: beatCount }, (_, i) => ({
      id: `b${i}`,
      type: 'turn',
      seconds: [30, 60],
      function: 'x',
      constraints: [],
      minClaims: 1,
      optional: false,
    })),
    tensionCurve: Array.from({ length: beatCount }, () => 0.5),
  }) as unknown as EpisodeFormat;

/** Returns two claims per call, always numbered from c1 as a real one would. */
const writer = (): LlmClient & { seen: LlmRequest[] } => {
  const seen: LlmRequest[] = [];
  return {
    name: 'fake',
    model: 'test-model',
    seen,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      seen.push(req);
      return {
        text: JSON.stringify({
          claims: [1, 2].map((n) => ({
            id: `c${n}`,
            beatId: 'b0',
            text: `a fact numbered ${n}`,
            type: 'chronology',
            sourceId: 's1',
            quote: QUOTE,
            contested: false,
          })),
          unsupported: [],
        }),
        inputTokens: 10,
        outputTokens: 10,
        costPence: 1,
        model: 'test-model',
      };
    },
  };
};

describe('extractClaims', () => {
  it('splits the beats across several calls rather than asking for all of them', async () => {
    const w = writer();
    await extractClaims(brief, corpus, format(9), w);

    expect(w.seen).toHaveLength(Math.ceil(9 / BEATS_PER_EXTRACTION));
  });

  it('asks each call about ONLY its own beats', async () => {
    const w = writer();
    await extractClaims(brief, corpus, format(6), w);

    expect(w.seen[0]!.prompt).toContain('b0');
    expect(w.seen[0]!.prompt).not.toContain('b5');
    expect(w.seen[1]!.prompt).toContain('b5');
    expect(w.seen[1]!.prompt).not.toContain('b0');
  });

  it('RENUMBERS claims so two chunks cannot collide', async () => {
    // Every call starts counting at c1 because it cannot see the others. Two
    // claims sharing an id collide silently in the ledger, the later simply
    // replacing the earlier, and nothing downstream would report it.
    const out = await extractClaims(brief, corpus, format(6), writer());

    expect(out.claims.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(new Set(out.claims.map((c) => c.id)).size).toBe(out.claims.length);
  });

  it('sends the corpus in the CACHED system prefix, not the prompt', async () => {
    // The documents are the expensive half of this prompt and identical across
    // every chunk. Sending them in the prompt would have tripled the input cost
    // of the most input-heavy stage in the pipeline.
    const w = writer();
    await extractClaims(brief, corpus, format(6), w);

    for (const req of w.seen) {
      expect(req.system).toContain('DOCUMENT 1');
      expect(req.prompt).not.toContain('DOCUMENT 1');
      expect(req.cacheSystem).toBe(true);
    }
  });

  it('sends an IDENTICAL system prefix every time, or the cache never hits', async () => {
    const w = writer();
    await extractClaims(brief, corpus, format(9), w);

    const first = w.seen[0]!.system;
    for (const req of w.seen) expect(req.system).toBe(first);
  });

  it('keeps every unsupported note from every chunk', async () => {
    // Abstaining is a correct answer and is what sends the researcher back out,
    // so losing the notes from all but the last chunk would quietly turn a
    // thin corpus into a confident episode.
    const w = {
      name: 'fake',
      model: 'm',
      async complete(): Promise<LlmResponse> {
        return {
          text: JSON.stringify({
            claims: [],
            unsupported: [{ beatId: 'b0', text: 'nothing for this', attemptedQueries: [] }],
          }),
          inputTokens: 1,
          outputTokens: 1,
          costPence: 1,
          model: 'm',
        };
      },
    } as LlmClient;

    const out = await extractClaims(brief, corpus, format(6), w);
    expect(out.unsupported).toHaveLength(2);
  });

  it('reports every call it makes toward the budget', async () => {
    let spent = 0;
    await extractClaims(brief, corpus, format(9), writer(), (p) => (spent += p));
    expect(spent).toBe(Math.ceil(9 / BEATS_PER_EXTRACTION));
  });

  it('caps how many claims a beat may return', async () => {
    // Without a ceiling the model returns fifteen claims for one beat and the
    // reply runs past the token limit, which is how this whole problem
    // started.
    const w = writer();
    await extractClaims(brief, corpus, format(3), w);
    expect(w.seen[0]!.prompt).toMatch(/no more than 3/);
  });
});
