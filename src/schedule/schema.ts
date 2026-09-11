/**
 * The publishing schedule: how often each show puts something out.
 *
 * WHY A FILE AND NOT A CRON EXPRESSION. Cron answers "when should this fire",
 * which is the wrong question. The right one is "is this show behind", and it
 * has a different answer: a show that missed last week is due NOW, not next
 * Tuesday. Cron would silently skip a week whenever the machine was off, a run
 * failed, or a gate rejected an episode, and skipping a week is exactly the
 * thing a schedule exists to prevent.
 *
 * So this declares a CADENCE, and what is due is computed by comparing it to
 * what was actually published. The trigger - cron, Task Scheduler, a CI
 * timer - only has to fire often enough; it carries no state and cannot drift.
 *
 * WHAT IS DELIBERATELY NOT AUTOMATED. Publishing, by default. The pipeline
 * stops at the gate exactly as it does when run by hand, because the two checks
 * the gate hands to a person are the ones an automated loop waves through. A
 * show can opt into automatic publishing, and that option exists because
 * refusing it entirely would just mean somebody writes a worse version of it in
 * a shell script - but it is off until somebody decides otherwise, per show,
 * in writing.
 */
import { z } from 'zod';

/**
 * How often a show publishes, in days between episodes.
 *
 * A NUMBER RATHER THAN "weekly", because the useful question is arithmetic:
 * days since the last episode against days between episodes. Named cadences
 * would need a calendar, and a calendar would make "every Tuesday" mean a show
 * that slipped is not due until next Tuesday - which is the failure above.
 */
export const cadenceSchema = z.object({
  /** Days between episodes of the long-form show. */
  everyDays: z.number().int().positive(),

  /**
   * Shorts to cut from each episode.
   *
   * Zero is a valid answer and is the right one for a show whose episodes do
   * not contain separable moments. A short that has to be excavated is the
   * trailer the short lane exists not to be.
   */
  shortsPerEpisode: z.number().int().nonnegative().default(0),

  /**
   * Publish automatically when the gate passes clean.
   *
   * "Clean" is doing real work here: the gate passing is not enough, because a
   * pass can still carry `needsHumanReview`, and those two reasons - did the
   * script acknowledge the counter-evidence, is that weakest source framed as
   * one person's account - are precisely the ones no arithmetic settles. An
   * episode needing review waits for a person however this is set.
   */
  autoPublish: z.boolean().default(false),
});

export type Cadence = z.infer<typeof cadenceSchema>;

export const scheduleSchema = z.object({
  /** personaId -> cadence. A show absent from here never comes up as due. */
  shows: z.record(cadenceSchema).default({}),

  /**
   * Stop everything, without editing every show.
   *
   * An escape hatch that is one word rather than a rewrite, because the moment
   * you need it you are usually looking at something going wrong.
   */
  paused: z.boolean().default(false),
});

export type Schedule = z.infer<typeof scheduleSchema>;
