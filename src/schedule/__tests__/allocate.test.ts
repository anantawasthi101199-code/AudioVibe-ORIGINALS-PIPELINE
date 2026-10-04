/**
 * Laying approved episodes out across weeks.
 *
 * THE CEILING IS THE WHOLE POINT, so most of this is about what does NOT
 * happen: eight shorts do not go out in eight days for a show that does three
 * a week, a channel with no capacity for a kind gets no day for it at all, and
 * nothing lands today.
 */
import { allocate, daysFor, weekStart, type Allocatable } from '../allocate';
import type { Cadence } from '../schema';

const TZ = 'Europe/London';

const cadence = (over: Partial<Cadence> = {}): Cadence => ({
  everyDays: 7,
  shortsPerEpisode: 0,
  autoPublish: false,
  slot: { day: 'tue', hour: 8 },
  perWeek: { episodes: 1, shorts: 3 },
  ...over,
});

const shorts = (n: number): Allocatable[] =>
  Array.from({ length: n }, (_, i) => ({ runId: `s${i + 1}`, kind: 'short' as const }));

/** Tuesday 15 September 2026, mid-afternoon. */
const NOW = new Date('2026-09-15T14:00:00Z');

const dayOf = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const hourOf = (d: Date) =>
  Number(d.toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }));

describe('weekStart', () => {
  it('is the Monday of that week', () => {
    // Monday, because the calendar draws Monday-first and "three a week" has to
    // mean the same week in the arithmetic and in the grid.
    expect(dayOf(weekStart(new Date('2026-09-15T14:00:00Z'), TZ))).toBe('2026-09-14');
    expect(dayOf(weekStart(new Date('2026-09-20T22:00:00Z'), TZ))).toBe('2026-09-14');
    expect(dayOf(weekStart(new Date('2026-09-21T00:30:00Z'), TZ))).toBe('2026-09-21');
  });

  it('counts the week in the zone, not in UTC', () => {
    // 23:00 UTC on Sunday is already midnight Monday in London, so it belongs
    // to the NEXT week. Bucketing by UTC would put a Monday morning release in
    // the week that just ended and let a channel publish four in a week that
    // allows three.
    expect(dayOf(weekStart(new Date('2026-09-20T23:00:00Z'), TZ))).toBe('2026-09-21');
    expect(dayOf(weekStart(new Date('2026-09-20T23:00:00Z'), 'UTC'))).toBe('2026-09-14');
  });
});

describe('daysFor', () => {
  it('puts the episode on the channel slot day', () => {
    // The day a follower learns to expect it, so it does not move.
    expect(daysFor(cadence(), 'episode', 1)).toEqual([1]); // Tuesday
  });

  it('keeps shorts off the episode day', () => {
    const days = daysFor(cadence(), 'short', 3);
    expect(days).not.toContain(1);
    expect(new Set(days).size).toBe(3);
  });

  it('spreads shorts after the episode, not from Monday', () => {
    // Tuesday episode: Thursday, Saturday, Sunday (Monday-based indices).
    expect(daysFor(cadence(), 'short', 3)).toEqual([3, 5, 6]);
    // Thursday episode: Saturday, Monday, Tuesday.
    expect(daysFor(cadence({ slot: { day: 'thu', hour: 19 } }), 'short', 3)).toEqual([5, 0, 1]);
    // No episodes: all seven days.
    expect(new Set(daysFor(cadence({ perWeek: { episodes: 0, shorts: 7 } }), 'short', 7)).size).toBe(7);
  });
});

describe('allocate', () => {
  it('SPREADS EIGHT SHORTS ACROSS THREE WEEKS for a three-a-week channel', () => {
    // The ceiling doing its job. Eight approved at once is not eight days of
    // publishing; a cadence is a promise to somebody who follows the show.
    const out = allocate({
      cadence: cadence(),
      items: shorts(8),
      taken: [],
      from: NOW,
      timezone: TZ,
    });

    expect(out).toHaveLength(8);

    const weeks = new Map<string, number>();
    for (const o of out) {
      const w = dayOf(weekStart(o.at, TZ));
      weeks.set(w, (weeks.get(w) ?? 0) + 1);
    }

    expect(weeks.size).toBe(3);
    for (const n of weeks.values()) expect(n).toBeLessThanOrEqual(3);
  });

  it('never gives two of a channel the same day', () => {
    const out = allocate({
      cadence: cadence(),
      items: shorts(8),
      taken: [],
      from: NOW,
      timezone: TZ,
    });

    const days = out.map((o) => dayOf(o.at));
    expect(new Set(days).size).toBe(days.length);
  });

  it('never lands today', () => {
    // A batch approved this afternoon publishing an hour later is the same
    // burst in miniature, and nobody has listened to it yet.
    const out = allocate({
      cadence: cadence(),
      items: shorts(3),
      taken: [],
      from: NOW,
      timezone: TZ,
    });

    for (const o of out) {
      expect(dayOf(o.at)).not.toBe(dayOf(NOW));
      expect(o.at.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it('COUNTS WHAT IS ALREADY APPROVED, so a second approval does not double-book', () => {
    const existing = allocate({
      cadence: cadence(),
      items: shorts(3),
      taken: [],
      from: NOW,
      timezone: TZ,
    });

    const more = allocate({
      cadence: cadence(),
      items: [{ runId: 'extra', kind: 'short' }],
      taken: existing.map((e) => ({ kind: 'short' as const, at: e.at })),
      from: NOW,
      timezone: TZ,
    });

    expect(more).toHaveLength(1);
    // The first week is full, so it goes into the next one.
    expect(weekStart(more[0]!.at, TZ).getTime()).toBeGreaterThan(
      weekStart(existing[0]!.at, TZ).getTime()
    );
  });

  it('gives no day at all to a kind the channel does not publish', () => {
    // Night Shift publishes no shorts: a short cut from a serial either spoils
    // it or makes no sense out of order. Zero must mean zero rather than one.
    const out = allocate({
      cadence: cadence({ perWeek: { episodes: 1, shorts: 0 } }),
      items: shorts(4),
      taken: [],
      from: NOW,
      timezone: TZ,
    });

    expect(out).toEqual([]);
  });

  it('keeps the hours civilised and varied', () => {
    // A channel posting at exactly its slot hour every time reads as a machine
    // even when the writing does not.
    const out = allocate({
      cadence: cadence(),
      items: shorts(8),
      taken: [],
      from: NOW,
      timezone: TZ,
    });

    const hours = out.map((o) => hourOf(o.at));
    for (const h of hours) {
      expect(h).toBeGreaterThanOrEqual(8);
      expect(h).toBeLessThan(18);
    }
    expect(new Set(hours).size).toBeGreaterThan(3);
  });

  it('comes back in the order it will go out', () => {
    const out = allocate({
      cadence: cadence(),
      items: shorts(8),
      taken: [],
      from: NOW,
      timezone: TZ,
    });

    const times = out.map((o) => o.at.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('puts an episode on its slot day and shorts around it', () => {
    const out = allocate({
      cadence: cadence(),
      items: [{ runId: 'ep', kind: 'episode' }, ...shorts(2)],
      taken: [],
      from: NOW,
      timezone: TZ,
    });

    const episode = out.find((o) => o.runId === 'ep')!;
    // Tuesday.
    expect(new Date(episode.at).toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short' })).toBe(
      'Tue'
    );

    for (const s of out.filter((o) => o.kind === 'short')) {
      expect(dayOf(s.at)).not.toBe(dayOf(episode.at));
    }
  });
});
