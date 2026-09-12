/**
 * Two-pass verification: a cheap screen, then the real verifier for anything
 * it does not settle.
 *
 * ONE PROPERTY MATTERS MORE THAN THE SAVING, and every test here is about it:
 * the screen can only ever CONFIRM a clean pass. It cannot block, it cannot
 * overrule, and it cannot be the reason something wrong was published. Anything
 * it is unsure about, disagrees with, or garbles goes to the strong model,
 * which owns the decision.
 */
import { Claim } from '../claim';
import { Source } from '../source';
import { LlmClient, LlmResponse } from '../../models/client';
import { verifyAll } from '../verify';

const source = (): Source =>
  ({
    id: 's1',
    url: 'https://www.gov.uk/a',
    title: 'A Record',
    tier: 'T1',
    text: 'x',
    contentHash: 'a'.repeat(64),
    retrievedAt: '2026-09-11T00:00:00.000Z',
    httpStatus: 200,
  }) as Source;

const claim = (id: string): Claim => ({
  id,
  beatId: 'mechanism',
  type: 'chronology',
  text: `a fact numbered ${id}`,
  sourceId: 's1',
  quote: 'q'.repeat(50),
  contested: false,
});

/** Answers with a fixed verdict, and counts how often it was asked. */
const judge = (name: string, verdict: string | ((n: number) => string)) => {
  const client = {
    name,
    model: `${name}-model`,
    calls: 0,
    async complete(): Promise<LlmResponse> {
      client.calls++;
      const v = typeof verdict === 'function' ? verdict(client.calls) : verdict;
      return {
        text: v === '(garbage)' ? 'not json at all' : `{"verdict":"${v}","reason":"r"}`,
        inputTokens: 1,
        outputTokens: 1,
        costPence: name === 'screener' ? 0.1 : 1,
        model: `${name}-model`,
      };
    },
  };
  return client as LlmClient & { calls: number };
};

const claims = [claim('c1'), claim('c2'), claim('c3')];

describe('screened verification', () => {
  it('does not ask the strong model about a claim the screen passes cleanly', async () => {
    const screener = judge('screener', 'entailed');
    const verifier = judge('verifier', 'entailed');

    const report = await verifyAll(claims, [source()], verifier, undefined, screener);

    expect(screener.calls).toBe(3);
    expect(verifier.calls).toBe(0);
    expect(report.blocking).toEqual([]);
  });

  it('ESCALATES anything the screen does not mark plainly entailed', async () => {
    const screener = judge('screener', 'partially_entailed');
    const verifier = judge('verifier', 'entailed');

    await verifyAll(claims, [source()], verifier, undefined, screener);

    expect(screener.calls).toBe(3);
    expect(verifier.calls).toBe(3);
  });

  it('ESCALATES rather than blocking when the screen says contradicted', async () => {
    // The screen has no authority to block. If it could, a cheap model's bad
    // day would fail an episode that is fine, and the obvious response to that
    // is to switch the screen off - which loses the saving entirely.
    const screener = judge('screener', 'contradicted');
    const verifier = judge('verifier', 'entailed');

    const report = await verifyAll(claims, [source()], verifier, undefined, screener);

    expect(verifier.calls).toBe(3);
    expect(report.blocking).toEqual([]);
  });

  it('ESCALATES when the screen returns something unparseable', async () => {
    const screener = judge('screener', '(garbage)');
    const verifier = judge('verifier', 'entailed');

    const report = await verifyAll(claims, [source()], verifier, undefined, screener);

    expect(verifier.calls).toBe(3);
    expect(report.results.every((r) => r.verdict === 'entailed')).toBe(true);
  });

  it('lets the STRONG model block even when the screen was happy to pass', async () => {
    // The half that actually protects the episode: the screen passing is not a
    // decision, it is an absence of doubt, and doubt is what escalates.
    const screener = judge('screener', (n) => (n === 2 ? 'not_entailed' : 'entailed'));
    const verifier = judge('verifier', 'contradicted');

    const report = await verifyAll(claims, [source()], verifier, undefined, screener);

    expect(verifier.calls).toBe(1);
    expect(report.blocking.map((b) => b.claimId)).toEqual(['c2']);
  });

  it('names the STRONG model as the verifier, never the screen', async () => {
    // A Sources sheet saying an episode was checked by the screen would be
    // claiming it was checked by something that can only ever have agreed.
    const report = await verifyAll(
      claims,
      [source()],
      judge('verifier', 'entailed'),
      undefined,
      judge('screener', 'entailed')
    );
    expect(report.verifierModel).toBe('verifier-model');
  });

  it('behaves exactly as before when there is no screen', async () => {
    const verifier = judge('verifier', 'entailed');
    const report = await verifyAll(claims, [source()], verifier);

    expect(verifier.calls).toBe(3);
    expect(report.results).toHaveLength(3);
  });

  it('still refuses a claim citing a source that is not in the corpus', async () => {
    // Deterministic, and it must not become reachable through the screen.
    const screener = judge('screener', 'entailed');
    const verifier = judge('verifier', 'entailed');

    const report = await verifyAll([claim('c9')], [], verifier, undefined, screener);

    expect(screener.calls).toBe(0);
    expect(verifier.calls).toBe(0);
    expect(report.blocking[0]!.reason).toMatch(/not in the corpus/);
  });

  describe('checkpointing', () => {
    // Verification is the slowest stage whenever a rate limit is tight:
    // thirty-five claims at three requests a minute is twelve minutes, and a
    // real run lost all of it to a 429 on the first claim.

    it('saves after every claim', async () => {
      const saves: number[] = [];
      await verifyAll(claims, [source()], judge('verifier', 'entailed'), undefined, undefined,
        undefined, { done: {}, save: (d) => saves.push(Object.keys(d).length) });

      expect(saves).toEqual([1, 2, 3]);
    });

    it('RESUMES rather than re-checking what was already settled', async () => {
      const verifier = judge('verifier', 'entailed');
      await verifyAll(claims, [source()], verifier, undefined, undefined, undefined, {
        done: {
          c1: { claimId: 'c1', verdict: 'entailed', reason: 'settled earlier' },
          c2: { claimId: 'c2', verdict: 'entailed', reason: 'settled earlier' },
        },
        save: () => undefined,
      });

      expect(verifier.calls).toBe(1);
    });

    it('keeps a BLOCKING verdict reached by an earlier attempt', async () => {
      // Resuming must not quietly downgrade a claim that already failed.
      const report = await verifyAll(
        claims,
        [source()],
        judge('verifier', 'entailed'),
        undefined,
        undefined,
        undefined,
        {
          done: { c2: { claimId: 'c2', verdict: 'contradicted', reason: 'settled earlier' } },
          save: () => undefined,
        }
      );

      expect(report.blocking.map((b) => b.claimId)).toEqual(['c2']);
    });

    it('is keyed by CLAIM ID, not by position', async () => {
      // Unlike beats and chunks, where position is identity. A verdict belongs
      // to a specific claim, and claims can be re-extracted in a different
      // order - a verdict recovered onto the wrong claim would be worse than
      // none, because it would look like a real one.
      const verifier = judge('verifier', 'entailed');
      await verifyAll(
        [claim('c3'), claim('c1'), claim('c2')],
        [source()],
        verifier,
        undefined,
        undefined,
        undefined,
        {
          done: { c1: { claimId: 'c1', verdict: 'entailed', reason: 'earlier' } },
          save: () => undefined,
        }
      );

      expect(verifier.calls).toBe(2);
    });
  });

  it('counts every call it makes toward the budget', async () => {
    // Both passes cost money, and a budget that only counted the expensive one
    // would let a screened run overspend without the ceiling noticing.
    let spent = 0;
    await verifyAll(
      claims,
      [source()],
      judge('verifier', 'entailed'),
      (p) => (spent += p),
      judge('screener', 'not_entailed')
    );

    // Three screens at 0.1 plus three escalations at 1.
    expect(spent).toBeCloseTo(3.3);
  });
});
