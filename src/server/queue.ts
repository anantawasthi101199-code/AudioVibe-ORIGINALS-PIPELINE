/**
 * The publish queue: what is about to go out, what is stuck, and what went.
 *
 * ONE PAGE THAT ANSWERS "IS THE STUDIO OK". Everything on it already exists
 * somewhere - the plan comes from the schedule, the runs come from the run
 * store - and the only work this file does is put them in the order somebody
 * actually reads them in: what needs me, what is about to happen by itself,
 * what broke, what went out.
 *
 * HELD IS FIRST AND IT IS THE POINT. A run waiting for approval is the studio
 * asking a person a question, and a question nobody sees is the failure mode
 * this whole interface exists to prevent. Everything below it is reassurance;
 * that section is work.
 *
 * NOTHING HERE DECIDES ANYTHING. No route in this file starts a run, approves
 * one, or publishes. It reports, and every action is somewhere the command line
 * also goes through.
 */
import { loadPersona } from '../canon/load';
import { loadSchedule } from '../schedule/load';
import { currentPlan } from '../schedule/current';
import { describeSlot } from '../schedule/slots';
import { RunSummary, runs } from './catalog';
import { jobs } from './jobs';

export interface QueueItem {
  channelId: string;
  channelName: string;
  kind: 'episode' | 'short';
  reason: string;
  /** Days past due. Only ever positive for something in `due`. */
  overdueDays?: number;
  /** When it goes out, for something that is waiting. */
  at?: string;
  parentRunId?: string;
}

export interface QueueBlocker {
  channelId: string;
  channelName: string;
  reason: string;
}

export interface QueueView {
  paused: boolean;
  timezone: string;
  /** Ready to be made now, most overdue first. */
  due: QueueItem[];
  /** Ready, but not yet its turn. Soonest first. */
  waiting: QueueItem[];
  /** Due, but something has to be done by a person first. */
  blocked: QueueBlocker[];
  /** Made, gated, and waiting for somebody to say yes. THE IMPORTANT ONE. */
  held: RunSummary[];
  /**
   * Gate passed clean and its release time has come, or it has none.
   *
   * SPLIT FROM `scheduled` so the page can tell you what you could publish now
   * from what is finished but not yet its turn. Ten shorts cut in one afternoon
   * are all in the second list on the day they are cut and move into the first
   * one a day at a time.
   */
  ready: RunSummary[];
  /** Gate passed, waiting for a release time that has not arrived. */
  scheduled: Array<RunSummary & { releaseAt: string }>;
  /**
   * The gate found something blocking. NEWEST FEW, WITH THE REAL COUNT beside
   * them, because a studio accumulates these and a list of every episode ever
   * rejected is a list nobody reads - which is how a rejection that mattered
   * gets lost among thirty that were superseded a fortnight ago.
   */
  failed: RunSummary[];
  failedTotal: number;
  /** Out in the world, newest first. */
  published: RunSummary[];
  publishedTotal: number;
  /** Each show's slot, so the week is readable without opening the yaml. */
  slots: Array<{ channelId: string; channelName: string; slot: string | null }>;
}

/** A channel's display name, falling back to its id if the persona is gone. */
const nameOf = (id: string): string => {
  try {
    return loadPersona(id).name;
  } catch {
    // A schedule entry with no persona file is already reported as blocked;
    // it should not also take the page down.
    return id;
  }
};

/** How many of the long tails to list. The count beside them is the real one. */
const RECENT = 12;

export const getQueue = (now = new Date()): QueueView => {
  const schedule = loadSchedule();
  const plan = currentPlan(now);
  const all = runs({ limit: 400, live: jobs.liveRunIds() });

  const inState = (...states: RunSummary['state'][]): RunSummary[] =>
    all.filter((r) => states.includes(r.state));

  return {
    paused: schedule.paused,
    timezone: schedule.timezone,

    due: plan.due.map((d) => ({
      channelId: d.personaId,
      channelName: nameOf(d.personaId),
      kind: d.kind,
      reason: d.reason,
      overdueDays: d.overdueDays,
      parentRunId: d.parentRunId,
    })),

    waiting: plan.waiting.map((w) => ({
      channelId: w.personaId,
      channelName: nameOf(w.personaId),
      kind: w.kind,
      reason: w.reason,
      at: w.at.toISOString(),
    })),

    blocked: plan.blocked.map((b) => ({
      channelId: b.personaId,
      channelName: nameOf(b.personaId),
      reason: b.reason,
    })),

    held: inState('awaiting-approval'),

    // WHOSE TURN IT IS. A run with no release time is ready the moment it
    // passes, which is what an episode is; one with a time in the future is
    // finished and waiting, which is what a story in a cut set is.
    ready: inState('ready').filter(
      (r) => !r.isSource && (!r.releaseAt || Date.parse(r.releaseAt) <= now.getTime())
    ),
    scheduled: inState('ready')
      .filter((r): r is RunSummary & { releaseAt: string } =>
        Boolean(!r.isSource && r.releaseAt && Date.parse(r.releaseAt) > now.getTime())
      )
      .sort((a, b) => Date.parse(a.releaseAt) - Date.parse(b.releaseAt)),
    failed: inState('failed').slice(0, RECENT),
    failedTotal: inState('failed').length,
    published: inState('published').slice(0, RECENT),
    publishedTotal: inState('published').length,

    slots: Object.entries(schedule.shows).map(([channelId, cadence]) => ({
      channelId,
      channelName: nameOf(channelId),
      slot: cadence.slot ? describeSlot(cadence.slot) : null,
    })),
  };
};
