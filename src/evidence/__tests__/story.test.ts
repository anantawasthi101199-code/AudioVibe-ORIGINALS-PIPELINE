/**
 * The single-story lane: choosing few documents, and reading all of them.
 *
 * WHAT THESE TESTS ARE PROTECTING, stated plainly, because every one of them
 * is a fault that reached a finished episode rather than an invented risk.
 *
 * The Descent of Inanna run fetched 585,396 characters across fourteen
 * documents and showed the extractor 13% of them, six thousand characters at a
 * time. The article that IS the story contributed six of forty-one facts,
 * behind a course handout, a general article about the underworld, and two
 * biographies. The answer to the episode's own central question - why the
 * judges found her guilty - sat at character 71,000 of a 98,191-character
 * document, under a heading reading "A guilty goddess", and was never seen.
 *
 * So: a cap that actually caps, a selector that cannot invent a document, a
 * fallback when it fails, and a reference the writer sees WITHOUT the
 * disagreements it resolved.
 */
import { LlmClient, LlmResponse } from '../../models/client';
import { Source } from '../source';
import {
  MAX_STORY_SOURCES,
  REFERENCE_CHARS_PER_SOURCE,
  Reference,
  referenceSchema,
  selectStorySources,
  topUpSelection,
} from '../story';

const source = (id: string, title: string, chars = 5_000, tier = 'T3'): Source =>
  ({
    id,
    url: `https://example.test/${id}`,
    title,
    retrievedAt: '2026-09-25T00:00:00.000Z',
    contentHash: id,
    tier,
    text: `${title}. `.repeat(Math.ceil(chars / (title.length + 2))).slice(0, chars),
    httpStatus: 200,
  }) as unknown as Source;

const replying = (text: string): LlmClient => ({
  name: 'test',
  model: 'test-model',
  async complete(): Promise<LlmResponse> {
    return {
      text,
      inputTokens: 0,
      outputTokens: 0,
      costPence: 0,
      model: 'test-model',
      cachedTokens: 0,
    } as unknown as LlmResponse;
  },
});

const failing = (): LlmClient => ({
  name: 'test',
  model: 'test-model',
  async complete(): Promise<LlmResponse> {
    throw new Error('the model is down');
  },
});

describe('selectStorySources', () => {
  const corpus = [
    source('s1', 'Descent of Inanna into the Underworld', 98_191),
    source('s2', 'Inanna', 163_683),
    source('s3', 'Sumer', 99_770),
    source('s4', 'Dumuzid', 56_991),
    source('s5', 'Ereshkigal', 23_790),
  ];

  it('keeps only what the selector chose', async () => {
    const picked = await selectStorySources(
      'Descent of Inanna',
      corpus,
      replying('{"chosen":["s1"],"reasoning":"one document is the whole story"}')
    );

    expect(picked.chosen.map((s) => s.id)).toEqual(['s1']);
    expect(picked.fellBack).toBe(false);
  });

  it('never returns more than the cap, however many the model names', async () => {
    const picked = await selectStorySources(
      'Descent of Inanna',
      corpus,
      // A model ignoring the cap is the case that matters: the cap is the
      // entire argument of this lane, and a prompt is not an enforcement.
      replying('{"chosen":["s1","s2","s3","s4","s5"],"reasoning":"all of them"}')
    );

    expect(picked.chosen.length).toBeLessThanOrEqual(MAX_STORY_SOURCES);
  });

  it('drops a source id that was never fetched', async () => {
    // THE SAME PROPERTY fetchSource gives the corpus, one level up. A model
    // that names a document is selecting, not creating, and an id that does
    // not resolve is an invention rather than a citation.
    const picked = await selectStorySources(
      'Descent of Inanna',
      corpus,
      replying('{"chosen":["s1","s99-does-not-exist"],"reasoning":"..."}')
    );

    expect(picked.chosen.map((s) => s.id)).toEqual(['s1']);
  });

  it('falls back to tier and length when the selector names nothing real', async () => {
    const picked = await selectStorySources(
      'Descent of Inanna',
      corpus,
      replying('{"chosen":["nope"],"reasoning":"..."}')
    );

    expect(picked.fellBack).toBe(true);
    expect(picked.chosen.length).toBe(MAX_STORY_SOURCES);
  });

  it('falls back rather than throwing when the model is down', async () => {
    // A corpus that has already been searched and fetched must not be thrown
    // away because one cheap judgement call failed.
    const picked = await selectStorySources('Descent of Inanna', corpus, failing());

    expect(picked.fellBack).toBe(true);
    expect(picked.chosen.length).toBe(MAX_STORY_SOURCES);
  });

  it('prefers a better tier over a longer document in the fallback', async () => {
    const mixed = [
      source('long-t3', 'A long secondary article', 100_000, 'T3'),
      source('short-t1', 'The primary translation', 9_000, 'T1'),
    ];
    const picked = await selectStorySources('anything', mixed, failing());

    expect(picked.chosen[0]!.id).toBe('short-t1');
  });

  it('does not call the model at all for a single document', async () => {
    const picked = await selectStorySources('anything', [corpus[0]!], failing());

    expect(picked.chosen.map((s) => s.id)).toEqual(['s1']);
    expect(picked.fellBack).toBe(false);
  });
});

describe('what the lane reads', () => {
  it('reads far more of each document than the ledger lane', () => {
    // The two numbers that are the whole argument. EXTRACT_CHARS_PER_SOURCE is
    // 6,000 and is applied to fourteen documents; this is applied to three.
    const ledgerLane = 6_000 * 14;
    const storyLane = REFERENCE_CHARS_PER_SOURCE * MAX_STORY_SOURCES;
    expect(storyLane).toBeGreaterThan(ledgerLane * 3);
  });

  it('reaches the passage that lost the Inanna answer', () => {
    // THE ASSERTION THIS WHOLE LANE IS FOR. The section headed "A guilty
    // goddess" begins at roughly character 71,000 of the 98,191-character
    // article, and answers the question the episode said the text did not
    // explain. The old keyhole stopped at 6,000.
    //
    // Anyone lowering this limit, or raising MAX_STORY_SOURCES to the point
    // where it has to come down, is putting that bug back.
    const whereTheAnswerWas = 71_000;
    const wholeArticle = 98_191;

    expect(REFERENCE_CHARS_PER_SOURCE).toBeGreaterThan(whereTheAnswerWas);
    expect(REFERENCE_CHARS_PER_SOURCE).toBeGreaterThanOrEqual(wholeArticle);
  });
});

describe('the reference article', () => {
  const full: Reference = referenceSchema.parse({
    subject: "Inanna's Descent",
    spine: 'She goes down, is judged, dies, is revived, and sends her husband in her place.',
    world: ['The underworld charges a toll in clothing at each of seven gates.'],
    cast: [{ name: 'Ereshkigal', who: "Inanna's older sister, who rules the dead", saidAloud: 'eh-RESH-kee-gal' }],
    sections: [{ heading: 'The descent', body: 'She gathered the seven me and set out.' }],
    glossary: [{ term: 'cuneiform', plainly: 'The oldest writing anybody has found.' }],
    ending: 'Dumuzi goes below, and his sister takes half the year in his place.',
    variants: [
      {
        about: 'whether the Ur fragment belongs to this poem',
        taken: 'treated as part of the same tradition',
        alsoSaid: 'Alster and Katz argue it is a separate composition',
      },
    ],
    gaps: ['The documents do not date the earliest tablet precisely.'],
  });

  it('keeps the disagreements it resolved', () => {
    // They are not discarded. A person reading the run can audit every choice
    // the fusion made - the point is only that the LISTENER does not hear it.
    expect(full.variants).toHaveLength(1);
    expect(full.variants[0]!.alsoSaid).toContain('Alster');
  });

  it('parses a reference that had no disagreements at all', () => {
    const plain = referenceSchema.parse({
      subject: 'x',
      spine: 'y',
      sections: [{ heading: 'a', body: 'b' }],
      ending: 'z',
    });
    expect(plain.variants).toEqual([]);
    expect(plain.glossary).toEqual([]);
  });

  it('refuses a reference with no ending', () => {
    // The closing beat is built from this field. An ending that is whatever
    // material happened to be left over is the exact fault the old `close`
    // beat was written to prevent and did not.
    expect(() =>
      referenceSchema.parse({
        subject: 'x',
        spine: 'y',
        sections: [{ heading: 'a', body: 'b' }],
      })
    ).toThrow();
  });
});

/**
 * Enough of the right document, not just the right one.
 *
 * THE RUN THAT FORCED THIS. Asked for the Amaterasu cave myth, the selector
 * chose a 6,518-character mythology blog and a 6,673-character article about
 * the cave site - 13,191 characters for an episode targeting ten to nineteen
 * minutes - and passed over the 91,094-character Amaterasu article it had
 * picked the day before. Its stated reasoning was correct on its own terms:
 * the blog "is a dedicated narrative telling of the myth from beginning to
 * end". It is. It is also a tenth of what fifteen minutes needs, and the
 * reference that came out of it had 9 sections against the previous run's 16.
 *
 * The prompt now says so, and this is the floor under it, because a prompt is
 * guidance and arithmetic is not.
 */
describe('topUpSelection', () => {
  const at = (id: string, chars: number, tier = 'T3') => source(id, id, chars, tier);
  const FIFTEEN_MIN = 900;

  it('leaves a selection that can carry the episode alone', () => {
    const big = [at('story', 91_094)];
    const out = topUpSelection(big, [...big, at('other', 40_000)], FIFTEEN_MIN);

    expect(out.added).toEqual([]);
    expect(out.chosen.map((s) => s.id)).toEqual(['story']);
  });

  it('tops up the real case that was too thin', () => {
    const blog = at('blog', 6_518);
    const site = at('site', 6_673);
    const full = at('amaterasu', 91_094);

    const out = topUpSelection([blog, site], [blog, site, full], FIFTEEN_MIN);

    expect(out.added.map((s) => s.id)).toEqual(['amaterasu']);
    expect(out.chosen.map((s) => s.id)).toEqual(['blog', 'site', 'amaterasu']);
  });

  it('never drops what the selector chose', () => {
    // The model's judgement about WHICH document tells the story is better than
    // any arithmetic. This only answers whether there is enough of it.
    const blog = at('blog', 6_518);
    const out = topUpSelection([blog], [blog, at('huge', 200_000)], FIFTEEN_MIN);

    expect(out.chosen[0]!.id).toBe('blog');
  });

  it('respects the source cap even when still short', () => {
    const tiny = [at('a', 2_000), at('b', 2_000)];
    const pool = [...tiny, at('c', 3_000), at('d', 3_000), at('e', 3_000)];
    const out = topUpSelection(tiny, pool, FIFTEEN_MIN);

    expect(out.chosen.length).toBeLessThanOrEqual(MAX_STORY_SOURCES);
  });

  it('prefers a better tier when topping up', () => {
    const thin = [at('thin', 3_000)];
    const pool = [thin[0]!, at('secondary', 60_000, 'T3'), at('primary', 30_000, 'T1')];
    const out = topUpSelection(thin, pool, FIFTEEN_MIN);

    expect(out.added[0]!.id).toBe('primary');
  });
})
