/**
 * Surviving a rate limit.
 *
 * A real run died on "Limit 3, Used 3" with thirty-four claims still to check,
 * after the corpus and the claims had already been paid for - and the API had
 * said in the same breath exactly how long to wait.
 */
import { MAX_WAIT_MS, isRetryable, waitFor, withRetry } from '../retry';

const noSleep = async () => undefined;

describe('isRetryable', () => {
  it('retries a rate limit', () => {
    expect(isRetryable(429)).toBe(true);
  });

  it('retries the provider being unwell', () => {
    expect(isRetryable(500)).toBe(true);
    expect(isRetryable(503)).toBe(true);
  });

  it('does NOT retry a bad request', () => {
    // The provider will refuse it identically forever. Retrying burns the
    // budget to arrive at the same answer more slowly.
    expect(isRetryable(400)).toBe(false);
  });

  it('does NOT retry a bad key', () => {
    expect(isRetryable(401)).toBe(false);
  });
});

describe('waitFor', () => {
  it('prefers the retry-after header over any curve', () => {
    // The provider knows when its window resets; a backoff curve is guessing.
    expect(waitFor(0, { 'retry-after': '20' })).toBe(20_500);
  });

  it('reads a delay stated in the error text', () => {
    // OpenAI puts the answer in the message and nowhere else.
    const body = 'Rate limit reached. Please try again in 20s. Visit ...';
    expect(waitFor(0, undefined, body)).toBe(20_500);
  });

  it('understands milliseconds', () => {
    expect(waitFor(0, undefined, 'try again in 800ms')).toBe(1300);
  });

  it('caps what it will wait for', () => {
    // A provider asking for an hour is one to come back to later, not to hold
    // a process open for.
    expect(waitFor(0, { 'retry-after': '3600' })).toBe(MAX_WAIT_MS);
  });

  it('backs off exponentially when the provider says nothing', () => {
    const first = waitFor(0);
    const later = waitFor(3);
    expect(later).toBeGreaterThan(first);
  });

  it('jitters, so simultaneous calls do not wake together', () => {
    // Without it, several calls rate-limited at once all retry at the same
    // instant and hit the same wall again.
    const samples = new Set(Array.from({ length: 20 }, () => waitFor(2)));
    expect(samples.size).toBeGreaterThan(1);
  });

  it('ignores a nonsense header rather than waiting forever', () => {
    expect(waitFor(0, { 'retry-after': 'soon' })).toBeGreaterThan(0);
  });
});

describe('withRetry', () => {
  const attempts = (statuses: number[]) => {
    let i = 0;
    const calls: number[] = [];
    return {
      calls,
      run: async () => {
        const status = statuses[Math.min(i++, statuses.length - 1)]!;
        calls.push(status);
        return { status, text: '' };
      },
    };
  };

  it('returns a success without retrying', async () => {
    const a = attempts([200]);
    const out = await withRetry(a.run, { sleepFor: noSleep });
    expect(out.status).toBe(200);
    expect(a.calls).toHaveLength(1);
  });

  it('retries a rate limit until it clears', async () => {
    const a = attempts([429, 429, 200]);
    const out = await withRetry(a.run, { sleepFor: noSleep });
    expect(out.status).toBe(200);
    expect(a.calls).toEqual([429, 429, 200]);
  });

  it('gives up after a bounded number of attempts', async () => {
    const a = attempts([429]);
    const out = await withRetry(a.run, { sleepFor: noSleep, attempts: 3 });
    expect(out.status).toBe(429);
    expect(a.calls).toHaveLength(3);
  });

  it('does NOT retry a 400', async () => {
    const a = attempts([400]);
    await withRetry(a.run, { sleepFor: noSleep });
    expect(a.calls).toHaveLength(1);
  });

  it('returns the failure rather than throwing', async () => {
    // The caller already knows how to turn a bad status into its own error
    // with its own message; duplicating that here would give two different
    // errors for one failure depending on how often it happened.
    const out = await withRetry(attempts([500]).run, { sleepFor: noSleep, attempts: 2 });
    expect(out.status).toBe(500);
  });

  it('ANNOUNCES the wait', async () => {
    // A run that goes silent for two minutes is indistinguishable from a hang,
    // and the reasonable response to a hang is to kill it - which on a rate
    // limit is the one wrong move.
    const said: string[] = [];
    await withRetry(attempts([429, 200]).run, {
      sleepFor: noSleep,
      onWait: (m) => said.push(m),
    });

    expect(said[0]).toMatch(/rate limited/);
    expect(said[0]).toMatch(/waiting \d+s/);
  });

  it('says which kind of failure it is waiting on', async () => {
    const said: string[] = [];
    await withRetry(attempts([503, 200]).run, {
      sleepFor: noSleep,
      onWait: (m) => said.push(m),
    });
    expect(said[0]).toMatch(/provider error 503/);
  });
});
