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
  shows: {
    'the-teardown': { everyDays: 3, shortsPerEpisode: 2, autoPublish: false },
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
    personas: input.personas ?? [persona('the-teardown')],
    history: (id) => input.history?.[id] ?? { episodes: [] },
    topicsQueued: (id) => input.topics?.[id] ?? 3,
    now: NOW,
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
      personaId: 'the-teardown',
      formatKind: 'long' as const,
      publishedAt: daysAgo(9),
    },
    {
      id: 'ep2',
      personaId: 'the-teardown',
      formatKind: 'long' as const,
      publishedAt: daysAgo(2),
    },
    {
      id: 'sh1',
      personaId: 'the-teardown',
      formatKind: 'short' as const,
      publishedAt: daysAgo(1),
      derivedFrom: 'ep2',
    },
    {
      id: 'gated',
      personaId: 'the-teardown',
      formatKind: 'long' as const,
      publishedAt: null,
    },
    { id: 'other', personaId: 'night-shift', formatKind: 'long' as const, publishedAt: daysAgo(1) },
  ];

  it('puts the newest episode first', () => {
    expect(historyFor('the-teardown', runs).episodes[0]!.runId).toBe('ep2');
  });

  it('IGNORES a run that was made but never published', () => {
    // Treating a gated-but-unpublished run as published is how a show goes
    // quiet while the schedule reports it as up to date.
    expect(historyFor('the-teardown', runs).episodes.map((e) => e.runId)).not.toContain('gated');
  });

  it('ignores other shows', () => {
    expect(historyFor('the-teardown', runs).episodes.map((e) => e.runId)).not.toContain('other');
  });

  it('counts shorts against the episode they were cut from', () => {
    const episodes = historyFor('the-teardown', runs).episodes;
    expect(episodes.find((e) => e.runId === 'ep2')!.shortsCut).toBe(1);
    expect(episodes.find((e) => e.runId === 'ep1')!.shortsCut).toBe(0);
  });
});

describe('buildPlan', () => {
  it('is due when a show has never published', () => {
    expect(plan({}).due[0]).toMatchObject({ personaId: 'the-teardown', kind: 'episode' });
  });

  it('is not due before the cadence has elapsed', () => {
    const history = { 'the-teardown': { episodes: [{ runId: 'a', publishedAt: daysAgo(1), shortsCut: 2 }] } };
    expect(plan({ history }).due).toEqual([]);
  });

  it('is due exactly on the cadence', () => {
    const history = { 'the-teardown': { episodes: [{ runId: 'a', publishedAt: daysAgo(3), shortsCut: 2 }] } };
    expect(plan({ history }).due[0]!.kind).toBe('episode');
  });

  it('STAYS due after a missed week, rather than waiting for the next slot', () => {
    // The reason this is arithmetic and not cron. A show that missed last week
    // is due NOW; cron would silently skip whenever the machine was off, a run
    // failed, or a gate rejected an episode.
    const history = { 'the-teardown': { episodes: [{ runId: 'a', publishedAt: daysAgo(17), shortsCut: 2 }] } };
    const item = plan({ history }).due[0]!;
    expect(item.kind).toBe('episode');
    expect(item.overdueDays).toBe(14);
  });

  it('puts the most overdue show first', () => {
    // A studio behind on several should catch up on the one that has been
    // waiting longest, not the one that sorts first.
    const personas = [persona('the-teardown'), persona('other')];
    const sched: Schedule = {
      paused: false,
      shows: {
        'the-teardown': { everyDays: 3, shortsPerEpisode: 0, autoPublish: false },
        other: { everyDays: 3, shortsPerEpisode: 0, autoPublish: false },
      },
    };
    const history = {
      'the-teardown': { episodes: [{ runId: 'a', publishedAt: daysAgo(4), shortsCut: 0 }] },
      other: { episodes: [{ runId: 'b', publishedAt: daysAgo(30), shortsCut: 0 }] },
    };

    expect(plan({ schedule: sched, personas, history }).due[0]!.personaId).toBe('other');
  });

  describe('shorts', () => {
    it('fills the days between episodes', () => {
      const history = { 'the-teardown': { episodes: [{ runId: 'a', publishedAt: daysAgo(1), shortsCut: 0 }] } };
      expect(plan({ history }).due[0]).toMatchObject({ kind: 'short', parentRunId: 'a' });
    });

    it("stops once the episode's quota is cut", () => {
      const history = { 'the-teardown': { episodes: [{ runId: 'a', publishedAt: daysAgo(1), shortsCut: 2 }] } };
      expect(plan({ history }).due).toEqual([]);
    });

    it('never competes with an episode that is due', () => {
      // A tick that made both would cut a short from an episode written minutes
      // earlier and publish them together, which wastes the short: its whole
      // job is to arrive on a different day and bring somebody back.
      const history = { 'the-teardown': { episodes: [{ runId: 'a', publishedAt: daysAgo(5), shortsCut: 0 }] } };
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
      const result = plan({ topics: { 'the-teardown': 0 } });
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
    expect(plan({ schedule: { ...schedule(), paused: true } })).toEqual({ due: [], blocked: [] });
  });

  it('plans nothing for a show that is not in the schedule', () => {
    const personas = [persona('the-teardown'), persona('unscheduled')];
    expect(plan({ personas }).due.map((d) => d.personaId)).toEqual(['the-teardown']);
  });
});
