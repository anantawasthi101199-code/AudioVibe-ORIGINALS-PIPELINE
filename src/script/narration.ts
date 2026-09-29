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
  // THE RULE THE WHOLE THING RESTS ON, and it was missing entirely.
  //
  // A listener cannot re-read, cannot look back, and is holding everything in
  // working memory. What makes that possible is a chain: this happened, which
  // caused that, which is why the next thing happened. What breaks it is a
  // sentence that arrives from nowhere, or a fact stated because it is true
  // rather than because it is next.
  //
  // Measured on a real set: the story a listener called brilliant is strictly
  // chronological - the gods and demons agree, they need a rod and a rope, the
  // rod is a mountain, the rope is a serpent, the demons take the head end.
  // Every sentence is caused by the one before it. The story they called worse
  // is a list of things the sources say about a subject, in no order at all.
  'TELL IT IN ORDER, AND MAKE EACH THING CAUSE THE NEXT. What happened first, what that led to, what followed from that. A listener is holding the whole thing in their head with nothing to look back at, and a chain is the only shape that survives that. If two facts have no causal link, the second one probably does not belong.',
  'MAKE IT SEEABLE. A listener should be able to picture what you are describing: who is in the room, where they are standing, what is in their hands, what moves. Concrete nouns and physical actions do this; abstractions and categories do not. "The rope was Vasuki, a great serpent, wound around the mountain so both sides could pull on him" can be seen. "A cooperative arrangement was established" cannot.',
  // THE CARVE-OUT WAS MISSING AND THE PIPELINE CONTRADICTED ITSELF.
  //
  // This line banned the frame a quotation needs - "one text names", "the record
  // says" - while myth-told's `story` beat requires "where the text itself
  // matters, say so HERE", and the show's own canon asks for the manuscript
  // detail "at the moment it bites". Two instructions in the same prompt, one
  // asking for the thing the other forbade, and the result was a script that
  // quoted nothing.
  //
  // The decision this preserves is the real one: do not report on the state of
  // scholarship. The thing it was over-reaching into is different: naming the
  // text you are about to read from is not narrating the research, it is
  // attribution, and it takes four words.
  'NEVER NARRATE THE STATE OF THE RESEARCH. The subject is what happened. No "the sources do not settle", no "there is also a claim that", no summarising what scholars think. If something is known, say it as a thing that happened. If it is not known, leave it out, which is what somebody who knew the subject would do.',
  'BUT THE TEXT ITSELF IS PART OF THE STORY, and naming it is not narrating research. "The oldest copy of this stops here." "The line is broken and nobody can translate it." "In the version a monk wrote out four hundred years later, she goes willingly." Say those at the moment they bite, in the telling, where they are the most interesting sentence in the beat. Never as a preamble at the front, where the same sentence is bibliography.',
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
