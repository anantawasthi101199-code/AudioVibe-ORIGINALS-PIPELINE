/**
 * Surviving a rate limit.
 *
 * WHY THIS IS NOT OPTIONAL. Every provider rate-limits, and a pipeline that
 * makes thirty-five calls in a row will meet one. A real run hit "Limit 3,
 * Used 3" on the verifier and died with thirty-four claims still to check,
 * after the corpus and the claims had been paid for - and the API had said in
 * the same breath exactly how long to wait.
 *
 * WHAT IS RETRIED, AND WHAT IS NOT. Only failures that are about TIMING: 429,
 * and the 5xx family, which are the provider saying "not now" rather than "not
 * this". A 400 is a request the provider will refuse identically forever, and
 * retrying it burns the budget to arrive at the same answer more slowly. A 401
 * is a key problem. Neither gets a second attempt.
 *
 * THE WAIT IS ANNOUNCED. A run that goes silent for two minutes is
 * indistinguishable from a hang, and the reasonable response to a hang is to
 * kill it - which on a rate limit is exactly the wrong move, because the thing
 * it was waiting for was about to arrive.
 */

/** Failures that are about timing rather than about the request. */
export const isRetryable = (status: number): boolean => status === 429 || status >= 500;

/**
 * How long to wait, preferring what the provider actually said.
 *
 * A `retry-after` header, or a delay named in the error text, beats any backoff
 * curve: the provider knows when its window resets and a guess does not. The
 * exponential fallback is for providers that say nothing.
 *
 * Capped, because a provider that asks for an hour is a provider you should
 * come back to later rather than hold a process open for.
 */
export const MAX_WAIT_MS = 75_000;

export const waitFor = (
  attempt: number,
  headers?: Record<string, string>,
  body?: string
): number => {
  const header = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000 + 500, MAX_WAIT_MS);
    }
  }

  // Providers often put the answer in the message and nowhere else:
  // "Please try again in 20s."
  const stated = /try again in ([\d.]+)\s*(ms|s|m)\b/i.exec(body ?? '');
  if (stated) {
    const value = Number(stated[1]);
    const unit = stated[2]!.toLowerCase();
    const ms = unit === 'ms' ? value : unit === 'm' ? value * 60_000 : value * 1000;
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms + 500, MAX_WAIT_MS);
  }

  // Exponential, with jitter. The jitter matters when several calls are
  // rate-limited together: without it they all wake at the same instant and
  // hit the same wall again.
  const base = Math.min(2000 * 2 ** attempt, MAX_WAIT_MS);
  return Math.round(base * (0.75 + Math.random() * 0.5));
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Replace the wait, for tests.
 *
 * A TEST SEAM, AND A DELIBERATE ONE. Retries happen four layers below anything
 * a test constructs, so without this every test that exercises a 429 or a 502
 * waits out a real backoff - which is both slow and a good way to end up
 * weakening the tests to statuses that are not retried, testing the wrong
 * thing to keep the suite fast.
 */
let sleepOverride: ((ms: number) => Promise<void>) | null = null;

export const setSleep = (fn: ((ms: number) => Promise<void>) | null): void => {
  sleepOverride = fn;
};

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  onWait?: (message: string) => void;
  /** Injected so tests do not actually wait. */
  sleepFor?: (ms: number) => Promise<void>;
}

export interface AttemptResult {
  status: number;
  headers?: Record<string, string>;
  text: string;
}

/**
 * Run a request, retrying the failures that are worth retrying.
 *
 * Returns the last attempt whatever it was, rather than throwing: the caller
 * already knows how to turn a bad status into its own error with its own
 * message, and duplicating that here would produce two different errors for the
 * same failure depending on how many times it happened.
 */
export const withRetry = async <T extends AttemptResult>(
  attempt: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> => {
  const attempts = opts.attempts ?? 4;
  const doSleep = opts.sleepFor ?? sleepOverride ?? sleep;

  let last: T = await attempt();

  for (let n = 0; n < attempts - 1; n++) {
    if (!isRetryable(last.status)) return last;

    const ms = waitFor(n, last.headers, last.text);
    opts.onWait?.(
      `${last.status === 429 ? 'rate limited' : `provider error ${last.status}`}, ` +
        `waiting ${Math.round(ms / 1000)}s (attempt ${n + 2} of ${attempts})`
    );

    await doSleep(ms);
    last = await attempt();
  }

  return last;
};
