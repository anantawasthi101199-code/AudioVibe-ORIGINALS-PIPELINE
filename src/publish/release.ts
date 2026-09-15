/**
 * Publishing what a person already approved, when its time comes.
 *
 * THE ONE THING IN THIS STUDIO THAT ACTS WITHOUT BEING ASKED, which is why it
 * is the most conservative file in it. Everything else waits for somebody to
 * press something; this publishes to production on a clock. So it does the
 * least it possibly can:
 *
 * IT NEVER DECIDES WHAT GOES OUT. A run is released only if a person ticked it,
 * gave it a date and saved - recorded as `releaseApprovedAt`, a decision rather
 * than a plan. Nothing here picks candidates, fills gaps or catches up on a
 * show that looks quiet. An empty schedule means an empty day.
 *
 * IT NEVER OVERRIDES THE GATE. The report is recomputed at release time, not
 * trusted from when it was approved: a script edited after approval is gated
 * again on the way out, and a run that no longer passes is skipped and said so.
 *
 * IT PUBLISHES ONE THING PER DUE DATE, in date order. A studio that has been
 * off for a week comes back to seven things due, and publishing them in one
 * minute is precisely the burst the whole scheduling design exists to avoid -
 * so a backlog goes out at the rate the trigger fires, oldest first, and the
 * rest stay due.
 */
import { loadPersona } from '../canon/load';
import { Run } from '../run/store';
import { regate } from '../qa/regate';
import { scriptSchema } from '../script/write';
import { PublishRefused, publishRun } from './publishRun';

export interface DueRun {
  runId: string;
  channelId: string;
  channelName: string;
  title: string;
  releaseAt: Date;
  approvedAt: Date;
}

/** Why something with a date on it is not going out. */
export interface HeldBack {
  runId: string;
  reason: string;
}

export interface ReleasePlan {
  due: DueRun[];
  held: HeldBack[];
}

/**
 * What is due to go out now, and what is being held back and why.
 *
 * COSTS NOTHING AND CHANGES NOTHING, so the command that shows it and the
 * command that acts on it can be the same code with one flag between them.
 */
export const dueForRelease = (now = new Date()): ReleasePlan => {
  const due: DueRun[] = [];
  const held: HeldBack[] = [];

  for (const id of Run.list()) {
    const run = Run.open(id);
    const m = run.manifest;

    // No date, or no decision: not this file's business at all. Silent rather
    // than "held", because most runs are in this state and listing them would
    // bury the ones that are actually stuck.
    if (!m.releaseAt || !m.releaseApprovedAt) continue;
    if (run.isComplete('publish')) continue;
    if (Date.parse(m.releaseAt) > now.getTime()) continue;

    if (!run.hasArtifact('script')) {
      held.push({ runId: id, reason: 'has no script' });
      continue;
    }

    // RE-GATED NOW, NOT TRUSTED FROM APPROVAL TIME. A script edited since is a
    // different episode, and its old report describes words nobody will hear.
    const gate = regate(run, run.readArtifact('script', scriptSchema));
    if (!gate) {
      held.push({ runId: id, reason: 'cannot be gated' });
      continue;
    }
    if (!gate.passed) {
      held.push({
        runId: id,
        reason: `no longer passes the gate: ${[
          ...new Set(gate.findings.filter((f) => f.blocking).map((f) => f.check)),
        ].join(', ')}`,
      });
      continue;
    }

    let channelName = m.personaId;
    try {
      channelName = loadPersona(m.personaId).name;
    } catch {
      /* the id is a serviceable name */
    }

    due.push({
      runId: id,
      channelId: m.personaId,
      channelName,
      title: run.readArtifact('script', scriptSchema).title,
      releaseAt: new Date(m.releaseAt),
      approvedAt: new Date(m.releaseApprovedAt),
    });
  }

  // Oldest first, so a backlog comes out in the order it was meant to.
  due.sort((a, b) => a.releaseAt.getTime() - b.releaseAt.getTime());
  return { due, held };
};

export interface Released {
  runId: string;
  audioId: string;
  url: string;
}

export interface ReleaseResult {
  released: Released[];
  failed: Array<{ runId: string; reason: string }>;
  held: HeldBack[];
  /** Still due after this pass, because only one goes per call. */
  remaining: number;
}

/**
 * Release what is due. ONE PER CALL.
 *
 * A studio that has been off for a week has seven things due, and publishing
 * them in one minute is exactly the burst the scheduling exists to prevent. So
 * a backlog drains at whatever rate the trigger fires - which is a rate
 * somebody chose - and `remaining` says how much is left.
 */
export const releaseDue = async (
  now = new Date(),
  opts: { report?: (message: string) => void } = {}
): Promise<ReleaseResult> => {
  const say = opts.report ?? (() => undefined);
  const plan = dueForRelease(now);

  const released: Released[] = [];
  const failed: Array<{ runId: string; reason: string }> = [];

  const next = plan.due[0];
  if (!next) {
    return { released, failed, held: plan.held, remaining: 0 };
  }

  const run = Run.open(next.runId);
  const gate = regate(run, run.readArtifact('script', scriptSchema))!;

  say(`releasing "${next.title}" (${next.channelName})`);

  try {
    // `confirmed` is the approval a person gave when they saved the order,
    // which is the same act `--yes` is on the command line.
    const result = await publishRun(run, gate, { confirmed: true, report: say });
    released.push({ runId: next.runId, audioId: result.audioId, url: result.url });
  } catch (err) {
    const reason = err instanceof PublishRefused ? err.reason : (err as Error).message;
    failed.push({ runId: next.runId, reason });
    say(`refused: ${reason}`);
  }

  return { released, failed, held: plan.held, remaining: plan.due.length - 1 };
};
