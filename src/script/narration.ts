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
  'You are ONE person telling a story out loud, from beginning to end, to somebody who has never heard it. Not reading an essay, not presenting.',
  'THE STORY AND THE FACTS ARE THE SUBJECT. Not the listener, and not the telling. "You can see where this is going" and "if you were in that room" are sentences spent on the audience instead of on what happened. Address the listener directly only where it genuinely earns its place, which is rarely.',
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
  // The rhetorical question used to be instructed here as "the single most
  // important habit in solo narration", which is how it became a tic: two per
  // hundred words, one every fifteen seconds. It is a device a show may want,
  // not something every narrated show must do, so it now lives in the persona
  // canon of the show that wants it and at the rate that show wants it.
  // Pace belongs to the show too, and this show's canon says it better and at
  // its own rate. Same reason as the rhetorical question above: a device a
  // narrated show may want is not a rule every narrated show needs.
  'A narrator at one speed for fifteen minutes is the flattest thing there is.',
  // THE LISTENER IS BUILDING A PICTURE AND HAS NOTHING TO BUILD IT FROM but
  // what is said. That is the actual constraint of audio, and it is different
  // from "keep it simple": a listener who cannot see the place cannot follow
  // who moved where, and loses the scene without noticing they have lost it.
  'LET THEM SEE IT. Before anything happens in a place, say what the place is like in a sentence or two - how big, how dark, what is underfoot, who else is there. A listener is building the picture from nothing, and they cannot follow people moving through a room they have not been given.',
  'Give size and distance by comparison, never by number alone. "A hundred and seventy-five feet down" means little; "as far down as a fifteen-storey building" can be seen. Do both if the exact figure matters.',
  'Say where people are in relation to each other and to the thing that matters. Who is nearest the door, what is between them and the way out, what they can and cannot see from where they are standing.',
  'Chronological. Say when things happened as a person says it - "that March", "two weeks later", "by the summer".',
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
  'Mark delivery with a tag in square brackets, on its own before the sentence it affects.',
  // THE LIST IS NOT ADVICE, IT IS THE VOCABULARY. Anything outside it would be
  // SPOKEN by the voice rather than performed, so script/dialogue.ts strips
  // unknown tags - which means an unlisted tag is silently lost rather than
  // wrong. Naming them is the one part of this that has to be prescriptive.
  'The available tags: [excited] [curious] [serious] [grim] [quietly] [whispers] [rushed] [slowly] [drawn out] [wry] [warmly] [pauses]. Anything else is discarded.',
  // The rule against performing gravity the facts have not earned belongs to
  // the show, not to the tag list, and this repeated it. The persona's taboos
  // already carry it into the same prompt.
  'Use them where the delivery genuinely changes, three to six times in a beat. A tag on every line is a tag on nothing.',
];
