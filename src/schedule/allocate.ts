/**
 * Giving approved episodes and shorts a day and an hour.
 *
 * ONE OF EACH KIND A DAY, PER CHANNEL, EVERY DAY (owner, 2026-10-08). The rule
 * used to be a weekly quota from schedule.yaml (one episode and three shorts
 * for most channels) with a short never allowed on an episode's day, so eight
 * approved shorts went out over three weeks with silent days between them.
 * Now something goes out on the regular:
 *
 *   - At most ONE short and ONE episode on any day, for a channel. Both may go
 *     out on the same day, at different hours.
 *   - Each approval takes the EARLIEST FREE DAY for its kind, from tomorrow.
 *     Approvals already on the calendar keep their days, so the stream stays
 *     gap-free: a short approved when this week is full goes to next week,
 *     and so on.
 *   - Publishing now is not scheduling, and is not limited by any of this.
 *
 * NEVER TODAY. A batch approved this afternoon publishing its first item an
 * hour later is a burst in miniature, and nobody has listened to it yet.
 *
 * HOURS: the episode at the channel's slot hour; the short at a different,
 * varied hour inside a civilised range, so a channel never posts twice at
 * once and does not read as a machine posting at the same minute daily.
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
}

/** Something already approved for this channel, which holds its day. */
export interface Taken {
  kind: ItemKind;
  at: Date;
}

export interface Allocated {
  runId: string;
  kind: ItemKind;
  at: Date;
}

/** The most of one kind a channel may put out on one day. */
export const PER_DAY = 1;

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
  cadence: Cadence;
  /** In the order they should go out. */
  items: Allocatable[];
  /** Already approved for this channel, so their days are already spent. */
  taken: Taken[];
  from: Date;
  timezone: string;
}

/** Lay items out one of each kind a day, on the earliest free days from tomorrow. */
export const allocate = (input: AllocateInput): Allocated[] => {
  const { cadence, items, taken, timezone: tz } = input;

  // How many of each kind each local day already holds.
  const used = new Map<string, { episode: number; short: number }>();
  const day = (date: string) => {
    if (!used.has(date)) used.set(date, { episode: 0, short: 0 });
    return used.get(date)!;
  };
  for (const t of taken) day(localDate(t.at, tz))[t.kind] += 1;

  const first = addDays(localDate(input.from, tz), 1); // never today
  const out: Allocated[] = [];

  for (const item of items) {
    for (let n = 0; n < HORIZON_DAYS; n++) {
      const date = addDays(first, n);
      const d = day(date);
      if (d[item.kind] >= PER_DAY) continue;

      const dayNumber = Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
      const when = at(date, item.kind === 'episode' ? episodeHour(cadence) : shortHour(cadence, dayNumber), tz);
      if (when.getTime() <= input.from.getTime()) continue;

      d[item.kind] += 1;
      out.push({ runId: item.runId, kind: item.kind, at: when });
      break;
    }
  }

  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
};
