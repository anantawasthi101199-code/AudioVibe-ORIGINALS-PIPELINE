/**
 * Giving approved episodes a day and an hour, within what a channel can hold.
 *
 * A CHANNEL HAS A CAPACITY, AND IT IS THE POINT. A show that puts out one
 * episode and three shorts a week puts out one episode and three shorts a week:
 * approving twelve shorts does not make twelve go out on twelve days, it fills
 * the next four weeks. A studio that published everything the moment it was
 * ready would be a studio whose output is decided by how fast the pipeline runs
 * rather than by anybody, and a channel's cadence is a promise to a listener.
 *
 * SO APPROVING IS NOT SCHEDULING. Approving says "this may go out". This file
 * decides when, and the answer is often "in three weeks" - which is the honest
 * answer and the one the calendar shows.
 *
 * THE EPISODE KEEPS THE CHANNEL'S SLOT. That is the day somebody who follows
 * the show learns to expect it, so it does not move. Shorts fill the days
 * around it, spread as evenly as the week allows, because a short's job is to
 * arrive on a day the show is otherwise silent.
 *
 * HOURS VARY, DAYS DO NOT. A channel posting at exactly its slot hour every
 * time reads as a machine even when the writing does not, so the hour walks
 * around a small civilised range anchored on the channel's own slot - which is
 * also what keeps two channels off the same hour.
 */
import { Cadence } from './schema';
import { HOUR_SPREAD, WEEKDAYS, atHourOn, instantOfWallClock, weekdayAt } from './slots';

const DAY_MS = 86_400_000;
const FIRST_HOUR = 8;
const HOUR_RANGE = 10;

export type ItemKind = 'episode' | 'short';

export interface Allocatable {
  runId: string;
  kind: ItemKind;
}

/** Something already approved, which uses up capacity in its week. */
export interface Taken {
  kind: ItemKind;
  at: Date;
}

export interface Allocated {
  runId: string;
  kind: ItemKind;
  at: Date;
}

/**
 * The Monday of the week an instant falls in, at midnight, in the zone.
 *
 * Monday because the studio's week is a working week and because the calendar
 * draws it that way; a capacity of "three a week" has to mean the same week in
 * both places or the grid and the arithmetic disagree.
 */
export const weekStart = (instant: Date, tz: string): Date => {
  const day = (weekdayAt(instant, tz) + 6) % 7;
  const local = instant.toLocaleDateString('en-CA', { timeZone: tz });
  const midnight = instantOfWallClock(`${local}T00:00:00`, tz);
  return new Date(midnight.getTime() - day * DAY_MS);
};

const sameWeek = (a: Date, b: Date, tz: string): boolean =>
  weekStart(a, tz).getTime() === weekStart(b, tz).getTime();

/**
 * Which days of a week this channel uses for a kind.
 *
 * The episode sits on the channel's slot day. Shorts are spread across the
 * remaining days, as far apart as the week allows, which for three shorts and a
 * Tuesday episode is Thursday, Saturday and Sunday rather than three days in a
 * row after it.
 */
export const daysFor = (cadence: Cadence, kind: ItemKind, count: number): number[] => {
  // MONDAY-BASED, because that is how a week is counted everywhere else here -
  // the grid draws Monday first and `weekStart` returns a Monday. WEEKDAYS is
  // Sunday-first, so using its index directly put every episode a day late.
  const slotDay = cadence.slot ? (WEEKDAYS.indexOf(cadence.slot.day) + 6) % 7 : 1;

  if (kind === 'episode') {
    // Every episode this week goes on the slot day; a channel wanting two
    // episodes a week gets the slot day and the day opposite it.
    return Array.from({ length: count }, (_, i) =>
      i === 0 ? slotDay : (slotDay + Math.round((7 * i) / count)) % 7
    );
  }

  // Shorts: walk the week from the day after the episode, stepping evenly and
  // skipping the episode's own day.
  const free = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== slotDay);
  const step = free.length / Math.max(1, count);
  return Array.from(
    { length: count },
    (_, i) => free[Math.min(free.length - 1, Math.round(i * step))]!
  );
};

export interface AllocateInput {
  cadence: Cadence;
  /** In the order they should go out. */
  items: Allocatable[];
  /** Already approved for this channel, so their weeks are already spent. */
  taken: Taken[];
  from: Date;
  timezone: string;
}

/**
 * Lay items out across as many weeks as their channel's capacity needs.
 *
 * NEVER TODAY. The first week considered is the one containing tomorrow: a
 * batch approved this afternoon publishing its first item an hour later is the
 * same burst in miniature, and nobody has listened to it yet.
 */
export const allocate = (input: AllocateInput): Allocated[] => {
  const { cadence, items, taken, timezone: tz } = input;

  const perWeek = {
    episode: Math.max(0, cadence.perWeek.episodes),
    short: Math.max(0, cadence.perWeek.shorts),
  };

  const tomorrow = new Date(input.from.getTime() + DAY_MS);
  const out: Allocated[] = [];

  // Capacity already spent, and days already used, week by week.
  const spent = new Map<number, { episode: number; short: number; days: Set<number> }>();
  const weekOf = (d: Date) => weekStart(d, tz).getTime();

  const bucket = (key: number) => {
    if (!spent.has(key)) spent.set(key, { episode: 0, short: 0, days: new Set() });
    return spent.get(key)!;
  };

  for (const t of taken) {
    const b = bucket(weekOf(t.at));
    b[t.kind] += 1;
    b.days.add((weekdayAt(t.at, tz) + 6) % 7);
  }

  for (const item of items) {
    const capacity = perWeek[item.kind];

    // A channel with no capacity for this kind cannot schedule it at all, and
    // saying so by leaving it out is better than inventing a day.
    if (capacity === 0) continue;

    // Walk forward until a week has room. Two years is not a limit anybody
    // reaches; it stops a mistake in the capacity becoming an infinite loop.
    for (let w = 0; w < 104; w++) {
      const monday = new Date(weekStart(tomorrow, tz).getTime() + w * 7 * DAY_MS);
      const key = monday.getTime();
      const b = bucket(key);

      if (b[item.kind] >= capacity) continue;

      // Which day in this week: the nth of the days this channel uses for the
      // kind, skipping any already occupied and anything already past.
      const wanted = daysFor(cadence, item.kind, capacity);
      const index = b[item.kind];

      let placed: Date | null = null;
      for (let probe = 0; probe < 7 && !placed; probe++) {
        const dayIndex = wanted[(index + probe) % wanted.length]!;
        if (b.days.has(dayIndex)) continue;

        const midnight = new Date(monday.getTime() + dayIndex * DAY_MS);
        const hour =
          FIRST_HOUR +
          ((((cadence.slot?.hour ?? FIRST_HOUR) - FIRST_HOUR) +
            HOUR_SPREAD[out.length % HOUR_SPREAD.length]!) %
            HOUR_RANGE);

        const at = atHourOn(midnight, hour, tz);

        // Never in the past, and never today.
        if (at.getTime() < tomorrow.getTime() && !sameWeek(at, tomorrow, tz)) continue;
        if (at.getTime() < input.from.getTime()) continue;

        placed = at;
        b.days.add(dayIndex);
      }

      if (!placed) continue;

      b[item.kind] += 1;
      out.push({ runId: item.runId, kind: item.kind, at: placed });
      break;
    }
  }

  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
};
