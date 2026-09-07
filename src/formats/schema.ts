/**
 * An episode's shape, as data.
 *
 * WHAT THIS IS, AND WHAT IT IS EXPLICITLY NOT. Formats are where "learn from
 * the best shows in this genre" lives, and it is done as STRUCTURAL GRAMMAR:
 * where the hook lands, how many seconds before the first payoff, how tension
 * is renewed, where evidence density peaks, how often a callback fires.
 *
 * What never happens is ingesting somebody's transcripts and paraphrasing them.
 * That is infringement, and separately it produces worse output than working
 * from structure does - a paraphrase inherits the other show's specifics, which
 * are the part that does not transfer. Structure is the part that does.
 *
 * WHY BEATS AND NOT A PROSE BRIEF. Three things fall out of describing an
 * episode as a list of bounded beats, and none of them are available from "write
 * a ten minute case study":
 *
 *   1. Evidence density is enforceable per beat. The mechanism section can be
 *      required to carry four sourced claims; an intro cannot.
 *   2. The writer fills one beat at a time against one job, instead of holding
 *      a whole episode in its head and losing the shape halfway through.
 *   3. Beats get START AND END TIMESTAMPS at render. That is what lets listener
 *      drop-off be attributed to a KIND of beat rather than to an episode, and
 *      that attribution is the entire feedback signal the format library learns
 *      from later.
 */
import { z } from 'zod';

/**
 * What a beat is FOR. Deliberately a closed set.
 *
 * The learned priors in stage 9 aggregate retention across shows by this field,
 * so it has to mean the same thing in every format. A free-text label would
 * make "cold opens over twelve seconds cost 22 percent" unanswerable.
 */
export const beatTypeSchema = z.enum([
  /** Opens with the anomaly and no context. Earns the next thirty seconds. */
  'cold_open',
  /** Who this mattered to and how much. */
  'stakes',
  /** The minimum background needed to follow what comes next. */
  'context',
  /** Tension renewal: introduces the complication that makes the obvious reading wrong. */
  'turn',
  /** The actual causal explanation. Highest evidence density in any format. */
  'mechanism',
  /** The strongest case against the episode's own reading. */
  'counterpoint',
  /** What it resolves to. */
  'payoff',
  /** A concrete accounting: money, time, jobs, whatever was actually lost or won. */
  'reckoning',
  /** A reference to an earlier episode. Optional by nature. */
  'callback',
  /** Closing. Deliberately short in every format here. */
  'outro',
]);

export type BeatType = z.infer<typeof beatTypeSchema>;

export const beatSchema = z.object({
  /** Unique within the format. Appears in the beat map sent to the platform. */
  id: z.string().regex(/^[a-z0-9_]+$/, 'lowercase, digits and underscores only'),

  type: beatTypeSchema,

  /** Target duration range in seconds, spoken. */
  seconds: z.tuple([z.number().positive(), z.number().positive()]),

  /** One sentence telling the writer what this beat has to accomplish. */
  function: z.string().min(1),

  /**
   * Hard rules for this beat, passed to the writer and checked afterwards.
   *
   * Phrased as prohibitions where possible. "One sentence" and "no 'in this
   * episode'" are checkable; "be punchy" is not.
   */
  constraints: z.array(z.string().min(1)).default([]),

  /**
   * Minimum sourced claims this beat must carry.
   *
   * The mechanism beat is where a show either did the reading or did not, so it
   * carries a floor. An intro carries none, and requiring one there would push
   * the writer to decorate a hook with a statistic.
   */
  minClaims: z.number().int().nonnegative().default(0),

  /**
   * Whether the beat may be dropped.
   *
   * `counterpoint` is required in every format here on purpose. Confident
   * one-sidedness is the most common way generated content is false while every
   * individual sentence is sourced, and making the beat optional is how it
   * quietly stops appearing.
   */
  optional: z.boolean().default(false),
});

export type Beat = z.infer<typeof beatSchema>;

export const formatSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/, 'lowercase, digits and hyphens only'),
    name: z.string().min(1),

    /** Long form or short form. Shorts are derived from a beat of a long episode. */
    kind: z.enum(['long', 'short']),

    /** One sentence on what this shape is good for. */
    intent: z.string().min(1),

    /** Total target duration in seconds. Checked against the sum of the beats. */
    targetSeconds: z.tuple([z.number().positive(), z.number().positive()]),

    beats: z.array(beatSchema).min(2),

    /**
     * Intended tension at each beat, 0 to 1, one entry per beat.
     *
     * Not used to generate anything directly. It exists so the shape is
     * REVIEWABLE by a person: a curve that only rises is a format with no
     * breathing room, and a flat one is a format with no shape at all. Both are
     * obvious here and invisible in a list of beats.
     */
    tensionCurve: z.array(z.number().min(0).max(1)),
  })
  .superRefine((format, ctx) => {
    if (format.tensionCurve.length !== format.beats.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tensionCurve'],
        message: `has ${format.tensionCurve.length} entries but there are ${format.beats.length} beats`,
      });
    }

    const ids = format.beats.map((b) => b.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['beats'],
        message: `duplicate beat ids: ${[...new Set(dupes)].join(', ')}`,
      });
    }

    // The beats have to be able to add up to the episode. A format whose beats
    // cannot reach its target silently produces short episodes, and one whose
    // minimum already overshoots produces long ones - both discovered at render
    // time, which is much later than here.
    const [minTotal, maxTotal] = format.beats.reduce(
      ([lo, hi], b) => [lo + b.seconds[0], hi + b.seconds[1]],
      [0, 0]
    );
    const [targetLo, targetHi] = format.targetSeconds;
    if (minTotal > targetHi || maxTotal < targetLo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetSeconds'],
        message:
          `beats span ${minTotal}-${maxTotal}s which cannot reach the target ` +
          `${targetLo}-${targetHi}s`,
      });
    }
  });

export type EpisodeFormat = z.infer<typeof formatSchema>;

/** Total claim floor for a format, used to size the evidence corpus. */
export const minClaimsFor = (format: EpisodeFormat): number =>
  format.beats.reduce((n, b) => n + b.minClaims, 0);

/** Midpoint duration, used for budgeting a render before one exists. */
export const nominalSeconds = (format: EpisodeFormat): number =>
  (format.targetSeconds[0] + format.targetSeconds[1]) / 2;
