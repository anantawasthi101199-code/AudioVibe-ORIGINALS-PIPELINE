/**
 * Laying approved episodes and shorts out across days (owner, 2026-10-08):
 * at most one short and one episode a day per channel, each on the earliest
 * free day from tomorrow, rolling into the next week when a week is full.
 */
import { allocate, weekStart, type Allocatable, type Taken } from '../allocate';
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

const episodes = (n: number): Allocatable[] =>
  Array.from({ length: n }, (_, i) => ({ runId: `e${i + 1}`, kind: 'episode' as const }));

const run = (items: Allocatable[], taken: Taken[] = [], over: Partial<Cadence> = {}) =>
  allocate({ cadence: cadence(over), items, taken, from: NOW, timezone: TZ });

describe('allocate: one of each kind a day, earliest free day first', () => {
  it('puts approved shorts on consecutive days from tomorrow, one a day', () => {
    const out = run(shorts(8));
    expect(out.map((o) => dayOf(o.at))).toEqual([
      '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19',
      '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23',
    ]);
  });

  it('never lands today, or in the past', () => {
    for (const o of run([...shorts(3), ...episodes(2)])) {
      expect(dayOf(o.at)).not.toBe(dayOf(NOW));
      expect(o.at.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it('lets a short and an episode share a day, at different hours, but never two of one kind', () => {
    const out = run([...shorts(3), ...episodes(3)]);
    const byDay = new Map<string, string[]>();
    for (const o of out) byDay.set(dayOf(o.at), [...(byDay.get(dayOf(o.at)) ?? []), o.kind]);
    for (const kinds of byDay.values()) {
      expect(kinds.filter((k) => k === 'short').length).toBeLessThanOrEqual(1);
      expect(kinds.filter((k) => k === 'episode').length).toBeLessThanOrEqual(1);
    }
    expect([...byDay.values()].every((k) => k.length === 2)).toBe(true);
    const tomorrow = out.filter((o) => dayOf(o.at) === '2026-09-16');
    expect(new Set(tomorrow.map((o) => hourOf(o.at))).size).toBe(2);
  });

  it('KEEPS WHAT IS ALREADY APPROVED, and a full week sends the next one to the week after', () => {
    // Shorts on every day of next week (Mon 21 to Sun 27) and the rest of this one.
    const taken: Taken[] = Array.from({ length: 12 }, (_, i) => ({
      kind: 'short' as const,
      at: new Date(Date.UTC(2026, 8, 16 + i, 10)),
    }));
    const [next] = run(shorts(1), taken);
    expect(dayOf(next!.at)).toBe('2026-09-28'); // the Monday after
  });

  it('fills a gap before going later', () => {
    const taken: Taken[] = [
      { kind: 'short', at: new Date('2026-09-16T10:00:00Z') },
      { kind: 'short', at: new Date('2026-09-18T10:00:00Z') },
    ];
    expect(dayOf(run(shorts(1), taken)[0]!.at)).toBe('2026-09-17');
  });

  it('an episode is not held back by shorts on the same days', () => {
    const taken: Taken[] = [{ kind: 'short', at: new Date('2026-09-16T10:00:00Z') }];
    expect(dayOf(run(episodes(1), taken)[0]!.at)).toBe('2026-09-16');
  });

  it('schedules a kind even when schedule.yaml plans none of it', () => {
    expect(run(episodes(1), [], { perWeek: { episodes: 0, shorts: 7 } })).toHaveLength(1);
  });

  it('puts the episode at the channel slot hour and keeps the short hours civilised', () => {
    const out = run([...shorts(10), ...episodes(1)]);
    expect(hourOf(out.find((o) => o.kind === 'episode')!.at)).toBe(8);
    for (const o of out) {
      expect(hourOf(o.at)).toBeGreaterThanOrEqual(8);
      expect(hourOf(o.at)).toBeLessThanOrEqual(19);
    }
    expect(new Set(out.filter((o) => o.kind === 'short').map((o) => hourOf(o.at))).size).toBeGreaterThan(3);
  });

  it('comes back in the order it will go out', () => {
    const out = run([...episodes(2), ...shorts(2)]);
    const times = out.map((o) => o.at.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('counts days in the zone across the clock change', () => {
    // British Summer Time ends on Sunday 25 October 2026.
    const out = allocate({
      cadence: cadence(),
      items: shorts(4),
      taken: [],
      from: new Date('2026-10-23T12:00:00Z'),
      timezone: TZ,
    });
    expect(out.map((o) => dayOf(o.at))).toEqual(['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
  });
});
