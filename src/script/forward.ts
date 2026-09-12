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
 * for every step forward. The fix is not to ban restatement - restatement is
 * genuinely needed for the ear - but to make it ADDITIVE: say it again with
 * MORE, never with a denial.
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
 * What the writer is told, so the checks above mostly do not have to fire.
 *
 * Phrased as what TO DO wherever possible. "Do not be forced" produces a
 * model's idea of unforced, which is flat.
 */
export const FORWARD_GUIDANCE = [
  'ALWAYS FORWARD. Every sentence adds something that was not there before. Never take a step back to correct an impression the listener never had.',
  'NEVER write "Not X. Y." or "This was not X, it was Y." Nobody thought X. Say what was true and let it be surprising on its own: "His first conviction was in 1950, when he was eleven" needs no help.',
  'When you say something twice for the ear - and you should, because a listener cannot rewind - say it again with MORE, not with a denial. "Eleven weeks. The alarm was off from the start of March until the middle of May."',
  'TELL THE EVENTS, DO NOT DISCUSS THE EPISODE. No "here is where the story turns", no "you would be forgiven for thinking", no "what I want to work out with you". Perform the turn by telling what happened next. If it is a surprise, it will read as one.',
  'Interest comes from the facts being specific, not from being told they are interesting. A drill bit, a price, a time on a clock, a name. Never reach for a phrase that tells the listener how to feel about a fact.',
  'If a stretch of the story is ordinary, tell it plainly and briefly and move on. An ordinary hour inflated into drama is the fastest way to lose somebody, because they can hear it.',
];
