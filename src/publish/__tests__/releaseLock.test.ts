/**
 * The thing that stops two releasers publishing the same episode twice.
 *
 * THIS IS NOT A THEORETICAL RACE. "The Forging of Sudarshana" carries three
 * "published by operator" lines nine minutes apart and a publish artifact
 * naming only the last, because each write overwrote the one before. Adding a
 * second releaser - the scheduled task, beside the studio's own timer - makes
 * the same collision reachable without anybody pressing anything.
 */
import fs from 'fs';
import { LOCK_STALE_MS, lockPath, takeReleaseLock } from '../releaseLock';

const clear = () => fs.rmSync(lockPath(), { force: true });

beforeEach(clear);
afterEach(clear);

describe('taking the lock', () => {
  it('lets the first caller through', () => {
    const lock = takeReleaseLock();
    expect(lock).not.toBeNull();
    expect(fs.existsSync(lockPath())).toBe(true);
  });

  it('REFUSES THE SECOND while the first still holds it', () => {
    const first = takeReleaseLock();
    expect(first).not.toBeNull();

    // The whole point: the second caller is told to go away, rather than
    // publishing the episode the first one is uploading right now.
    expect(takeReleaseLock()).toBeNull();

    first!.release();
  });

  it('lets the next caller in once the first is done', () => {
    takeReleaseLock()!.release();
    expect(takeReleaseLock()).not.toBeNull();
  });

  it('removes the file on release', () => {
    takeReleaseLock()!.release();
    expect(fs.existsSync(lockPath())).toBe(false);
  });
});

describe('a lock left behind by a crash', () => {
  it('EXPIRES, rather than stopping every release for good', () => {
    // A machine shut down mid-upload leaves the file. A lock nobody can clear
    // would halt publishing permanently, and the only symptom would be that
    // nothing ever goes out again.
    const start = Date.now();
    takeReleaseLock(start);

    expect(takeReleaseLock(start + LOCK_STALE_MS - 1000)).toBeNull();
    expect(takeReleaseLock(start + LOCK_STALE_MS + 1000)).not.toBeNull();
  });

  it('expires one that is unreadable rather than treating it as permanent', () => {
    fs.writeFileSync(lockPath(), 'half a write');

    // Age falls back to the file's own mtime, so garbage still times out.
    expect(takeReleaseLock(Date.now() + LOCK_STALE_MS + 1000)).not.toBeNull();
  });

  it('is believed for long enough to cover a real upload', () => {
    // Shorter than the gap between triggers, longer than sending an episode.
    expect(LOCK_STALE_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(LOCK_STALE_MS).toBeLessThanOrEqual(15 * 60_000);
  });
});

describe('releasing somebody else lock', () => {
  it('DOES NOT DELETE A LOCK THAT IS NO LONGER OURS', () => {
    // After our own expired and another process took it, removing "the lock"
    // on the way out would hand a third caller the run being uploaded.
    const mine = takeReleaseLock();
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({ pid: process.pid + 1, host: 'elsewhere', at: new Date().toISOString() })
    );

    mine!.release();
    expect(fs.existsSync(lockPath())).toBe(true);
  });
});
