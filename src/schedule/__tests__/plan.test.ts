/**
 * What the studio should make right now.
 *
 * Every failure here is a show going quiet while something reports itself as
 * healthy, which is the specific thing a schedule exists to prevent. So what is
 * pinned is: a missed week stays missed until it is made up, a show with
 * nothing to cover is reported rather than skipped, and a run that was gated
 * but never published does not count as having published.
 */
import { Persona } from '../../canon/schema';
import { Schedule } from '../schema';
import { ShowHistory, buildPlan, daysBetween, historyFor } from '../plan';

const persona = (id: string, fiction = false): Persona =>
  ({ id, name: id, fiction, formats: ['f'] }) as Persona;

const NOW = new Date('2026-09-11T10:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const schedule = (over: Partial<Schedule['shows']> = {}): Schedule => ({
  paused: false,
  timezone: 'Europe/London',
  shows: {
    'business-teardowns': { everyDays: 3, shortsPerEpisode: 2, autoPublish: false },
    ...over,
  },
});

const plan = (input: {
  schedule?: Schedule;
  personas?: Persona[];
  history?: Record<string, ShowHistory>;
  topics?: Record<string, number>;
}) =>
  buildPlan({
    schedule: input.schedule ?? schedule(),
    personas: input.personas ?? [persona('business-teardowns')],
    history: (id) => input.history?.[id] ?? { episodes: [] },
    topicsQueued: (id) => input.topics?.[id] ?? 3,
    now: NOW,
  });


/** A published episode, with however many shorts have been cut from it. */
const ep = (publishedAt: Date, shortsCut = 0) => ({
  runId: 'ep1',
  publishedAt,
  shortsCut,
});

describe('daysBetween', () => {
  it('floors to whole days', () => {
    expect(daysBetween(daysAgo(3), NOW)).toBe(3);
    expect(daysBetween(new Date(NOW.getTime() - 1000), NOW)).toBe(0);
  });

  it('never goes negative', () => {
    // A publish timestamp in the future is a clock problem, and it must not
    // read as "published a very long time ago and wildly overdue".
    expect(daysBetween(new Date(NOW.getTime() + 86_400_000), NOW)).toBe(0);
  });
});

describe('historyFor', () => {
  const runs = [
    {
      id: 'ep1',
      personaId: 'business-teardowns',
      formatKind: 'long' as const,
      publishedAt: daysAgo(9),
    },
    {
      id: 'ep2',
      personaId: 'business-teardowns',
      formatKind: 'long' as const,
      publishedAt: daysAgo(2),
    },
    {
      id: 'sh1',
      personaId: 'business-teardowns',
      formatKind: 'short' as const,
      publishedAt: daysAgo(1),
      derivedFrom: 'ep2',
    },
    {
      id: 'gated',
      personaId: 'business-teardowns',
      formatKind: 'long' as const,
      publishedAt: null,
    },
    { id: 'other', personaId: 'night-shift', formatKind: 'long' as const, publishedAt: daysAgo(1) },
  ];

  it('puts the newest episode first', () => {
    expect(historyFor('business-teardowns', runs).episodes[0]!.runId).toBe('ep2');
  });

  it('IGNORES a run that was made but never published', () => {
    // Treating a gated-but-unpublished run as published is how a show goes
    // quiet while the schedule reports it as up to date.
    expect(historyFor('business-teardowns', runs).episodes.map((e) => e.runId)).not.toContain('gated');
  });

  it('ignores other shows', () => {
    expect(historyFor('business-teardowns', runs).episodes.map((e) => e.runId)).not.toContain('other');
  });

  it('counts shorts against the episode they were cut from', () => {
    const episodes = historyFor('business-teardowns', runs).episodes;
    expect(episodes.find((e) => e.runId === 'ep2')!.shortsCut).toBe(1);
    expect(episodes.find((e) => e.runId === 'ep1')!.shortsCut).toBe(0);
  });
});

describe('buildPlan', () => {
  it('is due when a show has never published', () => {
    expect(plan({}).due[0]).toMatchObject({ personaId: 'business-teardowns', kind: 'episode' });
  });

  it('is not due before the cadence has elapsed', () => {
    const history = { 'business-teardowns': { episodes: [{ runId: 'a', publishedAt: daysAgo(1), shortsCut: 2 }] } };
    expect(plan({ history }).due).toEqual([]);
  });

  it('is due exactly on the cadence', () => {
    const history = { 'business-teardowns': { episodes: [{ runId: 'a', publishedAt: daysAgo(3), shortsCut: 2 }] } };
    expect(plan({ history }).due[0]!.kind).toBe('episode');
  });

  it('STAYS due after a missed week, rather than waiting for the next slot', () => {
    // The reason this is arithmetic and not cron. A show that missed last week
    // is due NOW; cron would silently skip whenever the machine was off, a run
    // failed, or a gate rejected an episode.
    const history = { 'business-teardowns': { episodes: [{ runId: 'a', publishedAt: daysAgo(17), shortsCut: 2 }] } };
    const item = plan({ history }).due[0]!;
    expect(item.kind).toBe('episode');
    expect(item.overdueDays).toBe(14);
  });

  it('puts the most overdue show first', () => {
    // A studio behind on several should catch up on the one that has been
    // waiting longest, not the one that sorts first.
    const personas = [persona('business-teardowns'), persona('other')];
    const sched: Schedule = {
      paused: false,
      shows: {
        'business-teardowns': { everyDays: 3, shortsPerEpisode: 0, autoPublish: false },
        other: { everyDays: 3, shortsPerEpisode: 0, autoPublish: false },
      },
    };
    const history = {
      'business-teardowns': { episodes: [{ runId: 'a', publishedAt: daysAgo(4), shortsCut: 0 }] },
      other: { episodes: [{ runId: 'b', publishedAt: daysAgo(30), shortsCut: 0 }] },
    };

    expect(plan({ schedule: sched, personas, history }).due[0]!.personaId).toBe('other');
  });

  describe('shorts', () => {
    it('fills the days between episodes', () => {
      const history = { 'business-teardowns': { episodes: [{ runId: 'a', publishedAt: daysAgo(1), shortsCut: 0 }] } };
      expect(plan({ history }).due[0]).toMatchObject({ kind: 'short', parentRunId: 'a' });
    });

    it("stops once the episode's quota is cut", () => {
      const history = { 'business-teardowns': { episodes: [{ runId: 'a', publishedAt: daysAgo(1), shortsCut: 2 }] } };
      expect(plan({ history }).due).toEqual([]);
    });

    it('never competes with an episode that is due', () => {
      // A tick that made both would cut a short from an episode written minutes
      // earlier and publish them together, which wastes the short: its whole
      // job is to arrive on a different day and bring somebody back.
      const history = { 'business-teardowns': { episodes: [{ runId: 'a', publishedAt: daysAgo(5), shortsCut: 0 }] } };
      expect(plan({ history }).due.map((d) => d.kind)).toEqual(['episode']);
    });

    it('is never planned for a show that has published nothing', () => {
      expect(plan({}).due.every((d) => d.kind === 'episode')).toBe(true);
    });
  });

  describe('blockers', () => {
    it('REPORTS a show with an empty topic queue rather than skipping it', () => {
      // Skipping would let a show quietly stop publishing and report itself as
      // healthy, which is the exact failure this whole file exists to prevent.
      const result = plan({ topics: { 'business-teardowns': 0 } });
      expect(result.due).toEqual([]);
      expect(result.blocked[0]!.reason).toMatch(/topic queue is empty/);
    });

    it('does not ask a fiction show for topics', () => {
      // A serial's subject is the series. There is nothing to queue.
      const personas = [persona('night-shift', true)];
      const sched: Schedule = {
        paused: false,
        shows: { 'night-shift': { everyDays: 7, shortsPerEpisode: 0, autoPublish: false } },
      };
      const result = plan({ schedule: sched, personas, topics: { 'night-shift': 0 } });
      expect(result.due[0]!.kind).toBe('episode');
      expect(result.blocked).toEqual([]);
    });

    it('reports a schedule entry with no persona file', () => {
      // A typo that silently means "never publish this" is the worst kind.
      const sched: Schedule = {
        paused: false,
        shows: { 'the-teradown': { everyDays: 3, shortsPerEpisode: 0, autoPublish: false } },
      };
      expect(plan({ schedule: sched }).blocked[0]!.reason).toMatch(/no persona file/);
    });
  });

  it('plans nothing at all when paused', () => {
    expect(plan({ schedule: { ...schedule(), paused: true } })).toEqual({ due: [], blocked: [], waiting: [] });
  });

  it('plans nothing for a show that is not in the schedule', () => {
    const personas = [persona('business-teardowns'), persona('unscheduled')];
    expect(plan({ personas }).due.map((d) => d.personaId)).toEqual(['business-teardowns']);
  });
});

/**
 * Slots, which exist so a week's work does not arrive as one lump.
 *
 * NOW is Friday 11 September 2026, 10:00 UTC (11:00 in London).
 */
describe('publish slots', () => {
  const slotted = (over = {}) =>
    schedule({
      'business-teardowns': {
        everyDays: 7,
        shortsPerEpisode: 2,
        autoPublish: false,
        slot: { day: 'tue', hour: 8 },
        ...over,
      },
    });

  it('holds a show that is due until its slot comes round', () => {
    // Due by the arithmetic, but Tuesday has not arrived. Waiting, not blocked:
    // nothing is wrong and nobody has to do anything.
    const result = plan({
      schedule: slotted(),
      history: { 'business-teardowns': { episodes: [ep(daysAgo(8))] } },
    });

    expect(result.due).toEqual([]);
    expect(result.blocked).toEqual([]);
    expect(result.waiting).toHaveLength(1);
    expect(result.waiting[0]!.kind).toBe('episode');
    expect(result.waiting[0]!.reason).toContain('Tue 08:00');
    expect(result.waiting[0]!.at.toISOString()).toBe('2026-09-15T07:00:00.000Z');
  });

  it('does NOT push a missed slot into next week', () => {
    // THE FAILURE THE WHOLE FILE EXISTS TO PREVENT. This show came due last
    // Saturday, so its Tuesday slot passed three days ago while nothing was
    // running. It is overdue now, not due next Tuesday.
    const result = plan({
      schedule: slotted(),
      history: { 'business-teardowns': { episodes: [ep(daysAgo(13))] } },
    });

    expect(result.waiting).toEqual([]);
    expect(result.due).toHaveLength(1);
    expect(result.due[0]!.kind).toBe('episode');
    expect(result.due[0]!.overdueDays).toBe(3);
  });

  it('holds a show that has never published until its first slot', () => {
    // Launching five shows at once is exactly the batch a slot is for, so a
    // brand new show waits for its turn like every other.
    const result = plan({ schedule: slotted() });

    expect(result.due).toEqual([]);
    expect(result.waiting[0]!.at.toISOString()).toBe('2026-09-15T07:00:00.000Z');
  });

  it('leaves a show without a slot exactly as it was', () => {
    // Slots are optional, and adding the feature must not change a schedule
    // that did not ask for it.
    const result = plan({
      schedule: schedule({
        'business-teardowns': { everyDays: 7, shortsPerEpisode: 2, autoPublish: false },
      }),
      history: { 'business-teardowns': { episodes: [ep(daysAgo(8))] } },
    });

    expect(result.waiting).toEqual([]);
    expect(result.due[0]!.kind).toBe('episode');
    expect(result.due[0]!.overdueDays).toBe(1);
  });

  it('spreads shorts across the gap instead of cutting both at once', () => {
    // One day after the episode, neither short is due yet: they belong on day
    // 2 and day 5. Publishing both the morning after wastes the second.
    const dayAfter = plan({
      schedule: slotted(),
      history: { 'business-teardowns': { episodes: [ep(daysAgo(1), 0)] } },
    });
    expect(dayAfter.due).toEqual([]);
    expect(dayAfter.waiting[0]!.kind).toBe('short');
    expect(dayAfter.waiting[0]!.reason).toContain('day 2 after the episode');

    // On day 3, the first is due and the second is not.
    const first = plan({
      schedule: slotted(),
      history: { 'business-teardowns': { episodes: [ep(daysAgo(3), 0)] } },
    });
    expect(first.due).toHaveLength(1);
    expect(first.due[0]!.kind).toBe('short');
    expect(first.due[0]!.reason).toContain('short 1 of 2');

    // With the first already cut, the second still waits for day 5.
    const second = plan({
      schedule: slotted(),
      history: { 'business-teardowns': { episodes: [ep(daysAgo(3), 1)] } },
    });
    expect(second.due).toEqual([]);
    expect(second.waiting[0]!.reason).toContain('short 2 of 2');
  });

  it('never cuts a short on the day its own episode went out', () => {
    const sameDay = plan({
      schedule: slotted(),
      history: { 'business-teardowns': { episodes: [ep(daysAgo(0), 0)] } },
    });

    expect(sameDay.due).toEqual([]);
    expect(sameDay.waiting).toHaveLength(1);
  });

  it('orders what is coming up by when it happens', () => {
    const result = plan({
      schedule: {
        paused: false,
        timezone: 'Europe/London',
        shows: {
          'business-teardowns': {
            everyDays: 7,
            shortsPerEpisode: 0,
            autoPublish: false,
            slot: { day: 'sun', hour: 10 },
          },
          'honest-health': {
            everyDays: 7,
            shortsPerEpisode: 0,
            autoPublish: false,
            slot: { day: 'sat', hour: 9 },
          },
        },
      },
      personas: [persona('business-teardowns'), persona('honest-health')],
    });

    expect(result.waiting.map((w) => w.personaId)).toEqual([
      'honest-health',
      'business-teardowns',
    ]);
  });
});
