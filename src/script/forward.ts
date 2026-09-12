/**
 * Keeping a told story moving forward, and out of its own way.
 *
 * WHERE THIS CAME FROM. A listener heard four minutes of the first solo episode
 * and described two faults precisely, before any check had a name for either:
 *
 *   "a lot of negative statements, statements that go back on themselves"
 *   "trying to make something normal into forcefully interesting"
 *
 * Both were real and both were mine. The counts on that episode, out of 132
 * sentences: four fragments opening "Not ...", two identity denials of the form
 * "these were not X, these were Y", and ten sentences about the telling rather
 * than about the events.
 *
 * THE NEGATION TIC IS CAUSED BY AN INSTRUCTION I WROTE. The narration guidance
 * said "say things twice, differently", because a listener cannot rewind. A
 * model implements say-it-twice as say-it-wrong-then-correct-it, because that
 * is the shape restatement takes in written argument:
 *
 *   "Reader's first conviction came in 1950, when he was eleven years old.
 *    NOT ELEVEN MONTHS INTO A CRIMINAL CAREER. Eleven years old, full stop."
 *
 * Nobody was ever going to think eleven months. The correction invents a
 * misunderstanding so it can fix one, and the listener hears the narrator
 * disagreeing with himself about something neither of them said. Two steps back
 * for every step forward.
 *
 * THE FIRST FIX WAS A HALF MEASURE. It kept the say-it-twice rule and made the
 * second pass additive - say it again with MORE, never with a denial. The same
 * listener rejected that too, and gave the reason: "the best engaging stories
 * are when people want to listen to what has been told, don't say anything
 * twice."
 *
 * That is the stronger position and it is the right one. Restatement of any
 * kind treats the listener's attention as something to insure against losing,
 * and an episode that repeats itself teaches them that missing a sentence costs
 * nothing - after which they stop holding on, which is the disengagement the
 * repetition was there to prevent. So the rule is gone rather than softened,
 * and checkRepetition below enforces its absence across the whole episode,
 * because a beat written on its own cannot see that it is restating another.
 *
 * THE META TIC IS CAUSED BY THE BEAT NAMES. A beat sheet with beats called
 * `wrong`, `objection` and `payoff` invites the writer to ANNOUNCE the turn
 * rather than perform it - "and here's where the story you think you're in
 * stops being the story you're actually in" - which is a sentence about the
 * episode's architecture, not about a burglary. Every one of those is the show
 * telling you to be interested instead of being interesting.
 *
 * WHY THESE ARE DETERMINISTIC CHECKS AND NOT JUST PROMPT LINES. A prompt line
 * is a hope. Both tics survived a draft-critique-revise loop on the last
 * episode because nothing in that loop was looking for them, and the style card
 * measures sentence length and variance, which both tics pass comfortably. A
 * count is the only thing that comes back and says whether the instruction
 * worked.
 */

export interface ForwardProblem {
  code: string;
  detail: string;
  blocking: boolean;
}

/** Sentences, with delivery tags removed so a tag never starts a sentence. */
const sentencesOf = (text: string): string[] =>
  text
    .replace(/\[[^\]]{0,40}\]/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * A fragment that opens by denying something nobody said.
 *
 * Deliberately only the sentence-initial "Not", which in narration is almost
 * always this construction. "No one comes" and "Nobody wrote that down" are
 * events and are left alone - they open on a subject, not on a denial.
 *
 * The rare legitimate case, "Not one of them talked", reads better as "None of
 * them talked" anyway, so the check costs nothing when it is wrong.
 */
const NEGATION_OPENER = /^Not\b/;

/**
 * "This is not X. This is Y." - the identity denial.
 *
 * The written-argument move for defining something by contrast. Out loud it
 * makes the listener hold a false version in mind while the true one arrives,
 * which is exactly the work a listener cannot do.
 */
const DENIAL_CONTRAST = /^(This|That|These|Those|It|He|She|They)\s+(is|was|were|are)\s+not\b/i;

/**
 * Sentences about the telling rather than about the events.
 *
 * Phrases, not a grammar, because the failure is idiomatic. Each one here was
 * said by a real draft.
 */
const ABOUT_THE_TELLING = [
  /\bthe story (you|we)\b/i,
  /\bthis episode\b/i,
  /\bI'?m telling you\b/i,
  /\bbefore I tell you\b/i,
  /\bI'?ll leave you\b/i,
  /\bworth (knowing|sitting with|telling)\b/i,
  /\byou'?d be forgiven\b/i,
  /\b(exactly )?what you'?d expect\b/i,
  /\bthe shorthand version\b/i,
  /\bhere'?s the (honest|real|actual) version\b/i,
  /\bwhat (I|we) want to (work out|show you|get to)\b/i,
  /\b(the )?rest of this (story|episode)\b/i,
];

/**
 * Check one beat for the two ways a told story stops going forward.
 *
 * `isOrientation` exempts the one beat whose JOB is to address the listener and
 * say what the episode will settle. Banning it there would remove the thing the
 * same listener asked for in the same breath - "there is no pre talk" - and the
 * orientation beat of the last episode was the part that worked.
 */
export const checkForward = (
  text: string,
  opts: { isOrientation?: boolean } = {}
): ForwardProblem[] => {
  const problems: ForwardProblem[] = [];
  const sentences = sentencesOf(text);

  const openers = sentences.filter((s) => NEGATION_OPENER.test(s));
  if (openers.length > 0) {
    problems.push({
      code: 'forward:negationOpener',
      detail:
        `${openers.length} sentence(s) open by denying something nobody said, ` +
        `starting with "${openers[0]!.slice(0, 60)}". Say what WAS, not what ` +
        `was not. If the point is that the fact is surprising, the fact is ` +
        `already surprising.`,
      blocking: true,
    });
  }

  const denials = sentences.filter((s) => DENIAL_CONTRAST.test(s));
  if (denials.length > 0) {
    problems.push({
      code: 'forward:denialContrast',
      detail:
        `${denials.length} sentence(s) define something by what it is not: ` +
        `"${denials[0]!.slice(0, 60)}". A listener has to hold the false ` +
        `version in mind while the true one arrives. State the true one.`,
      blocking: true,
    });
  }

  // A budget rather than a ban, because one aside to the listener in a
  // fifteen-minute told story is warmth, and three is a narrator who would
  // rather discuss the episode than tell it.
  const meta = sentences.filter((s) => ABOUT_THE_TELLING.some((re) => re.test(s)));
  const allowed = opts.isOrientation ? 99 : 1;
  if (meta.length > allowed) {
    problems.push({
      code: 'forward:aboutTheTelling',
      detail:
        `${meta.length} sentence(s) are about the telling rather than about ` +
        `what happened, e.g. "${meta[0]!.slice(0, 70)}". Tell the events. ` +
        `Announcing a turn is not the same as performing one.`,
      blocking: meta.length > allowed + 1,
    });
  }

  return problems;
};

/**
 * Words that carry meaning, stemmed, with their positions.
 *
 * Stop words go because "the men who had done time" and "those men that have
 * done time" are the same sentence to a listener and different strings to a
 * computer. Stemming is deliberately crude - trailing s/ed/ing/es/ies - because
 * the job is catching "looked" against "looks", not linguistics.
 *
 * Apostrophes are stripped rather than split on, or every contraction becomes
 * the token "t" and the whole episode looks like it repeats itself.
 */
const STOP_WORDS = new Set(
  (
    'a an the and or but of to in on at for with by from as is was were are be been ' +
    'that this these those it its he she they them him her his their you your we our i me my ' +
    'had has have do does did not no so then there here what which who whom when where why how ' +
    'would could should will can may might must just very also into out up down over under one'
  ).split(' ')
);

const contentWords = (text: string): string[] =>
  text
    .replace(/\[[^\]]{0,40}\]/g, ' ')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !STOP_WORDS.has(w))
    .map((w) => w.replace(/ies$/, 'y').replace(/(ed|ing|es|s)$/, ''));

const gramsWithPositions = (words: string[], n: number): Map<string, number[]> => {
  const out = new Map<string, number[]>();
  for (let i = 0; i + n <= words.length; i++) {
    const key = words.slice(i, i + n).join(' ');
    const at = out.get(key);
    if (at) at.push(i);
    else out.set(key, [i]);
  }
  return out;
};

/**
 * How far apart two uses of a phrase must be before it counts as restatement.
 *
 * "Box after box after box" is rhetoric and it is good. The same phrase two
 * paragraphs later is the narrator going over old ground. Distance is what
 * separates them, so distance is what the check measures rather than trying to
 * judge the phrase itself.
 */
const RESTATEMENT_GAP = 20;

/** Long enough to be a phrase rather than a collocation. Tuned on a real episode. */
const ACROSS_BEATS_GRAM = 4;
const WITHIN_BEAT_GRAM = 3;

/**
 * Anything this beat says that has already been said.
 *
 * WHY THIS CANNOT LIVE IN THE PROMPT. A beat is written by a call that is told
 * not to repeat the episode so far, and the last episode repeated it three
 * times anyway: the judge's phrase about ambition and planning appeared in the
 * orientation and again in the payoff, "knew exactly what a cell looked like"
 * appeared in two beats, and the sum of money was given twice inside one beat.
 * Instructions do not catch this because the writer does not experience it as
 * repeating - it is reaching for the best phrasing of a thing, and the best
 * phrasing is stable.
 *
 * `storySoFar` is the whole episode up to this beat, which is what makes this
 * the only check in the file that can see outside its own beat.
 */
export const checkRepetition = (text: string, storySoFar = ''): ForwardProblem[] => {
  const problems: ForwardProblem[] = [];
  const words = contentWords(text);

  const already = new Set(gramsWithPositions(contentWords(storySoFar), ACROSS_BEATS_GRAM).keys());
  const across = [...gramsWithPositions(words, ACROSS_BEATS_GRAM).keys()].filter((g) =>
    already.has(g)
  );
  if (across.length > 0) {
    problems.push({
      code: 'forward:repeatsEpisode',
      detail:
        `says something the episode has already said: "${across[0]}"` +
        (across.length > 1 ? ` and ${across.length - 1} other phrase(s)` : '') +
        `. The listener heard it. Say the next thing instead.`,
      blocking: true,
    });
  }

  const within = [...gramsWithPositions(words, WITHIN_BEAT_GRAM).entries()].filter(
    ([, at]) => at.length > 1 && at[at.length - 1]! - at[0]! >= RESTATEMENT_GAP
  );
  if (within.length > 0) {
    problems.push({
      code: 'forward:restatesItself',
      detail:
        `states the same thing twice in this beat: "${within[0]![0]}". Once, ` +
        `in the clearest sentence you can build, then move on.`,
      blocking: true,
    });
  }

  return problems;
};

/**
 * What the writer is told, so the checks above mostly do not have to fire.
 *
 * Phrased as what TO DO wherever possible. "Do not be forced" produces a
 * model's idea of unforced, which is flat.
 */
export const FORWARD_GUIDANCE = [
  'ALWAYS FORWARD. Every sentence adds something that was not there before. Never take a step back to correct an impression the listener never had.',
  'NEVER write "Not X. Y." or "This was not X, it was Y." Nobody thought X. Say what was true and let it be surprising on its own: "His first conviction was in 1950, when he was eleven" needs no help.',
  'SAY EACH THING ONCE. Not once and then again in other words, not once and then summarised at the end. A listener who is told everything twice learns that missing a sentence costs nothing, and then stops listening properly. Put the weight in the words instead, and trust them.',
  'This holds across the WHOLE episode, not just this beat. A phrase, a figure or a line from a document that has already been used is spent. If it was worth using, it was heard.',
  'TELL THE EVENTS, DO NOT DISCUSS THE EPISODE. No "here is where the story turns", no "you would be forgiven for thinking", no "what I want to work out with you". Perform the turn by telling what happened next. If it is a surprise, it will read as one.',
  'Interest comes from the facts being specific, not from being told they are interesting. A drill bit, a price, a time on a clock, a name. Never reach for a phrase that tells the listener how to feel about a fact.',
  'If a stretch of the story is ordinary, tell it plainly and briefly and move on. An ordinary hour inflated into drama is the fastest way to lose somebody, because they can hear it.',
];
