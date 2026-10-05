/**
 * Who is working on a run right now (owner, 2026-10-05).
 *
 * THREE PEOPLE SHARE ONE STUDIO. Opening a run holds it: anybody else sees who
 * has it and can read and listen, but cannot change it, and the server refuses
 * their edits too, so the rule does not depend on the page behaving.
 *
 * A HOLD ENDS THREE WAYS, so nobody can block a run by leaving a tab open:
 *   - leaving the page releases it at once (a beacon on page hide);
 *   - no heartbeat for STALE_MS (a crashed browser, a lost connection);
 *   - no real activity (click, key, scroll) for IDLE_MS, even with the page
 *     open and heartbeating. Activity picks it back up if nobody took it.
 *
 * IN MEMORY, DELIBERATELY. One studio process holds every hold; a restart
 * frees them all, which is the right answer after a restart anyway.
 */
export const HEARTBEAT_MS = 20_000;
/** Background tabs slow timers to about once a minute, so allow three. */
export const STALE_MS = 3 * 60_000;
export const IDLE_MS = 30 * 60_000;

interface Hold {
  who: string;
  since: number;
  lastSeen: number;
  lastActive: number;
}

const holds = new Map<string, Hold>();

const live = (h: Hold | undefined, now: number): Hold | null =>
  h && now - h.lastSeen < STALE_MS && now - h.lastActive < IDLE_MS ? h : null;

export interface HoldState {
  /** Who has it, or null when nobody does. */
  holder: string | null;
  mine: boolean;
  since: string | null;
}

const view = (h: Hold | null, who: string): HoldState => ({
  holder: h?.who ?? null,
  mine: h?.who === who,
  since: h ? new Date(h.since).toISOString() : null,
});

/**
 * Take or keep the hold. `active` says the person did something since the
 * last heartbeat; a heartbeat without activity keeps the hold alive but does
 * not reset the idle clock, which is the whole point of the idle rule.
 */
export const heartbeat = (runId: string, who: string, active: boolean, now = Date.now()): HoldState => {
  const current = live(holds.get(runId), now);
  if (current && current.who !== who) return view(current, who);
  if (!current && !active) {
    // Not held, and this person is idle: do not take it on their behalf.
    holds.delete(runId);
    return view(null, who);
  }
  const next: Hold = current
    ? { ...current, lastSeen: now, lastActive: active ? now : current.lastActive }
    : { who, since: now, lastSeen: now, lastActive: now };
  holds.set(runId, next);
  return view(next, who);
};

export const release = (runId: string, who: string): void => {
  if (holds.get(runId)?.who === who) holds.delete(runId);
};

/** Who holds it, for lists and for refusing an edit. */
export const holderOf = (runId: string, now = Date.now()): string | null => live(holds.get(runId), now)?.who ?? null;

/** The person to name when `who` may not edit this run, or null when they may. */
export const blockedBy = (runId: string, who: string, now = Date.now()): string | null => {
  const holder = holderOf(runId, now);
  return holder && holder !== who ? holder : null;
};

/** For tests. */
export const clearHolds = (): void => holds.clear();
