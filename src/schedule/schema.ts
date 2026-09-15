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
import { slotSchema } from './slots';

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

  /**
   * When in the week this show goes out.
   *
   * A PREFERENCE, NOT A DEADLINE. Cadence still decides whether a show is due;
   * the slot only decides when within that window it goes. A show whose slot
   * passed while the machine was off is due NOW rather than next week, which is
   * the failure the whole file exists to avoid.
   *
   * Optional, and a show without one behaves exactly as it always did: due the
   * moment the arithmetic says so. Give every show a different slot and a
   * week's work arrives spread across the week instead of in one lump.
   */
  slot: slotSchema.optional(),

  /**
   * What this channel can put out in one week.
   *
   * A CEILING, NOT A TARGET. Nothing fills it; it only stops approvals piling
   * onto the same fortnight. Approving twelve shorts for a show that does three
   * a week fills the next four weeks rather than publishing twelve in twelve
   * days - because a cadence is a promise to somebody who follows the show, and
   * a studio that published everything the moment it was ready would have its
   * output decided by how fast the pipeline runs rather than by anybody.
   *
   * Zero for a kind means the channel does not publish that kind at all, and an
   * approval of one is left unscheduled rather than given a day it should not
   * have.
   */
  perWeek: z
    .object({
      episodes: z.number().int().nonnegative().default(1),
      shorts: z.number().int().nonnegative().default(3),
    })
    .default({ episodes: 1, shorts: 3 }),
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

  /**
   * The zone every slot is read in.
   *
   * An 8am slot means 8am where the listeners are. Naming the zone rather than
   * an offset means the platform's own database handles daylight saving, so the
   * studio does not publish an hour early for half the year.
   */
  timezone: z.string().default('Europe/London'),
});

export type Schedule = z.infer<typeof scheduleSchema>;
