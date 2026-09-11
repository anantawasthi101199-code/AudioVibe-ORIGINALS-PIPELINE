/**
 * What the studio should make right now.
 *
 * COMPUTED FROM WHAT WAS PUBLISHED, NEVER FROM A TIMER'S OWN MEMORY. The single
 * source of truth for "when did this show last publish" is the run directories,
 * because that is the only record that cannot disagree with reality. A
 * last-run-at field in the schedule file would go stale the first time a run was
 * deleted, a publish failed after being recorded, or two machines ran the same
 * show - and it would go stale silently, in the direction of not publishing.
 *
 * THE TRIGGER IS STATELESS. Whatever fires this - cron, Task Scheduler, a CI
 * timer - only has to fire often enough. Firing twice in an hour produces the
 * same plan twice and the second one finds the work already done. Not firing
 * for three days produces a show that is three days overdue, which is correct
 * and visible rather than a week silently skipped.
 *
 * IT PLANS, IT DOES NOT DECIDE TO SPEND. Nothing here starts a run. The plan is
 * a list a person or a command can look at, and that separation is what makes a
 * schedule inspectable before it costs anything.
 */
import { Persona } from '../canon/schema';
import { Run } from '../run/store';
import { Cadence, Schedule } from './schema';

export interface PlanItem {
  personaId: string;
  /** What to make. A short is only ever cut from an episode that exists. */
  kind: 'episode' | 'short';
  /** Days past due. Zero means due today; higher means behind. */
  overdueDays: number;
  /** For a short, the run to cut it from. */
  parentRunId?: string;
  /** Why this is on the list, in words, for the person reading it. */
  reason: string;
}

export interface PlanBlocker {
  personaId: string;
  reason: string;
}

export interface Plan {
  due: PlanItem[];
  /** Shows that are due but cannot proceed, and what they are waiting on. */
  blocked: PlanBlocker[];
}

const DAY_MS = 86_400_000;

/** Whole days between two instants, floored, never negative. */
export const daysBetween = (from: Date, to: Date): number =>
  Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));

export interface ShowHistory {
  /** Published long episodes, newest first. */
  episodes: Array<{ runId: string; publishedAt: Date; shortsCut: number }>;
}

/**
 * Read a show's publishing history out of its runs.
 *
 * Only runs that actually completed a publish count. A run that was made and
 * gated but never published has not published, and treating it as if it had is
 * how a show goes quiet while the schedule reports it as up to date.
 */
export const historyFor = (
  personaId: string,
  runs: Array<{
    id: string;
    personaId: string;
    formatKind: 'long' | 'short';
    publishedAt: Date | null;
    derivedFrom?: string;
  }>
): ShowHistory => {
  const mine = runs.filter((r) => r.personaId === personaId && r.publishedAt);

  const shortsByParent = new Map<string, number>();
  for (const r of mine) {
    if (r.formatKind === 'short' && r.derivedFrom) {
      shortsByParent.set(r.derivedFrom, (shortsByParent.get(r.derivedFrom) ?? 0) + 1);
    }
  }

  const episodes = mine
    .filter((r) => r.formatKind === 'long')
    .map((r) => ({
      runId: r.id,
      publishedAt: r.publishedAt!,
      shortsCut: shortsByParent.get(r.id) ?? 0,
    }))
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

  return { episodes };
};

export interface PlanInput {
  schedule: Schedule;
  personas: Persona[];
  history: (personaId: string) => ShowHistory;
  /** How many topics a factual show has queued. Fiction needs none. */
  topicsQueued: (personaId: string) => number;
  now: Date;
}

/**
 * One show's worth of plan.
 *
 * EPISODES BEFORE SHORTS, and never both in one tick. A short is cut from an
 * episode, so a tick that made both would cut a short from an episode written
 * minutes earlier and publish them together - which wastes the short. The
 * whole point of a short is to arrive on a different day, in a different feed,
 * and bring somebody back to the episode.
 */
const planShow = (
  persona: Persona,
  cadence: Cadence,
  input: PlanInput
): { due: PlanItem[]; blocked: PlanBlocker[] } => {
  const history = input.history(persona.id);
  const latest = history.episodes[0];

  const daysSince = latest ? daysBetween(latest.publishedAt, input.now) : Infinity;
  const episodeDue = daysSince >= cadence.everyDays;

  if (episodeDue) {
    // A factual show cannot write an episode without something to write about,
    // and topic choice is editorial - it is where taste enters and it is cheap
    // for a person to do a dozen at a time. So a show with an empty queue is
    // BLOCKED rather than skipped: skipping would let a show quietly stop
    // publishing and report itself as healthy.
    if (!persona.fiction && input.topicsQueued(persona.id) === 0) {
      return {
        due: [],
        blocked: [
          {
            personaId: persona.id,
            reason:
              `due${latest ? ` (${daysSince} days since the last episode)` : ' (never published)'} ` +
              `but its topic queue is empty`,
          },
        ],
      };
    }

    return {
      due: [
        {
          personaId: persona.id,
          kind: 'episode',
          overdueDays: latest ? daysSince - cadence.everyDays : 0,
          reason: latest
            ? `${daysSince} days since "${latest.runId}", cadence is ${cadence.everyDays}`
            : 'has never published',
        },
      ],
      blocked: [],
    };
  }

  // Not due for an episode. Shorts fill the gap, which is what they are for:
  // they are cheap, they reach people who have never heard the show, and they
  // are the only thing here that can publish on a day no episode does.
  if (latest && latest.shortsCut < cadence.shortsPerEpisode) {
    return {
      due: [
        {
          personaId: persona.id,
          kind: 'short',
          overdueDays: 0,
          parentRunId: latest.runId,
          reason:
            `${latest.shortsCut} of ${cadence.shortsPerEpisode} shorts cut from ` +
            `"${latest.runId}"`,
        },
      ],
      blocked: [],
    };
  }

  return { due: [], blocked: [] };
};

export const buildPlan = (input: PlanInput): Plan => {
  if (input.schedule.paused) return { due: [], blocked: [] };

  const due: PlanItem[] = [];
  const blocked: PlanBlocker[] = [];
  const byId = new Map(input.personas.map((p) => [p.id, p]));

  for (const [personaId, cadence] of Object.entries(input.schedule.shows)) {
    const persona = byId.get(personaId);
    if (!persona) {
      // A schedule naming a show that does not exist is a typo, and a typo that
      // silently means "never publish this" is the worst kind.
      blocked.push({
        personaId,
        reason: 'is in the schedule but has no persona file',
      });
      continue;
    }

    const result = planShow(persona, cadence, input);
    due.push(...result.due);
    blocked.push(...result.blocked);
  }

  // Most overdue first. A studio behind on three shows should catch up on the
  // one that has been waiting longest, not the one that sorts first.
  due.sort((a, b) => b.overdueDays - a.overdueDays);

  return { due, blocked };
};

/** Read a run directory into the shape `historyFor` wants. */
export const runSummary = (
  run: Run,
  formatKind: 'long' | 'short'
): {
  id: string;
  personaId: string;
  formatKind: 'long' | 'short';
  publishedAt: Date | null;
  derivedFrom?: string;
} => {
  let publishedAt: Date | null = null;

  if (run.isComplete('publish') && run.hasArtifact('publish')) {
    try {
      const raw = run.readPublishTimestamp();
      publishedAt = raw ? new Date(raw) : null;
      if (publishedAt && Number.isNaN(publishedAt.getTime())) publishedAt = null;
    } catch {
      // An unreadable publish artifact means the publish cannot be dated, which
      // makes the show look overdue. That is the safe direction: it produces
      // one extra episode, not a show that silently stops.
      publishedAt = null;
    }
  }

  return {
    id: run.id,
    personaId: run.manifest.personaId,
    formatKind,
    publishedAt,
    derivedFrom: run.manifest.derivedFrom,
  };
};
