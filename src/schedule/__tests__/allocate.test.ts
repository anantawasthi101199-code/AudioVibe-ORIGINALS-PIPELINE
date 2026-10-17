/**
 * Laying approved episodes and shorts out across days (owner, 2026-10-17):
 * across the whole studio at most two episodes (never two of one series) and
 * three shorts (at most two from one channel) a day, each on the earliest day
 * with room from tomorrow.
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

const shorts = (n: number, channelId = 'a', over: Partial<Cadence> = {}): Allocatable[] =>
  Array.from({ length: n }, (_, i) => ({
    runId: `${channelId}-s${i + 1}`, kind: 'short' as const, channelId, series: `${channelId}#`, cadence: cadence(over),
  }));

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

const episodes = (n: number, series = 'a#one', over: Partial<Cadence> = {}): Allocatable[] =>
  Array.from({ length: n }, (_, i) => ({
    runId: `${series}-e${i + 1}`, kind: 'episode' as const, channelId: series.split('#')[0]!, series, cadence: cadence(over),
  }));

const short = (at: string, channelId = 'a'): Taken => ({ kind: 'short', at: new Date(at), channelId, series: `${channelId}#` });

const run = (items: Allocatable[], taken: Taken[] = []) => allocate({ items, taken, from: NOW, timezone: TZ });

const perDay = (out: { at: Date; kind: string }[]) => {
  const m = new Map<string, string[]>();
  for (const o of out) m.set(dayOf(o.at), [...(m.get(dayOf(o.at)) ?? []), o.kind]);
  return m;
};

describe('allocate: a studio-wide cap, earliest day with room first', () => {
  it('holds at most three shorts and two episodes a day across every channel', () => {
    const out = run([...shorts(6, 'a'), ...shorts(6, 'b'), ...shorts(6, 'c'), ...episodes(4, 'a#one'), ...episodes(4, 'b#two')]);
    for (const kinds of perDay(out).values()) {
      expect(kinds.filter((k) => k === 'short').length).toBeLessThanOrEqual(3);
      expect(kinds.filter((k) => k === 'episode').length).toBeLessThanOrEqual(2);
    }
    expect(perDay(out).get('2026-09-16')!.length).toBe(5);
  });

  it('never puts two episodes of one series on a day', () => {
    const out = run(episodes(3, 'a#one'));
    expect(new Set(out.map((o) => dayOf(o.at))).size).toBe(3);
  });

  it('lets two series of one channel share a day', () => {
    const out = run([...episodes(1, 'a#one'), ...episodes(1, 'a#two')]);
    expect(dayOf(out[0]!.at)).toBe(dayOf(out[1]!.at));
  });

  it('lets one channel have at most two shorts on a day', () => {
    const out = run(shorts(4, 'a'));
    expect(out.map((o) => dayOf(o.at))).toEqual(['2026-09-16', '2026-09-16', '2026-09-17', '2026-09-17']);
  });

  it('never lands today, or in the past', () => {
    for (const o of run([...shorts(3), ...episodes(2)])) {
      expect(dayOf(o.at)).not.toBe(dayOf(NOW));
      expect(o.at.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it('never puts two releases at the same hour on one day', () => {
    const out = run([...shorts(2, 'a'), ...shorts(1, 'b'), ...episodes(1, 'a#one'), ...episodes(1, 'b#two')]);
    for (const [date] of perDay(out)) {
      const hours = out.filter((o) => dayOf(o.at) === date).map((o) => hourOf(o.at));
      expect(new Set(hours).size).toBe(hours.length);
    }
  });

  it('KEEPS WHAT IS ALREADY APPROVED on any channel', () => {
    const taken = [short('2026-09-16T09:00:00Z', 'x'), short('2026-09-16T10:00:00Z', 'y'), short('2026-09-16T11:00:00Z', 'z')];
    expect(dayOf(run(shorts(1), taken)[0]!.at)).toBe('2026-09-17');
  });

  it('fills a gap before going later', () => {
    const full = (d: string) => ['x', 'y', 'z'].map((c, i) => short(`2026-09-${d}T0${i + 7}:00:00Z`, c));
    expect(dayOf(run(shorts(1), [...full('16'), ...full('18')])[0]!.at)).toBe('2026-09-17');
  });

  it('an episode is not held back by shorts on the same days', () => {
    expect(dayOf(run(episodes(1), [short('2026-09-16T10:00:00Z')])[0]!.at)).toBe('2026-09-16');
  });

  it('schedules a kind even when schedule.yaml plans none of it', () => {
    expect(run(episodes(1, 'a#one', { perWeek: { episodes: 0, shorts: 7 } }))).toHaveLength(1);
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
      items: [...shorts(1, 'a'), ...shorts(1, 'b'), ...shorts(1, 'c'), ...shorts(1, 'd')].map((s, i) => ({ ...s, runId: `s${i}` })),
      taken: [],
      from: new Date('2026-10-23T12:00:00Z'),
      timezone: TZ,
    });
    expect(out.map((o) => dayOf(o.at))).toEqual(['2026-10-24', '2026-10-24', '2026-10-24', '2026-10-25']);
  });
});
