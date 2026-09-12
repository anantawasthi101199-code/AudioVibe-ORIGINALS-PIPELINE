/**
 * The three routes, driven by the real failures from run 20260912-143125.
 *
 * That episode named six men and gave sentences for two, because the claim
 * carrying the other four was binned for saying more than its quote. The point
 * of this stage is that the SEVEN YEARS survives even when the three names
 * cannot.
 */
import { Claim, claimSchema } from '../claim';
import { Source } from '../source';
import { Verification } from '../verify';
import {
  MIN_REBIND_SCORE,
  findBetterQuote,
  hedgeFor,
  repairAll,
  wasDrained,
  unhedgedClaims,
} from '../repair';
import { LlmClient } from '../../models/client';

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

const FAILURE: Verification = {
  claimId: 'c30',
  verdict: 'not_entailed',
  reason:
    "The quote says only that three ringleaders each got seven years without naming John 'Kenny' Collins, Daniel Jones, or Terry Perkins.",
};

/** A narrower that returns whatever the test tells it to. */
const narrower = (reply: unknown): LlmClient =>
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

describe('repairAll', () => {
  const SOURCES = [source('s1', 'Three ringleaders behind the heist each received seven years.')];

  it('NARROWS a claim to what the quote supports, keeping the fact', () => {
    // The whole point. The names go, the seven years stays, and the payoff beat
    // still gets to account for the sentences.
    return repairAll([claim()], [FAILURE], {
      sources: SOURCES,
      narrower: narrower({
        keep: true,
        text: 'Three of the ringleaders were each sentenced to seven years.',
        type: 'chronology',
        lost: 'which three men they were',
      }),
      reverify: async () => ({ claimId: 'c30', verdict: 'entailed', reason: 'ok' }),
    }).then(({ claims, report }) => {
      expect(claims[0]!.text).toBe('Three of the ringleaders were each sentenced to seven years.');
      expect(claims[0]!.status).toBe('verified');
      expect(claims[0]!.narrowedFrom).toContain('Kenny');
      expect(report.repaired[0]!.method).toBe('narrowed');
    });
  });

  it('re-checks the narrowed claim with the SAME verifier that rejected it', async () => {
    // A repair judged by a softer standard than the rejection is a repair that
    // means nothing. If the narrowing does not pass, it is not accepted.
    const { claims, report } = await repairAll([claim()], [FAILURE], {
      sources: SOURCES,
      narrower: narrower({ keep: true, text: 'Still says too much.', type: 'chronology', lost: 'the names' }),
      reverify: async () => ({ claimId: 'c30', verdict: 'partially_entailed', reason: 'no' }),
    });

    expect(report.repaired[0]!.method).toBe('unverified');
    expect(claims[0]!.status).toBe('unverified');
  });

  it('REBINDS to another source that supports the claim whole', async () => {
    const sources = [
      SOURCES[0]!,
      source(
        's2',
        'Collins, Jones and Perkins were each sentenced to seven years for the burglary at Hatton Garden. ' +
          'The court heard that the three had planned it over several months.'
      ),
    ];

    let call = 0;
    const { claims, report } = await repairAll([claim()], [FAILURE], {
      sources,
      // Narrowing declines, so the rebind route is the one under test.
      narrower: narrower({ keep: false, text: '', lost: 'the names' }),
      reverify: async () => {
        call++;
        return { claimId: 'c30', verdict: 'entailed', reason: 'ok' };
      },
    });

    expect(report.repaired[0]!.method).toBe('rebound');
    expect(claims[0]!.sourceId).toBe('s2');
    expect(claims[0]!.text).toContain('Kenny');
    expect(call).toBe(1);
  });

  it('KEEPS an unrepairable claim with a hedge the script must say', async () => {
    const { claims } = await repairAll([claim()], [FAILURE], {
      sources: SOURCES,
      narrower: narrower({ keep: false, text: '', lost: 'which three men they were' }),
      reverify: async () => ({ claimId: 'c30', verdict: 'not_entailed', reason: 'no' }),
    });

    expect(claims[0]!.status).toBe('unverified');
    expect(claims[0]!.hedge).toContain('which three men they were');
    // Phrased as speech, because its whole purpose is to reach the listener.
    expect(claims[0]!.hedge).toMatch(/record does not settle/);
  });

  it('keeps the narrowed wording even when the narrowing was not enough', async () => {
    // A claim trimmed to what its quote supports is the better sentence even
    // when the trim did not pass; the hedge then covers what came off.
    const { claims } = await repairAll([claim()], [FAILURE], {
      sources: SOURCES,
      narrower: narrower({
        keep: true,
        text: 'Three of the ringleaders were each sentenced to seven years.',
        type: 'chronology',
        lost: 'which three',
      }),
      reverify: async () => ({ claimId: 'c30', verdict: 'partially_entailed', reason: 'no' }),
    });

    expect(claims[0]!.text).toContain('Three of the ringleaders');
    expect(claims[0]!.status).toBe('unverified');
  });

  it('does not touch a claim that passed', async () => {
    // A model asked to improve a good claim will change it.
    const good = claim({ id: 'c1', text: 'The vault was opened over the Easter weekend.' });
    const { claims, report } = await repairAll([good], [], {
      sources: SOURCES,
      narrower: narrower({ keep: true, text: 'CHANGED', lost: '' }),
      reverify: async () => ({ claimId: 'c1', verdict: 'entailed', reason: 'ok' }),
    });

    expect(claims[0]!.text).toBe('The vault was opened over the Easter weekend.');
    expect(report.repaired).toHaveLength(0);
  });

  it('survives a narrower that throws, rather than losing the claim', async () => {
    const broken = {
      name: 'fake',
      model: 'm',
      async complete() {
        throw new Error('provider is down');
      },
    } as unknown as LlmClient;

    const { claims } = await repairAll([claim()], [FAILURE], {
      sources: SOURCES,
      narrower: broken,
      reverify: async () => ({ claimId: 'c30', verdict: 'not_entailed', reason: 'no' }),
    });

    expect(claims[0]!.status).toBe('unverified');
  });
});

describe('findBetterQuote', () => {
  it('never re-tests the source the claim already failed against', () => {
    // If that document supported the claim, the extractor would have found it.
    const only = [source('s1', 'Three ringleaders behind the heist each received seven years.')];
    expect(findBetterQuote(claim(), only)).toBeNull();
  });

  it('ignores a passage that shares almost nothing with the claim', () => {
    const unrelated = [
      source('s1', 'x'),
      source('s2', 'The weather over the bank holiday was unseasonably warm across southern England.'),
    ];
    expect(findBetterQuote(claim(), unrelated)).toBeNull();
    expect(MIN_REBIND_SCORE).toBeGreaterThan(0);
  });
});

describe('hedgeFor', () => {
  it('reads as something a narrator can say out loud', () => {
    expect(hedgeFor('which three men they were')).toBe(
      'the record does not settle which three men they were, and the script must say so'
    );
  });

  it('still says something useful when nothing specific was recorded', () => {
    expect(hedgeFor('  ')).toMatch(/does not settle this/);
  });
});

describe('a claim the source contradicts', () => {
  it('is DROPPED, not kept as unsettled', async () => {
    // The hedge route is for what the record does not decide. This is the
    // record deciding against you, and "the record does not settle whether the
    // alarm was answered" would be a lie about a document that says plainly it
    // was not.
    const contradicted: Verification = {
      claimId: 'c30',
      verdict: 'contradicted',
      reason: 'The quote says the alarm WAS answered.',
    };

    const { claims, report } = await repairAll([claim()], [contradicted], {
      sources: [source('s1', 'Three ringleaders behind the heist each received seven years.')],
      narrower: narrower({ keep: false, text: '', lost: '' }),
      reverify: async () => ({ claimId: 'c30', verdict: 'contradicted', reason: 'no' }),
    });

    expect(claims).toHaveLength(0);
    expect(report.repaired[0]!.method).toBe('abandoned');
  });
});

describe('unhedgedClaims', () => {
  const unsettled = claim({ status: 'unverified', hedge: 'the record does not settle which three' });

  it('catches a beat stating an unsettled claim as fact', () => {
    const beats = [
      { beatId: 'payoff', claimIds: ['c30'], text: 'Three of them were each sentenced to seven years.' },
    ];
    expect(unhedgedClaims(beats, [unsettled])).toHaveLength(1);
  });

  it('accepts any wording that tells the listener it is not settled', () => {
    // The gate checks that the uncertainty REACHED THE LISTENER, not that a
    // particular sentence was copied out. A gate demanding exact wording turns
    // an honest admission into a formula, and the formula stops meaning
    // anything by the third episode.
    for (const text of [
      'Three of them got seven years each. Nobody wrote down which three.',
      'Seven years each, though the record does not say which of the six.',
      'Three of them, at least, were sentenced to seven years.',
    ]) {
      expect(unhedgedClaims([{ beatId: 'payoff', claimIds: ['c30'], text }], [unsettled])).toEqual(
        []
      );
    }
  });

  it('says nothing about a verified claim stated flatly, which is the normal case', () => {
    const beats = [{ beatId: 'payoff', claimIds: ['c30'], text: 'They were sentenced.' }];
    expect(unhedgedClaims(beats, [claim()])).toEqual([]);
  });
});

describe('wasDrained - narrowing that removes the facts instead of the over-reach', () => {
  const BEFORE = "Collins, Jones and Perkins were each sentenced to seven years.";

  it('catches a narrowing that retreats into vagueness', () => {
    // Perfectly true, perfectly verifiable, and worth nothing to a listener who
    // cannot look anything up. Worse than the original failure, because it
    // passes: the rejected claim at least announced itself.
    expect(wasDrained(BEFORE, 'Some of the men were sentenced.')).toBe(true);
    expect(wasDrained(BEFORE, 'A number of those involved received prison terms.')).toBe(true);
  });

  it('accepts a narrowing that keeps the count and the length', () => {
    // What the listener asked for: the names go, everything the quote carries
    // stays, and the sentence still lands in the story.
    expect(
      wasDrained(BEFORE, 'Three of the six ringleaders were each sentenced to seven years in prison.')
    ).toBe(false);
  });

  it('accepts a hedging word when the specifics survived alongside it', () => {
    // "Some of" is only a symptom when the numbers and names went with it.
    expect(
      wasDrained(BEFORE, 'Some of the six were sentenced to seven years in prison.')
    ).toBe(false);
  });

  it('says nothing about a narrowing with no hedging word at all', () => {
    expect(wasDrained(BEFORE, 'The ringleaders were sentenced.')).toBe(false);
  });
});

describe('repairAll refuses a drained narrowing', () => {
  it('falls through to unsettled rather than accepting a claim worth nothing', async () => {
    const { claims, report } = await repairAll([claim()], [FAILURE], {
      sources: [source('s1', 'Three ringleaders behind the heist each received seven years.')],
      narrower: narrower({
        keep: true,
        text: 'Some of the men were sentenced.',
        type: 'chronology',
        lost: 'which of them, and for how long',
      }),
      // Would have passed, which is exactly the danger.
      reverify: async () => ({ claimId: 'c30', verdict: 'entailed', reason: 'ok' }),
    });

    expect(claims[0]!.text).not.toMatch(/Some of the men/);
    expect(report.repaired[0]!.method).toBe('unverified');
  });
});
