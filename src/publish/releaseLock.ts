/**
 * One releaser at a time, across processes.
 *
 * WHY THIS IS NEEDED AND WAS NOT BEFORE. `dueForRelease` already skips
 * anything `isComplete('publish')`, and while the studio's timer was the only
 * releaser that was enough. It is not enough with two: the studio checks every
 * five minutes and the scheduled task every fifteen, and the completion flag is
 * only written AFTER an upload finishes. Between reading the plan and recording
 * the result there is a window several seconds wide - an audio file is being
 * sent over the network - in which both see the same run as unpublished and
 * both publish it.
 *
 * THAT IS NOT HYPOTHETICAL HERE. "The Forging of Sudarshana" has three
 * "published by operator" lines in its journal within nine minutes, and its
 * publish artifact records only the last, because each write overwrote the one
 * before. Two of those uploads are untracked by this studio.
 *
 * A FILE, NOT A MUTEX, because the two contenders are separate processes that
 * never speak: `npm run foundry -- release` under Task Scheduler and the studio
 * server. An exclusive create is atomic on Windows and POSIX alike, which is
 * the whole requirement.
 *
 * IT EXPIRES. A machine that is shut down mid-publish leaves the file behind,
 * and a lock nobody can clear would stop every future release with no way to
 * notice except that nothing ever publishes again. Better to risk a duplicate
 * after a crash than to silently stop for good.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { repoRoot } from '../config';

/**
 * How long a held lock is believed.
 *
 * Comfortably longer than an upload of a long episode and comfortably shorter
 * than the gap between triggers, so a crash costs one missed slot rather than
 * every slot after it.
 */
export const LOCK_STALE_MS = 10 * 60_000;

export const lockPath = (): string => path.join(repoRoot(), '.release.lock');

/** Who holds it, so a stale one can be reported rather than just deleted. */
interface Holder {
  pid: number;
  host: string;
  at: string;
}

const readHolder = (file: string): Holder | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Holder;
  } catch {
    // Unreadable or half-written. Treated as present but unidentifiable, which
    // the age check below still resolves.
    return null;
  }
};

const age = (file: string, now: number): number => {
  const holder = readHolder(file);
  const at = holder ? Date.parse(holder.at) : NaN;
  if (Number.isFinite(at)) return now - at;

  try {
    return now - fs.statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
};

export interface Lock {
  release: () => void;
}

/**
 * Take the release lock, or null if somebody else has it.
 *
 * Null is an ordinary outcome, not an error: it means another releaser is
 * already doing the thing this one was about to do, and the right response is
 * to go back to sleep.
 */
export const takeReleaseLock = (now = Date.now()): Lock | null => {
  const file = lockPath();

  const claim = (): Lock | null => {
    try {
      // 'wx' fails if it exists. That failure IS the lock.
      fs.writeFileSync(
        file,
        JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date(now).toISOString() }),
        { flag: 'wx' }
      );
    } catch {
      return null;
    }

    return {
      release: () => {
        try {
          // Only if it is still ours. Deleting somebody else's lock after our
          // own expired is how a crash turns into a double publish later.
          const holder = readHolder(file);
          if (!holder || holder.pid === process.pid) fs.rmSync(file, { force: true });
        } catch {
          // A lock that cannot be removed expires on its own.
        }
      },
    };
  };

  const first = claim();
  if (first) return first;

  if (age(file, now) < LOCK_STALE_MS) return null;

  // Stale. Clear it and try exactly once more; if that loses, another process
  // cleared it first and is now holding it, which is the correct outcome.
  try {
    fs.rmSync(file, { force: true });
  } catch {
    return null;
  }
  return claim();
};
