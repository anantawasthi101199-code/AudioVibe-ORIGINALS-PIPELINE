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

  it('treats an ABSENT unsupported array as an empty one', async () => {
    // A model asked for claims and anything it could not support omits
    // "unsupported" entirely when there was nothing it could not support. One
    // did exactly that, on the last chunk of a real run, after the first three
    // had succeeded and been paid for.
    const w = {
      name: 'fake',
      model: 'm',
      async complete(): Promise<LlmResponse> {
        return {
          text: JSON.stringify({ claims: [] }),
          inputTokens: 1,
          outputTokens: 1,
          costPence: 1,
          model: 'm',
        };
      },
    } as LlmClient;

    const out = await extractClaims(brief, corpus, format(3), w);
    expect(out.unsupported).toEqual([]);
  });

  it('names the beats when the extractor returns something unusable', async () => {
    // A bare Zod path with no context does not tell you which of four chunks
    // failed, or what the model actually said.
    const w = {
      name: 'fake',
      model: 'm',
      async complete(): Promise<LlmResponse> {
        return {
          text: JSON.stringify({ claims: 'not an array' }),
          inputTokens: 1,
          outputTokens: 1,
          costPence: 1,
          model: 'm',
        };
      },
    } as LlmClient;

    await expect(extractClaims(brief, corpus, format(3), w)).rejects.toThrow(/b0, b1, b2/);
  });

  describe('checkpointing', () => {
    // Each chunk is thousands of tokens over a corpus that had to be searched
    // and fetched first. A real run lost three of four chunks because the
    // fourth came back in an unexpected shape.

    it('saves after every chunk', async () => {
      const saves: number[] = [];
      await extractClaims(brief, corpus, format(9), writer(), undefined, undefined, {
        done: [],
        save: (d) => saves.push(d.length),
      });
      expect(saves).toEqual([1, 2, 3]);
    });

    it('RESUMES rather than re-extracting what already succeeded', async () => {
      const alreadyDone = [
        { claims: [], unsupported: [] },
        { claims: [], unsupported: [] },
      ];
      const w = writer();

      await extractClaims(brief, corpus, format(9), w, undefined, undefined, {
        done: alreadyDone,
        save: () => undefined,
      });

      // Three chunks in total, two already done, so exactly one call.
      expect(w.seen).toHaveLength(1);
    });

    it('keeps the claims the earlier chunks produced', async () => {
      const alreadyDone = [
        {
          claims: [
            {
              id: 'c1',
              beatId: 'b0',
              text: 'an earlier fact',
              type: 'chronology' as const,
              sourceId: 's1',
              quote: QUOTE,
              contested: false,
            },
          ],
          unsupported: [],
        },
      ];

      const out = await extractClaims(brief, corpus, format(6), writer(), undefined, undefined, {
        done: alreadyDone,
        save: () => undefined,
      });

      expect(out.claims[0]!.text).toBe('an earlier fact');
      // Still renumbered across the whole run, resumed chunks included.
      expect(out.claims.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    });

    it('ignores a checkpoint holding more chunks than this format has', async () => {
      // A checkpoint from a longer format would otherwise skip real work and
      // leave beats with no claims at all.
      const tooMany = Array.from({ length: 9 }, () => ({ claims: [], unsupported: [] }));
      const w = writer();

      await extractClaims(brief, corpus, format(3), w, undefined, undefined, {
        done: tooMany,
        save: () => undefined,
      });

      expect(w.seen).toHaveLength(0);
    });
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
