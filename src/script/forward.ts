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
 * The same tic in the form it actually takes: rule things out, then say it.
 *
 * "No door forced, no glass broken, no alarm tripped on the way in, just a lift
 * shaft nobody had thought to watch." "Nothing clever, nothing out of a film,
 * just a car somebody noticed on a camera."
 *
 * A listener described it exactly: "to describe something it just doesn't say
 * it - if it needs to say situation A happened, it says not situation B, not C,
 * but A happened, which is not how people talk."
 *
 * Right, and the earlier checks missed every instance because they only looked
 * at the START of a sentence. This is the same move buried mid-sentence, and
 * it is the commonest form by some distance: five in one episode, none of them
 * caught. The shape is a negation, then within a short reach, a word that
 * announces the real answer.
 */
const RULED_OUT_THEN_ANSWERED =
  /\b(no|nothing|not|never|neither)\b[^.!?]{0,70}?\b(just|only|but|simply|merely|instead)\b/i;

/**
 * Defining something by what it is not, with the true version alongside it.
 *
 * "Real scientific claims, not folklore." "A large physical change, not a small
 * drift in a number." "Human data, not a mouse finding stretched to fit a
 * person." "In front of a scanner rather than a microscope." "How fast waste
 * leaves the tissue rather than how far a marker travels."
 *
 * TWENTY-FOUR OF NINETY-ONE SENTENCES, one every four, in an episode a listener
 * otherwise liked. They named it exactly: "it was X, not Y, not Z - I don't
 * like this kind of talking, just continue with facts."
 *
 * It is worth being precise about why this is worse out loud than on a page. A
 * reader whose eye lands on "not folklore" can look back at "real scientific
 * claims" for nothing. A listener cannot, so the negated half arrives as new
 * information, is held, and then has to be discarded once the sentence
 * resolves. Every one of these costs a listener a small piece of work whose
 * only product is a thing that was never true.
 *
 * DISTINCT FROM A NEGATIVE FACT, and the difference is the whole check.
 * "Nobody has built that mouse", "the record does not say who raised it",
 * "Franks does not back down" are findings - the absence IS the fact, and there
 * is no true alternative being withheld. Those are left alone. What is caught
 * is a positive assertion carrying a denied alternative in the same breath.
 */
const CONTRASTIVE_DEFINITION = [
  // "X, not Y" - the commonest by far, and the one the listener quoted.
  /,\s*(not|never|nor)\b/i,
  /\band not\b/i,
  // "X rather than Y", "X instead of Y", "X as opposed to Y".
  /\brather than\b/i,
  /\binstead of\b/i,
  /\bas opposed to\b/i,
  // "not X but Y", "not X, just Y" - the same move with the halves swapped.
  /\bnot\b[^.!?]{0,60}?\b(but|just|simply|merely)\b/i,
];

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
  // A RECAP WEARING A SENTENCE'S CLOTHES. "What followed was the gas, the
  // joint, the hiss the men heard, the blast at ten o'clock, and Bollands
  // thrown across the control room - all of it now explained." That lists five
  // things the episode has already told and then announces that it has
  // finished explaining them, which is the episode reporting on its own
  // progress rather than making any.
  /\ball of it now\b/i,
  /\bnow explained\b/i,
  /\bwhich we now know\b/i,
  /\bas (I|we) (said|mentioned)\b/i,
  /\bearlier in this\b/i,
  /\bto recap\b/i,
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

  const ruledOut = sentences.filter((s) => RULED_OUT_THEN_ANSWERED.test(s));
  if (ruledOut.length > 0) {
    problems.push({
      code: 'forward:ruledOutThenAnswered',
      detail:
        `${ruledOut.length} sentence(s) rule things out before saying what happened: ` +
        `"${ruledOut[0]!.slice(0, 70)}". Say what was there. A listener is not ` +
        `holding a list of possibilities for you to cross off.`,
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

  const contrastive = sentences.filter((s) => CONTRASTIVE_DEFINITION.some((re) => re.test(s)));
  if (contrastive.length > 0) {
    problems.push({
      code: 'forward:contrastiveDefinition',
      detail:
        `${contrastive.length} sentence(s) say what something is by pairing it with ` +
        `what it is not: "${contrastive[0]!.slice(0, 80)}". Delete the negated half ` +
        `and keep the fact. A listener cannot glance back, so the false version ` +
        `arrives as news, gets held, and then has to be thrown away. A negative ` +
        `FACT is fine - "nobody has run that study", "the record does not say who" ` +
        `- because there the absence is the finding.`,
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

/**
 * How long a repeated phrase must be, across beats, to count.
 *
 * LOWERED FROM FOUR TO THREE, because four was letting through exactly what a
 * listener complained about: "a lot of repetitive statements, describing the
 * same things in multiple ways". At three, one real episode gives twelve hits
 * and every one is genuine - the Hilti drill described twice in almost the same
 * words ("built for grinding through concrete and steel", then "built to eat
 * through concrete and steel"), "fourteen million pounds" three times, "twenty
 * past nine" twice.
 *
 * Three content words is short enough to catch a paraphrase and long enough not
 * to fire on ordinary English, with one exception that had to be handled: a
 * NAME is three content words and is legitimately repeated. See PROPER_NOUNS.
 */
const ACROSS_BEATS_GRAM = 3;
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
/**
 * Words the script capitalises mid-sentence, which are names.
 *
 * A NAME IS NOT A REPETITION. "Brian Reader" appears in the beat that
 * introduces him and again in the beat that sentences him, and it must - the
 * alternative is a pronoun the listener has to resolve, which is worse. So a
 * phrase made ENTIRELY of names is exempt, while "fourteen million pounds" and
 * "built to eat through concrete and steel" are not.
 *
 * Detected from the text rather than passed in, so this works for any show and
 * for a claim about somebody the plan never listed.
 */
const properNouns = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const words = sentence.replace(/\[[^\]]{0,40}\]/g, ' ').trim().split(/\s+/);
    // The first word of a sentence is capitalised for being first, so it tells
    // us nothing and is skipped.
    for (const raw of words.slice(1)) {
      const word = raw.replace(/[^A-Za-z0-9'’-]/g, '');
      if (/^[A-Z][a-zA-Z0-9'’-]*$/.test(word)) {
        out.add(word.toLowerCase().replace(/ies$/, 'y').replace(/(ed|ing|es|s)$/, ''));
      }
    }
  }
  return out;
};

/**
 * How many already-used phrases a closing beat may return to.
 *
 * A CALLBACK IS NOT A RESTATEMENT, and nothing mechanical can tell them apart,
 * so this is a budget rather than a rule. Restating is saying a thing again so
 * the listener does not miss it, which is padding. A callback returns to
 * something the listener already has in order to make it mean something
 * different now that they know the rest - and that is what an ending IS.
 *
 * COUNTED IN PHRASES, NOT IN CALLBACKS, because they are not the same number
 * and the first attempt at this set it to one and permitted nothing. A single
 * returned clause overlaps itself: "jailed over the Brinks Mat robbery of 1983"
 * is two three-word matches, not one, and a longer one is three or four.
 *
 * Measured on real sentences rather than guessed:
 *
 *   one callback   2 matches
 *   a full recap   22
 *
 * Four sits well clear of both, which is the whole reason to measure - a
 * threshold between 2 and 22 does not need to be precise, it needs to be in the
 * gap. Only the closing beat gets it; everywhere else the answer to "may I say
 * that again" is still no.
 */
export const CALLBACK_ALLOWANCE = 4;

export const checkRepetition = (
  text: string,
  storySoFar = '',
  opts: { isClose?: boolean } = {}
): ForwardProblem[] => {
  const problems: ForwardProblem[] = [];
  const words = contentWords(text);
  const names = properNouns(`${storySoFar}\n${text}`);
  const allNames = (gram: string) => gram.split(' ').every((w) => names.has(w));

  const already = new Set(gramsWithPositions(contentWords(storySoFar), ACROSS_BEATS_GRAM).keys());
  const across = [...gramsWithPositions(words, ACROSS_BEATS_GRAM).keys()].filter(
    (g) => already.has(g) && !allNames(g)
  );
  const allowance = opts.isClose ? CALLBACK_ALLOWANCE : 0;
  if (across.length > allowance) {
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
  'ALWAYS FORWARD. Never step back to correct an impression the listener never had. In particular: never "Not X. Y." or "This was not X, it was Y." Nobody thought X. Say what was true and let it be surprising on its own.',
  'NEVER PAIR A FACT WITH WHAT IT IS NOT. No "real claims, not folklore". No "a scanner rather than a microscope". No "instead of". No "as opposed to". Say the fact and stop: "real claims", "a scanner". The listener cannot look back at the first half, so the denied half arrives as news, gets held, and is then thrown away - which is work you charged them for nothing.',
  'A NEGATIVE FACT IS A DIFFERENT THING AND IS WELCOME. "Nobody has run that study", "the record does not say who", "it has never been measured in a person" are findings, and the absence is the point. What is banned is the contrast, not the word.',
  'GO IN ORDER. What happened first, then what followed from it. A sentence that reaches back to qualify something already said stops the episode; put the qualification in the sentence that needed it the first time.',
  'SAY EACH THING ONCE, across the whole episode and not just this beat. A phrase, a figure or a line from a document that has been used is spent. A listener told everything twice learns that missing a sentence costs nothing, and then stops listening properly.',
  'THAT INCLUDES DESCRIBING SOMETHING AGAIN IN DIFFERENT WORDS. If an earlier beat said the drill was built for grinding through concrete and steel, this beat says "the drill" and moves on. A second description is not a reminder, it is the episode standing still.',
  'TELL THE EVENTS, DO NOT DISCUSS THE EPISODE. No "here is where the story turns", no "you would be forgiven for thinking". Perform the turn by telling what happened next.',
  'The facts are what is interesting, so let them be. A drill bit, a price, a time on a clock, a name. If a stretch of the story is ordinary, tell it plainly and briefly and move on - an ordinary hour inflated into drama is the fastest way to lose somebody, because they can hear it.',
];
