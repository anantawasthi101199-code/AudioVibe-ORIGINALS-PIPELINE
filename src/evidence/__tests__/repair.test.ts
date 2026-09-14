/**
 * What happens to a claim its source will not carry.
 *
 * THIS FILE USED TO TEST A NARROWER, and the narrower is gone. It rewrote a
 * failing claim down to what its quote strictly supported, and over one
 * ten-story set the rewrites lost a proper noun ("Airavata was a four-tusked
 * white elephant" became "a four-tusked white elephant"), lost a causal link
 * ("turned blue AFTER consuming the poison" became "turned blue and"), produced
 * one claim about a different subject entirely, and in several cases changed
 * nothing but the word order. It cost a model call each time.
 *
 * What is left is narrow in a different sense: rebind if the corpus already
 * holds a passage that supports the claim AS WRITTEN, and otherwise drop it.
 * The judgement the narrower was making badly - "this says a little more than
 * its source does" - now belongs to the person who reads every script before a
 * word of it is voiced.
 */
import { Claim, claimSchema } from '../claim';
import { Source } from '../source';
import { Verification } from '../verify';
import { MIN_REBIND_SCORE, findBetterQuote, repairAll } from '../repair';

const source = (id: string, text: string): Source =>
  ({
    id,
    url: `https://example.test/${id}`,
    title: id,
    retrievedAt: '2026-09-12T00:00:00.000Z',
    contentHash: id,
    tier: 'T2',
    text,
    httpStatus: 200,
  }) as unknown as Source;

const claim = (over: Partial<Claim> = {}): Claim =>
  claimSchema.parse({
    id: 'c30',
    text: "John 'Kenny' Collins, Daniel Jones and Terry Perkins were each sentenced to seven years.",
    type: 'chronology',
    beatId: 'payoff',
    sourceId: 's1',
    quote: 'Three ringleaders behind the heist each received seven years.',
    ...over,
  });

const CONTRADICTED: Verification = {
  claimId: 'c30',
  verdict: 'contradicted',
  reason: 'The document says they were sentenced to six years, not seven.',
};

const UNSOURCED: Verification = {
  claimId: 'c30',
  verdict: 'unsourced',
  reason: 'cites a source that is not in the corpus',
};

const THIN = [source('s1', 'Three ringleaders behind the heist each received seven years.')];

/** A corpus that does name them, which is what rebinding is for. */
const FULL = [
  source('s1', 'Three ringleaders behind the heist each received seven years.'),
  source(
    's2',
    "The court sentenced John 'Kenny' Collins, Daniel Jones and Terry Perkins to seven years each " +
      'for their part in the burglary, with the judge noting the scale of the loss.'
  ),
];

const deps = (over: Partial<Parameters<typeof repairAll>[2]> = {}) => ({
  sources: THIN,
  reverify: async () => ({ verdict: 'entailed' as const, reason: 'yes' }),
  ...over,
});

describe('repairAll', () => {
  it('REBINDS to a source that supports the claim as written', async () => {
    // The only save left, and it mangles nothing: the claim is untouched, and
    // what changes is which document it points at.
    const { claims, report } = await repairAll(
      [claim()],
      [UNSOURCED],
      deps({ sources: FULL }) as never
    );

    expect(claims).toHaveLength(1);
    expect(claims[0]!.text).toBe(claim().text);
    expect(claims[0]!.sourceId).toBe('s2');
    expect(claims[0]!.status).toBe('verified');
    expect(report.repaired[0]!.method).toBe('rebound');
  });

  it('DROPS a claim nothing in the corpus supports', async () => {
    // It used to be rewritten down to what the thin quote allowed, losing the
    // three names. Now it is left out, and the beat is short by one fact -
    // which evidenceDensity reports as what it is.
    const { claims, report } = await repairAll([claim()], [UNSOURCED], deps() as never);

    expect(claims).toHaveLength(0);
    expect(report.repaired[0]!.method).toBe('abandoned');
  });

  it('DROPS a contradicted claim without going looking for a friendlier source', async () => {
    // Searching for a document that agrees, when one you already have says the
    // opposite, is cherry-picking with extra steps.
    const { claims, report } = await repairAll(
      [claim()],
      [CONTRADICTED],
      deps({ sources: FULL }) as never
    );

    expect(claims).toHaveLength(0);
    expect(report.repaired[0]!.method).toBe('abandoned');
    expect(report.repaired[0]!.wasReason).toMatch(/six years/);
  });

  it('never leaves a claim marked unverified, because nothing does that now', async () => {
    // A claim used to survive marked unverified with a hedge the script had to
    // speak, and the scripts became reports on what the sources say. Rebound or
    // gone, and nothing in between.
    const { claims } = await repairAll(
      [claim(), claim({ id: 'c31' })],
      [UNSOURCED],
      deps({ sources: FULL }) as never
    );

    expect(claims.every((c) => c.status !== 'unverified')).toBe(true);
  });

  it('does not touch a claim that passed', async () => {
    // Nothing is sent here unless it failed, and a model asked to improve a
    // good claim will change it.
    const { claims, report } = await repairAll([claim()], [], deps() as never);

    expect(claims[0]!.text).toBe(claim().text);
    expect(report.repaired).toHaveLength(0);
  });

  it('costs nothing when there is nothing to rebind to', async () => {
    // The whole stage used to be a model call per failing claim. Dropping is
    // free, and rebinding only pays when there is a candidate to re-check.
    const { report } = await repairAll([claim()], [UNSOURCED], deps() as never);
    expect(report.costPence).toBe(0);
  });
});

describe('findBetterQuote', () => {
  it('never re-tests the source the claim already failed against', () => {
    expect(findBetterQuote(claim(), THIN)).toBeNull();
  });

  it('finds the passage that carries the whole claim', () => {
    const better = findBetterQuote(claim(), FULL);
    expect(better?.sourceId).toBe('s2');
    expect(better?.quote).toMatch(/Collins/);
  });

  it('ignores a passage that shares almost nothing with the claim', () => {
    const unrelated = [source('s3', 'The weather in Hatton Garden that weekend was unremarkable.')];
    expect(findBetterQuote(claim(), unrelated)).toBeNull();
  });

  it('has a floor, so a weak overlap is not treated as evidence', () => {
    expect(MIN_REBIND_SCORE).toBeGreaterThan(0);
  });
});
