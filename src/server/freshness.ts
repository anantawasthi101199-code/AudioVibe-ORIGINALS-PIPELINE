/**
 * Whether the studio is running the code that is on disk.
 *
 * WHY THIS EXISTS. The studio is one long-lived ts-node process: it compiles
 * `src` once at boot and then keeps serving whatever it compiled. Edit a file,
 * rebuild, even commit - the running server does not care. It goes on executing
 * the version it started with, silently and indefinitely.
 *
 * That cost a real evening. A cover layout was fixed, tested, committed and
 * verified by rendering it; then an episode was published from a studio that
 * had been started before the fix, so it went out with the old artwork. The
 * conclusion drawn was that the fix had not worked, and the next hour was spent
 * looking at the code that was already correct.
 *
 * Nothing about that is discoverable from the interface, which is the whole
 * problem: the page looks exactly the same either way. So the studio compares
 * the newest source file against the moment it started, and says so.
 *
 * IT DOES NOT RESTART ITSELF. A server that reboots under somebody mid-run
 * would abandon a job that costs money. It reports; the person decides.
 */
import fs from 'fs';
import path from 'path';

/** When this process compiled what it is running. */
const STARTED_AT = Date.now();

const SRC = path.join(__dirname, '..');

/**
 * The newest modification time under `src`, in milliseconds.
 *
 * Walks rather than watches: this is asked once a minute by an interface, not
 * on a hot path, and a watcher would be a second thing to get wrong on a tree
 * that also contains the runs directory.
 */
const newestUnder = (dir: string, deadline: number): number => {
  let newest = 0;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    // A very large tree should not make the interface wait. Whatever has been
    // seen by the deadline is enough to answer the question.
    if (Date.now() > deadline) break;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      newest = Math.max(newest, newestUnder(full, deadline));
    } else if (entry.name.endsWith('.ts')) {
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {
        /* removed under us; not worth failing over */
      }
    }
  }

  return newest;
};

export interface Freshness {
  startedAt: string;
  /** True when a source file has been changed since this process compiled. */
  stale: boolean;
  /** The newest file, for a message that names something. */
  newestFile: string | null;
  changedAt: string | null;
}

export const freshness = (): Freshness => {
  const deadline = Date.now() + 250;
  const newest = newestUnder(SRC, deadline);

  // A second of slack: a file written in the same moment the server booted is
  // the file it compiled, not a change to it.
  const stale = newest > STARTED_AT + 1000;

  let newestFile: string | null = null;
  if (stale) {
    // Only walked again when the answer matters, which is rarely.
    const find = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          find(full);
        } else if (entry.name.endsWith('.ts')) {
          try {
            if (Math.abs(fs.statSync(full).mtimeMs - newest) < 1) {
              newestFile = path.relative(SRC, full).split(path.sep).join('/');
            }
          } catch {
            /* as above */
          }
        }
      }
    };
    find(SRC);
  }

  return {
    startedAt: new Date(STARTED_AT).toISOString(),
    stale,
    newestFile,
    changedAt: newest ? new Date(newest).toISOString() : null,
  };
};
