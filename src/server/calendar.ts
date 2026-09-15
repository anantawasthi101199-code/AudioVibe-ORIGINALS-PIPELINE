/**
 * A month of the studio, as days.
 *
 * WHAT IT ANSWERS. "What goes out, and when" - which is a question about shape
 * rather than about any one episode. Two shows on the same day, a week with
 * nothing in it, a channel that has gone quiet: all of those are obvious in a
 * grid and invisible in a list, which is the whole reason this exists as a
 * separate view rather than another sort order on the publishing page.
 *
 * PAST AND FUTURE IN ONE GRID. What went out is the same kind of fact as what
 * is going to, and splitting them would make "did anything go out last week"
 * a different screen from "is anything going out next week".
 *
 * DAYS ARE IN THE SCHEDULE'S ZONE, NOT UTC. A release at 08:00 London on the
 * 16th belongs on the 16th, and bucketing by UTC date would put anything
 * before 01:00 BST on the day before.
 */
import { z } from 'zod';
import { loadPersona } from '../canon/load';
import { loadFormat } from '../formats/load';
import { Run } from '../run/store';
import { loadSchedule } from '../schedule/load';
import { describeSlot } from '../schedule/slots';

export type EntryKind = 'episode' | 'short';
export type EntryState = 'published' | 'approved' | 'planned';

export interface CalendarEntry {
  runId: string;
  channelId: string;
  channelName: string;
  title: string;
  kind: EntryKind;
  /**
   * `published` is out. `approved` will go out by itself at this time.
   * `planned` has a date but nobody has said yes, so it will not.
   */
  state: EntryState;
  at: string;
  durationS: number | null;
  short: number | null;
}

export interface CalendarDay {
  /** `YYYY-MM-DD` in the schedule's zone. */
  date: string;
  entries: CalendarEntry[];
}

export interface CalendarView {
  /** `YYYY-MM`, the month this covers. */
  month: string;
  timezone: string;
  days: CalendarDay[];
  /** Every channel that appears, so the interface can colour them. */
  channels: Array<{ id: string; name: string; slot: string | null }>;
  /** Whether anything is actually going to publish on its own. */
  releasing: boolean;
}

/** The day an instant falls on, where the listeners are. */
const dayIn = (iso: string, tz: string): string =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });

export const getCalendar = (month?: string): CalendarView => {
  const schedule = loadSchedule();
  const tz = schedule.timezone;

  const now = new Date();
  const target = month ?? now.toLocaleDateString('en-CA', { timeZone: tz }).slice(0, 7);

  const entries: CalendarEntry[] = [];
  const channels = new Map<string, { id: string; name: string; slot: string | null }>();

  for (const id of Run.list()) {
    const run = Run.open(id);
    const m = run.manifest;

    // WHEN IT HAPPENED, OR WHEN IT WILL. A published run's own timestamp is the
    // truth about it; anything else has only a plan.
    let at: string | null = null;
    let state: EntryState = 'planned';

    if (run.isComplete('publish')) {
      try {
        at = run.readPublishTimestamp();
        state = 'published';
      } catch {
        // An unreadable publish artifact means the publish cannot be dated. It
        // is left off the grid rather than guessed onto a day.
      }
    } else if (m.releaseAt) {
      at = m.releaseAt;
      state = m.releaseApprovedAt ? 'approved' : 'planned';
    }

    if (!at || dayIn(at, tz).slice(0, 7) !== target) continue;

    let kind: EntryKind = 'episode';
    let isSource = false;
    try {
      const format = loadFormat(m.formatId);
      isSource = Boolean(format.sourceOnly) && m.story === undefined;
      kind = format.kind === 'short' || m.story !== undefined ? 'short' : 'episode';
    } catch {
      /* format gone; an episode is the safer guess */
    }

    // A source script is never published, so it is never on a calendar.
    if (isSource) continue;

    let channelName = m.personaId;
    try {
      channelName = loadPersona(m.personaId).name;
    } catch {
      /* the id is a serviceable name */
    }

    if (!channels.has(m.personaId)) {
      const cadence = schedule.shows[m.personaId];
      channels.set(m.personaId, {
        id: m.personaId,
        name: channelName,
        slot: cadence?.slot ? describeSlot(cadence.slot) : null,
      });
    }

    let title = m.topic;
    let durationS: number | null = null;
    try {
      title = run.readArtifact('script', z.object({ title: z.string() }).passthrough()).title;
    } catch {
      /* topic is a serviceable name */
    }
    try {
      durationS = run.readArtifact(
        'render',
        z.object({ durationS: z.number() }).passthrough()
      ).durationS;
    } catch {
      /* no audio yet */
    }

    entries.push({
      runId: id,
      channelId: m.personaId,
      channelName,
      title,
      kind,
      state,
      at,
      durationS,
      short: m.short ?? null,
    });
  }

  // Grouped by day, each day's entries in time order.
  const byDay = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    const day = dayIn(entry.at, tz);
    byDay.set(day, [...(byDay.get(day) ?? []), entry]);
  }

  const days: CalendarDay[] = [...byDay.entries()]
    .map(([date, list]) => ({
      date,
      entries: list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    month: target,
    timezone: tz,
    days,
    channels: [...channels.values()].sort((a, b) => a.name.localeCompare(b.name)),
    releasing: releasingEnabled(),
  };
};

/**
 * Whether anything actually publishes on its own.
 *
 * NAMED ON THE CALENDAR, because a grid of future dates is a promise and this
 * is whether the promise is kept. Off by default: something that publishes to
 * production on a clock is not a thing to switch on by accident.
 */
export const releasingEnabled = (): boolean => process.env.FOUNDRY_RELEASE === 'on';
