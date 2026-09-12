/**
 * How to write for one voice and one pair of ears.
 *
 * WHY THIS IS SEPARATE FROM THE DIALOGUE GUIDANCE. A dialogue script gets its
 * texture for free: two people interrupting each other produces varied pace,
 * rhetorical questions and changes of register without anyone writing them in.
 * A narrator has none of that. Every one of those effects has to be put in
 * deliberately, and a model given the dialogue instructions and one speaker
 * writes an essay and calls it narration.
 *
 * WHAT ACTUALLY GOES WRONG, from listening to a real episode rather than from
 * theory. The prose measured fine - short sentences, low clause depth, few
 * named entities per sentence, signposting present - and was still hard work.
 * The reasons were structural and every one of them is addressed below:
 *
 *   The listener never learned what they were listening to.
 *   The narrator never changed pace, so nothing felt more important.
 *   Facts arrived in the order the argument wanted, not the order they happened.
 *
 * A FOURTH ITEM USED TO SIT IN THAT LIST: "nothing was ever said twice, so a
 * moment's inattention was permanent". It was wrong, and the rule it produced
 * did more damage than the other three put together. See the note on the
 * say-it-once line below, and script/forward.ts.
 *
 * Phrased as things to DO. "Do not be complex" produces a model's idea of
 * simple, which is short flat sentences about nothing.
 *
 * NOTHING HERE MAY REPEAT EAR_RULES OR FORWARD_GUIDANCE, both of which are
 * composed into the same prompt. Two of these lines did - the breath limit and
 * the say-it-once rule - so the prompt forbidding repetition contained the same
 * instruction twice. Found by rendering the assembled prompt with
 * `foundry prompts` and reading it, and pinned by prompts/registry.test.ts.
 */

export const NARRATION_GUIDANCE = [
  'You are ONE person telling ONE listener a story out loud. Not reading an essay, not presenting. Write what you would actually say.',
  // THIS LINE USED TO SAY "say things twice, differently", AND IT WAS WRONG
  // TWICE OVER.
  //
  // First, a model implements say-it-twice as say-it-wrong-then-correct-it -
  // "eleven years old. Not eleven months into a criminal career. Eleven years
  // old, full stop" - because that is the shape restatement takes in written
  // argument. The listener hears the narrator arguing with himself about
  // something neither of them said. That much was fixed by making the second
  // pass additive rather than corrective.
  //
  // It was still wrong, and the listener said why: "the best engaging stories
  // are when people want to listen to what has been told, don't say anything
  // twice". Additive restatement is still restatement. The premise underneath
  // it - that a listener needs a safety net because they cannot rewind - treats
  // attention as something to be insured against losing rather than something
  // to be held. A story that repeats itself teaches the listener that missing a
  // sentence costs nothing, and then they stop holding on.
  //
  // The rule is gone, not softened. What replaces it is the thing the safety
  // net was standing in for: say it once, and say it so it does not need
  // saying again. checkRepetition in script/forward.ts enforces it across the
  // whole episode, because a beat cannot see that it is repeating another one.
  // The say-it-once rule itself lives in FORWARD_GUIDANCE, which every show
  // gets. Repeating it here is the fault it bans, in the prompt that bans it.
  'You get one pass at each thing, so choose precisely: the exact number, the person by name, the shortest sentence that carries it whole.',
  'Ask the question the listener is forming, out loud, and then answer it. "So why did nobody check? Because checking was somebody else\'s job, and that somebody had left in March." This is the single most important habit in solo narration - it is what a second host used to do.',
  'Change pace at the seams. Short sentences when it speeds up. One long one when it needs to land. A narrator at one speed for fifteen minutes is the flattest thing there is.',
  'Use "you" often, and mean it. "You can see where this is going." "If you were in that room, you would have believed him too."',
  'Put the person first in the sentence, then what they did. "The clerk wrote one line" beats "one line was written".',
  'Chronological. Say when things happened as a person says it - "that March", "two weeks later", "by the summer".',
  'Concrete nouns over abstractions. A door, a letter, a name, a number. Never "the situation", "the circumstances", "the nature of".',
  'Name things when you introduce them, and use the same name every time afterwards. A listener who meets "Geillis" and later hears "Duncan" is meeting two people.',
  'When the record does not say, say so plainly. "Nobody wrote that down" is more interesting than a guess and it is the show\'s whole credibility.',
];

/**
 * Delivery marks a narrator can use, and what each is for.
 *
 * THE TAGS ARE PART OF THE WRITING, not decoration added afterwards. A solo
 * voice has exactly one lever for emphasis, and it is delivery - so a script
 * with no marks in it is a script that will be read at one pitch for fifteen
 * minutes, which is the complaint every synthetic narration draws.
 *
 * Sparingly, though, and the reason is specific: a tag on every line is a tag
 * on nothing. The contrast is what carries, so the quiet part only lands if the
 * rest was not quiet.
 *
 * These pass through to Eleven v3, which reads them as performance direction. A
 * provider that does not understand a tag would SPEAK it, which is why
 * script/dialogue.ts strips anything outside the known list rather than hoping.
 */
export const NARRATION_TAGS = [
  'Mark delivery with tags in square brackets, on their own before the sentence they affect.',
  '[excited] for a detail you genuinely enjoy. [curious] for the question nobody asked.',
  '[serious] and [grim] for harm done to real people. Never for effect - this show does not perform gravity.',
  '[quietly] and [whispers] for the worst moment, which should be the quietest rather than the loudest.',
  '[rushed] when events outrun everyone. [slowly] and [drawn out] for the thing that will not be hurried.',
  '[wry] for the absurd detail, which real cases are full of. [warmly] for the people.',
  '[pauses] before a revelation, once or twice an episode at most.',
  'Three to six tags per beat. A tag on every line is a tag on nothing - the contrast is what carries.',
];
