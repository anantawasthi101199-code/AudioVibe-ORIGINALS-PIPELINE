/**
 * Giving approved episodes and shorts a day and an hour.
 *
 * A CAP FOR THE WHOLE STUDIO, NOT PER CHANNEL (owner, 2026-10-17). The rule
 * was one episode and one short a day per channel, so seven channels stacked
 * seven of each onto the next two days. Now, across every channel:
 *
 *   - At most TWO episodes a day, and never two of the same series.
 *   - At most THREE shorts a day, at most two from one channel, so they vary.
 *   - Each approval takes the EARLIEST DAY WITH ROOM, from tomorrow.
 *     Approvals already on the calendar keep their days.
 *   - Publishing now is not scheduling, and is not limited by any of this.
 *
 * NEVER TODAY. A batch approved this afternoon publishing its first item an
 * hour later is a burst in miniature, and nobody has listened to it yet.
 *
 * HOURS: the episode at its channel's slot hour; the short at a varied hour
 * inside a civilised range; never two releases at the same hour on one day.
 */
import { Cadence } from './schema';
import { HOUR_SPREAD, instantOfWallClock, weekdayAt } from './slots';

const DAY_MS = 86_400_000;
const FIRST_HOUR = 8;
const HOUR_RANGE = 12; // 08:00 to 19:00
/** How far ahead to look before giving up: two years of days. */
const HORIZON_DAYS = 730;

export type ItemKind = 'episode' | 'short';

export interface Allocatable {
  runId: string;
  kind: ItemKind;
  channelId: string;
  /** The series it belongs to; two episodes of one series never share a day. */
  series: string;
  cadence: Cadence;
}

/** Something already approved, on any channel, which holds its day. */
export interface Taken {
  kind: ItemKind;
  at: Date;
  channelId: string;
  series: string;
}

export interface Allocated {
  runId: string;
  kind: ItemKind;
  at: Date;
}

/** The most the whole studio puts out on one day. */
export const PER_DAY = { episodes: 2, shorts: 3 };
/** The most shorts one channel puts out on one day. */
const SHORTS_PER_CHANNEL = 2;

/**
 * The Monday of the week an instant falls in, at midnight, in the zone. Kept
 * for the calendar, which draws Monday-first.
 */
export const weekStart = (instant: Date, tz: string): Date => {
  const day = (weekdayAt(instant, tz) + 6) % 7;
  const local = instant.toLocaleDateString('en-CA', { timeZone: tz });
  const midnight = instantOfWallClock(`${local}T00:00:00`, tz);
  return new Date(midnight.getTime() - day * DAY_MS);
};

/** The zone's calendar date of an instant, as YYYY-MM-DD. */
export const localDate = (instant: Date, tz: string): string =>
  instant.toLocaleDateString('en-CA', { timeZone: tz });

/** A YYYY-MM-DD date plus n days, by the calendar rather than by 24 hours. */
const addDays = (date: string, n: number): string => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const at = (date: string, hour: number, tz: string): Date =>
  instantOfWallClock(`${date}T${String(hour).padStart(2, '0')}:00:00`, tz);

/** The episode's hour: the channel's slot hour, else early evening. */
const episodeHour = (cadence: Cadence): number => cadence.slot?.hour ?? 18;

/** A short's hour: varied by day, never the episode's hour. */
const shortHour = (cadence: Cadence, dayNumber: number): number => {
  const base = cadence.slot?.hour ?? FIRST_HOUR;
  const avoid = episodeHour(cadence);
  for (let k = 0; k < HOUR_SPREAD.length; k++) {
    const spread = HOUR_SPREAD[(dayNumber + k) % HOUR_SPREAD.length]!;
    const hour = FIRST_HOUR + ((base - FIRST_HOUR + spread + 1) % HOUR_RANGE + HOUR_RANGE) % HOUR_RANGE;
    if (hour !== avoid) return hour;
  }
  return avoid === FIRST_HOUR ? FIRST_HOUR + 1 : FIRST_HOUR;
};

export interface AllocateInput {
  /** In the order they should go out. */
  items: Allocatable[];
  /** Already approved on every channel, so their places are already spent. */
  taken: Taken[];
  from: Date;
  timezone: string;
}

interface Day {
  episodes: string[]; // series
  shorts: string[]; // channel ids
  hours: Set<number>;
}

const fits = (d: Day, item: Allocatable): boolean =>
  item.kind === 'episode'
    ? d.episodes.length < PER_DAY.episodes && !d.episodes.includes(item.series)
    : d.shorts.length < PER_DAY.shorts &&
      d.shorts.filter((c) => c === item.channelId).length < SHORTS_PER_CHANNEL;

/** Lay items out within the studio's daily cap, on the earliest days with room from tomorrow. */
export const allocate = (input: AllocateInput): Allocated[] => {
  const { items, taken, timezone: tz } = input;

  const days = new Map<string, Day>();
  const day = (date: string) => {
    if (!days.has(date)) days.set(date, { episodes: [], shorts: [], hours: new Set() });
    return days.get(date)!;
  };
  const hourOf = (d: Date) => Number(d.toLocaleString('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }));
  for (const t of taken) {
    const d = day(localDate(t.at, tz));
    if (t.kind === 'episode') d.episodes.push(t.series);
    else d.shorts.push(t.channelId);
    d.hours.add(hourOf(t.at));
  }

  const first = addDays(localDate(input.from, tz), 1); // never today
  const out: Allocated[] = [];

  for (const item of items) {
    for (let n = 0; n < HORIZON_DAYS; n++) {
      const date = addDays(first, n);
      const d = day(date);
      if (!fits(d, item)) continue;

      const dayNumber = Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
      let hour = item.kind === 'episode' ? episodeHour(item.cadence) : shortHour(item.cadence, dayNumber);
      // Never two at the same hour: step to the next free one in the range.
      for (let k = 0; k < HOUR_RANGE && d.hours.has(hour); k++) {
        hour = FIRST_HOUR + ((hour - FIRST_HOUR + 1) % HOUR_RANGE);
      }
      const when = at(date, hour, tz);
      if (when.getTime() <= input.from.getTime()) continue;

      if (item.kind === 'episode') d.episodes.push(item.series);
      else d.shorts.push(item.channelId);
      d.hours.add(hour);
      out.push({ runId: item.runId, kind: item.kind, at: when });
      break;
    }
  }

  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
};
