/**
 * The gap is the real one. An episode produced a claim saying Arnold Paole was
 * bothering people at night and no claim saying who he was, so the writer could
 * either use a name it could not place or drop him.
 */
import { Claim, claimSchema } from '../claim';
import { Source } from '../source';
import { fillGaps, findGaps, passagesAbout } from '../gaps';
import { LlmClient } from '../../models/client';

const claim = (text: string, over: Partial<Claim> = {}): Claim =>
  claimSchema.parse({
    id: 'c1',
    text,
    type: 'attribution',
    beatId: 'story',
    sourceId: 's1',
    quote: 'x'.repeat(50),
    ...over,
  });

const source = (id: string, text: string): Source =>
  ({
    id,
    url: `https://example.test/${id}`,
    title: id,
    retrievedAt: '2026-09-13T00:00:00.000Z',
    contentHash: id,
    tier: 'T2',
    text,
    httpStatus: 200,
  }) as unknown as Source;

describe('findGaps', () => {
  it('finds a name the claims use and never introduce', () => {
    const gaps = findGaps([
      claim('Arnold Paole fell from a haywagon and broke his neck.'),
      claim('Four people said Arnold Paole had bothered them at night.', { id: 'c2' }),
    ]);
    expect(gaps.map((g) => g.name)).toContain('Paole');
  });

  it('says nothing about a name that IS introduced', () => {
    const gaps = findGaps([
      claim('Arnold Paole was a hajduk on the Habsburg military frontier.'),
      claim('Arnold Paole fell from a haywagon.', { id: 'c2' }),
    ]);
    expect(gaps.map((g) => g.name)).not.toContain('Paole');
  });

  it('wants the introduction NEAR the name, not merely in the same claim', () => {
    // "Medvegia was a garrison, and Paole died there" introduces Medvegia and
    // says nothing about Paole. A check that looked at the whole claim would
    // count him as placed.
    const gaps = findGaps([
      claim('Medvegia was a garrison village, and Paole was buried in its churchyard.'),
    ]);
    expect(gaps.map((g) => g.name)).toContain('Paole');
    expect(gaps.map((g) => g.name)).not.toContain('Medvegia');
  });

  it('ranks the names the episode leans on hardest first', () => {
    // A name carrying six claims costs the listener six sentences.
    const gaps = findGaps([
      claim('Flueckinger examined the body.'),
      claim('Flueckinger signed the report.', { id: 'c2' }),
      claim('Flueckinger sent it to Belgrade.', { id: 'c3' }),
      claim('Glaser had been there first.', { id: 'c4' }),
    ]);
    expect(gaps[0]!.name).toBe('Flueckinger');
    expect(gaps[0]!.mentions).toBe(3);
  });

  it('ignores months, days and the obvious places', () => {
    // "July, the seventh month" is a claim worse than nothing.
    const gaps = findGaps([claim('In July the villagers went to England and asked the King.')]);
    expect(gaps).toEqual([]);
  });
});

describe('passagesAbout', () => {
  it('only returns passages that actually contain the name', () => {
    const sources = [
      source('s1', 'The frontier was quiet that year. Nothing of note was recorded anywhere.'),
      source('s2', 'Arnold Paole, a hajduk, had served on the Turkish frontier before returning home.'),
    ];
    const found = passagesAbout('Paole', sources);
    expect(found).toHaveLength(1);
    expect(found[0]!.sourceId).toBe('s2');
  });

  it('returns nothing when the corpus never mentions the name', () => {
    expect(passagesAbout('Blagojevic', [source('s1', 'A quiet year on the frontier.')])).toEqual([]);
  });
});

describe('fillGaps', () => {
  const SOURCES = [
    source('s2', 'Arnold Paole, a hajduk, had served on the Turkish frontier before returning home.'),
  ];

  const model = (reply: unknown): LlmClient =>
    ({
      name: 'fake',
      model: 'm',
      async complete() {
        return {
          text: JSON.stringify(reply),
          inputTokens: 1,
          outputTokens: 1,
          costPence: 1,
          model: 'm',
        };
      },
    }) as unknown as LlmClient;

  it('turns a gap into a verified claim', async () => {
    const filled = await fillGaps(
      [{ name: 'Paole', mentions: 3 }],
      {
        sources: SOURCES,
        model: model({
          found: true,
          text: 'Arnold Paole was a hajduk.',
          sourceId: 's2',
          quote: 'Arnold Paole, a hajduk, had served on the Turkish frontier',
        }),
        verify: async () => true,
      },
      'world',
      1
    );

    expect(filled).toHaveLength(1);
    expect(filled[0]!.text).toMatch(/hajduk/);
    expect(filled[0]!.beatId).toBe('world');
    expect(filled[0]!.id).toBe('g1');
  });

  it('THROWS NOTHING AWAY BUT KEEPS NOTHING UNVERIFIED', async () => {
    // A gap-filling claim answers to the same verifier as every other claim.
    // Nothing here is a back door.
    const filled = await fillGaps(
      [{ name: 'Paole', mentions: 3 }],
      {
        sources: SOURCES,
        model: model({ found: true, text: 'x', sourceId: 's2', quote: 'y' }),
        verify: async () => false,
      },
      'world',
      1
    );
    expect(filled).toEqual([]);
  });

  it('accepts "the documents do not say" as an answer', async () => {
    const filled = await fillGaps(
      [{ name: 'Paole', mentions: 3 }],
      { sources: SOURCES, model: model({ found: false }), verify: async () => true },
      'world',
      1
    );
    expect(filled).toEqual([]);
  });

  it('does not call the model at all when the corpus never mentions the name', async () => {
    let called = false;
    const spy = {
      name: 'fake',
      model: 'm',
      async complete() {
        called = true;
        throw new Error('should not be reached');
      },
    } as unknown as LlmClient;

    await fillGaps(
      [{ name: 'Blagojevic', mentions: 2 }],
      { sources: SOURCES, model: spy, verify: async () => true },
      'world',
      1
    );
    expect(called).toBe(false);
  });

  it('survives a model that throws, rather than losing the episode', async () => {
    const broken = {
      name: 'fake',
      model: 'm',
      async complete() {
        throw new Error('provider is down');
      },
    } as unknown as LlmClient;

    await expect(
      fillGaps(
        [{ name: 'Paole', mentions: 3 }],
        { sources: SOURCES, model: broken, verify: async () => true },
        'world',
        1
      )
    ).resolves.toEqual([]);
  });
});
