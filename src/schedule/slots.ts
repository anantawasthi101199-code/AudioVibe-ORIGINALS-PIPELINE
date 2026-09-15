/**
 * When in the week a show puts something out.
 *
 * THE PROBLEM THIS SOLVES IS A BATCH. Cadence alone says a show is due after N
 * days, so whichever tick happens to run first publishes everything that came
 * due since the last one. Five shows and their shorts land in the same minute,
 * a listener following two of them gets both at once, and a week's work arrives
 * as one lump and then nothing for six days.
 *
 * A SLOT IS A PREFERENCE, NEVER A DEADLINE, and that distinction is the whole
 * reason schema.ts refused a cron expression in the first place. "Every Tuesday"
 * as a rule means a show that slipped is not due until NEXT Tuesday, which is a
 * week of silence caused by the schedule itself. So a slot only decides WHEN
 * WITHIN its due window a show goes out. It never makes a show wait longer than
 * one occurrence: once the slot has passed, the show is due and stays due until
 * it publishes, whether the machine was on at the time or not.
 *
 * SHORTS ARE SPREAD RATHER THAN SLOTTED. They are cut from an episode, so their
 * timing is relative to it - two shorts from a Tuesday episode belong on
 * Thursday and Sunday, not on two fixed days that might both fall before the
 * episode they came from. The arithmetic is in shortDueAfterDays and needs no
 * configuration, because "evenly, in the gap" is the only sensible answer and a
 * per-short day list would be four more lines to get wrong.
 *
 * TIME ZONES ARE REAL HERE. An 8am slot means 8am where the listeners are, and
 * a studio that ignored that would publish an hour early for half the year.
 * Everything below is computed against a named zone, so British Summer Time is
 * handled by the platform's own database rather than by an offset somebody
 * wrote down once.
 */
import { z } from 'zod';

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export const slotSchema = z.object({
  /** Which day of the week, as a three-letter name. */
  day: z.enum(WEEKDAYS),
  /** Which hour of that day, 0-23, in the schedule's timezone. */
  hour: z.number().int().min(0).max(23),
});

export type Slot = z.infer<typeof slotSchema>;

const DAY_MS = 86_400_000;

/** The zone's wall clock at an instant, as `YYYY-MM-DDTHH:mm:ss`. */
const wallClock = (instant: Date, tz: string): string =>
  instant.toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T');

/**
 * How far the zone is from UTC at a given instant.
 *
 * Derived by asking the platform what the wall clock reads and subtracting,
 * rather than from a table. A table is wrong every time a government changes
 * its mind about daylight saving, which they do.
 */
const offsetMs = (instant: Date, tz: string): number =>
  Date.parse(`${wallClock(instant, tz)}Z`) - instant.getTime();

/**
 * The instant at which the zone's wall clock reads this.
 *
 * TWICE, BECAUSE THE OFFSET DEPENDS ON THE ANSWER. The first pass uses the
 * offset around the naive reading, which is wrong within an hour of a clock
 * change; the second uses the offset at the instant the first pass found, which
 * is right. Two passes converge for every real zone, since no clock change is
 * larger than the error the first pass can make.
 */
export const instantOfWallClock = (wall: string, tz: string): Date => {
  const naive = Date.parse(`${wall}Z`);
  const once = naive - offsetMs(new Date(naive), tz);
  return new Date(naive - offsetMs(new Date(once), tz));
};

/** The zone's weekday at an instant, as an index into WEEKDAYS. */
export const weekdayAt = (instant: Date, tz: string): number =>
  new Date(`${wallClock(instant, tz)}Z`).getUTCDay();

/** That day's slot hour, wherever in the world the listeners are. */
export const atHourOn = (instant: Date, hour: number, tz: string): Date => {
  const day = wallClock(instant, tz).slice(0, 10);
  return instantOfWallClock(`${day}T${String(hour).padStart(2, '0')}:00:00`, tz);
};

/**
 * The first time this slot comes round, at or after a given instant.
 *
 * Nine days rather than seven, because a clock change can move a slot across a
 * day boundary and the loop should not depend on noticing that.
 */
export const nextSlotAfter = (from: Date, slot: Slot, tz: string): Date => {
  const want = WEEKDAYS.indexOf(slot.day);

  for (let i = 0; i <= 9; i++) {
    const candidate = atHourOn(new Date(from.getTime() + i * DAY_MS), slot.hour, tz);
    if (candidate.getTime() >= from.getTime() && weekdayAt(candidate, tz) === want) {
      return candidate;
    }
  }

  // Unreachable for any real zone. Throwing beats returning a wrong date that
  // would silently publish at the wrong time forever.
  throw new Error(`no ${slot.day} ${slot.hour}:00 found within nine days in ${tz}`);
};

/**
 * How many days after its episode the nth short should go out.
 *
 * EVENLY, IN THE GAP. Two shorts from a weekly episode belong on day 2 and day
 * 5, not both on day 1 - which is what a scheduler that simply publishes
 * whatever is due will do, and which wastes the second one entirely. The point
 * of a short is to arrive on a day the show is otherwise silent.
 *
 * NEVER DAY ZERO. A short landing beside the episode it was cut from competes
 * with it, and a listener sees the same story twice in one scroll.
 */
export const shortDueAfterDays = (index: number, count: number, everyDays: number): number =>
  Math.max(1, Math.round((everyDays * (index + 1)) / (count + 1)));

/** "Tue 08:00", for a person reading a plan. */
export const describeSlot = (slot: Slot): string =>
  `${slot.day[0]!.toUpperCase()}${slot.day.slice(1)} ${String(slot.hour).padStart(2, '0')}:00`;
