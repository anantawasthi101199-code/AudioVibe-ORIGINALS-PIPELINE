/**
 * Every string in this file is VERBATIM from the first solo episode, which a
 * listener described as "statements that go back on themselves" and "trying to
 * make something normal into forcefully interesting".
 *
 * Using the real sentences rather than invented ones matters here. A check
 * written against made-up examples tends to catch made-up examples: the tic as
 * a model actually produces it has a particular shape, and these are that
 * shape.
 */
import { checkBridge, checkDistinctStories, checkForward, checkRepetition } from '../forward';

const codes = (text: string, isOrientation = false) =>
  checkForward(text, { isOrientation }).map((p) => p.code);

describe('checkForward - the negation tic', () => {
  /**
   * A BUDGET OF ONE NOW, so these assert the TIC rather than the construction.
   *
   * Measured over 129 beat-sized chunks of the reference corpus: 11% of them open
   * a sentence with "Not". A flat ban refused writing the owner named as the
   * standard. The episode that prompted the check had FOUR in one beat, which is
   * what a tic looks like and what these fixtures now carry.
   */
  it('catches a beat full of fragments that deny something nobody said', () => {
    const real =
      "Reader's first conviction for burglary came in 1950, when he was eleven years old. " +
      'Not eleven months into a criminal career. Eleven years old, full stop. ' +
      'Not a legend, not a heist film pitch.';
    expect(codes(real)).toContain('forward:negationOpener');
  });

  it('catches the rest of them from the same episode', () => {
    const real = [
      'Not a legend, not a heist film pitch.',
      'Not from the newspaper version, not from whatever you already half-remember.',
      'Not a gang bursting through a wall with a sledgehammer.',
    ].join(' ');
    expect(codes(real)).toContain('forward:negationOpener');
  });

  it('allows ONE, because the reference corpus does it', () => {
    expect(codes('Not one of them said a word to the police.')).toEqual([]);
  });

  it('leaves alone a negative that is an EVENT rather than a correction', () => {
    // "No one comes" is the most important sentence in the cold open. It opens
    // on a subject, not on a denial, and a check that could not tell the
    // difference would be worse than no check.
    expect(codes('Somewhere in the building, an alarm starts screaming. No one comes.')).toEqual(
      []
    );
    expect(codes('Nobody wrote that down.')).toEqual([]);
  });

  it('catches defining something by what it is not', () => {
    expect(codes('These were not young men chasing a thrill.')).toContain(
      'forward:denialContrast'
    );
    expect(codes('This is not a smash-and-grab crew improvising on the fly.')).toContain(
      'forward:denialContrast'
    );
  });

  it('sees through a tag at the head of a sentence', () => {
    // Tags are stripped first, or "[quietly] Not..." would be invisible and
    // "[quietly] Nobody came" might look like one. Two of them, because one is
    // inside the budget - what is under test here is the stripping, not the count.
    expect(
      codes('[quietly] Not a single door was locked. [grim] Not a window either.')
    ).toContain('forward:negationOpener');
  });

  it('still says nothing when a tagged sentence is the only one', () => {
    expect(codes('[quietly] Not a single door was locked.')).toEqual([]);
  });
});

/**
 * The form the tic actually takes in a finished episode.
 *
 * Twenty-four of ninety-one sentences in a health episode paired a fact with a
 * denied alternative, and a listener named it without being asked: "it was X,
 * not Y, not Z - I don't like this kind of talking, just continue with facts."
 * None of the earlier patterns caught any of them, because every one of those
 * looked for a negation at the START of a clause and this one trails.
 */
describe('checkForward - pairing a fact with what it is not', () => {
  /**
   * A BUDGET NOW, NOT A BAN, so these assert DETECTION rather than blocking.
   *
   * The tic is real and was measured at 24 of 91 sentences in one episode. But
   * running the check over two long-form transcripts the owner named as the
   * target fired it seven times on one of them, and objected hardest to the
   * hinge sentence the whole second half turns on ("Not because he was more
   * powerful, but because his story survives in detail"). One use is a good
   * sentence; six is a habit. See CONTRASTIVE_BUDGET.
   */
  const detected = (text: string) =>
    checkForward(text).some((p) => p.code === 'forward:contrastiveDefinition');

  /** Enough of the shape to exceed the budget, so detection is observable. */
  const thrice = (text: string) => [text, text, text].join(' ');

  const caught = (text: string) => detected(thrice(text));

  it.each([
    ['a trailing comma denial', 'All three are real scientific claims, not folklore.'],
    ['the same with a scale', 'That is a large, physical change, not a small drift in a number.'],
    ['rather than', 'They put it in front of a scanner rather than a microscope.'],
    ['instead of', 'Instead of confirming it, the tissue approach pointed the other way.'],
    ['as opposed to', 'The scan shows shape as opposed to movement.'],
    ['and not', 'It came from mice and not from a living human head.'],
    ['not X but Y', 'It is not a theory but a measurement.'],
  ])('catches %s once the budget is past', (_label, text) => {
    expect(caught(text)).toBe(true);
  });

  it('allows ONE, because the hinge sentence in the reference transcript is one', () => {
    // Verbatim from the transcript the owner named as the target. Under the old
    // ban this was a blocking failure, which is how a check ends up rejecting
    // the thing it is supposed to be aiming at.
    expect(
      detected(
        'But of the seven, there was one that was given more attention. ' +
          'Not because he was more powerful, but because his story survives in detail.'
      )
    ).toBe(false);
  });

  it('blocks only when the beat is full of it', () => {
    const one = checkForward('It is not a theory but a measurement.');
    expect(one.some((p) => p.code === 'forward:contrastiveDefinition')).toBe(false);

    const many = checkForward(
      Array.from({ length: 6 }, () => 'It is not a theory but a measurement.').join(' ')
    );
    expect(
      many.some((p) => p.code === 'forward:contrastiveDefinition' && p.blocking)
    ).toBe(true);
  });

  it('leaves the older rule-out-then-answer form to the older check', () => {
    // "No door forced, no glass broken, just a lift shaft" is the same move and
    // is owned by ruledOutThenAnswered. Pinning which check owns it keeps the
    // two from drifting into overlapping, differently-worded advice for one
    // sentence. Repeated past both budgets so each fires.
    const codes = checkForward(
      Array.from({ length: 4 }, () => 'No door forced, no glass broken, just a lift shaft.').join(' ')
    )
      .map((p) => p.code);

    expect(codes).toContain('forward:ruledOutThenAnswered');
    expect(codes).not.toContain('forward:contrastiveDefinition');
  });

  /**
   * THE HALF THAT MUST SURVIVE, and the reason this is not simply a ban on the
   * word "not".
   *
   * "Nobody has run that study" is a finding. The absence IS the fact, there is
   * no true alternative being withheld, and a show whose whole claim is that it
   * says how well something is known needs to be able to say it. Banning the
   * word would have made this show unable to state its own subject.
   */
  it.each([
    'Nobody has built that mouse.',
    'The record does not say who first raised it.',
    'Franks does not back down from that.',
    'That agreement did not last.',
    'It has never been measured in a living person.',
    'No study has followed them for longer than a year.',
  ])('leaves a negative FACT alone: %s', (text) => {
    expect(caught(text)).toBe(false);
  });

  it('is quiet on plain chronological reporting', () => {
    expect(
      caught(
        'The trial enrolled forty-one adults and ran for six months. ' +
          'Each of them recorded four measures every evening. The effect held at eleven weeks.'
      )
    ).toBe(false);
  });

  it('counts them, so a beat full of the tic says how full', () => {
    const problem = checkForward(
      'It is data, not folklore. They used a scanner rather than a microscope. ' +
        'It measures shape as opposed to movement.'
    ).find((p) => p.code === 'forward:contrastiveDefinition');

    expect(problem!.detail).toMatch(/^3 sentence/);
  });
});

/**
 * Ten stories that turn out to be eight.
 *
 * A set on Puranic myth came back with Nandi's birth told twice and Garuda's
 * theft of the nectar told twice: same sage, same boon, same egg, same ransom,
 * different words. Each of these becomes its own short and is heard alone, so
 * the second telling is a short somebody has already heard.
 */
describe('checkDistinctStories', () => {
  const NANDI_A =
    'This is how Shiva got Nandi, the bull who stands at his door. The Shiva Purana ' +
    'traces him to a sage named Shilada, who wanted a child of a particular kind and ' +
    'undertook a long and severe penance asking for a son who would be immortal and ' +
    'carry Shiva own blessing. The boon was granted and the son who resulted was Nandi.';
  const NANDI_B =
    'This is the story of Nandi, the bull who guards Shiva door and carries him as his ' +
    'mount, and of the exact wording of the request that brought him into being. A sage ' +
    'named Shilada performs a long penance in search of a son, and the boon he asks for ' +
    'is precise, a child who will never die, marked from birth with Shiva own favour.';
  const GANGA =
    'The river Ganga came down from the sky to the earth, and the descent is told across ' +
    'several texts. A king spent his life asking for it, and the weight of the falling ' +
    'water would have split the ground, so it was caught and slowed in a god matted hair ' +
    'before it was allowed to reach the plain at all.';

  it('catches the same story told twice', () => {
    const problems = checkDistinctStories([
      { id: 'story_04', text: NANDI_A },
      { id: 'story_08', text: NANDI_B },
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.blocking).toBe(true);
    expect(problems[0]!.detail).toMatch(/story_04.*story_08/);
    expect(problems[0]!.detail).toMatch(/same story told twice/);
  });

  it('leaves two genuinely different stories alone', () => {
    expect(checkDistinctStories([
      { id: 'story_04', text: NANDI_A },
      { id: 'story_05', text: GANGA },
    ])).toEqual([]);
  });

  /**
   * THE DISTINCTION THE THRESHOLD HAS TO CARRY, in the listener's own words:
   * "the same topic is not a problem, it shouldn't be the same story."
   */
  it('allows a second story about the same figure', () => {
    const nandiElsewhere =
      'Nandi does not only carry Shiva. He sits at every temple gate facing inward, and ' +
      'a worshipper whispers a request between his horns rather than saying it aloud at ' +
      'the shrine, which is a practice the texts never explain and which every visitor ' +
      'to a Shiva temple in south India is shown how to do within a minute of arriving.';

    expect(checkDistinctStories([
      { id: 'story_04', text: NANDI_A },
      { id: 'story_09', text: nandiElsewhere },
    ])).toEqual([]);
  });

  it('checks every pair, not just neighbours', () => {
    const problems = checkDistinctStories([
      { id: 'story_01', text: NANDI_A },
      { id: 'story_02', text: GANGA },
      { id: 'story_03', text: NANDI_B },
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.detail).toMatch(/story_01.*story_03/);
  });
});

describe('checkRepetition', () => {
  const codesOf = (text: string, soFar = '') => checkRepetition(text, soFar).map((p) => p.code);

  it('catches a beat restating a phrase from an earlier beat', () => {
    // Verbatim from the episode. The `before` beat said the first; the `wrong`
    // beat, written by a call that could see it and was told not to repeat it,
    // said the second anyway.
    const before =
      'These were men who had done time and done it again and knew exactly what a cell looked like.';
    const wrong =
      "You've done time before, more than once, and you know exactly what a cell looks like from the inside.";
    expect(codesOf(wrong, before)).toContain('forward:repeatsEpisode');
  });

  it('sees through a change of tense or number', () => {
    // "looked"/"looks" and "alarms"/"alarm" are the same to a listener and
    // different strings to anything that does not stem. Four content words is
    // the floor for a match, so the phrase has to be at least that long - which
    // is the point of the floor: shorter than that is a collocation, not a
    // repeated idea.
    expect(
      codesOf(
        'the alarms in the building were screaming into an empty stairwell',
        'an alarm in the building was screaming into an empty stairwell'
      )
    ).toContain('forward:repeatsEpisode');
  });

  it('ignores a short phrase two sentences happen to share', () => {
    // Three content words or fewer is ordinary English, not restatement. A
    // check that fired on it would be turned off within a week.
    expect(codesOf('He went down the shaft.', 'She climbed the shaft.')).toEqual([]);
  });

  it('catches a quotation used twice in one episode', () => {
    // The judge's phrase, given in the orientation and again in the payoff.
    const orientation = 'in a class of its own for its scale of ambition, planning, preparation and organisation';
    const payoff = 'this stood in a class of its own, for its ambition, its planning, its preparation, its organisation';
    expect(codesOf(payoff, orientation)).toContain('forward:repeatsEpisode');
  });

  /**
   * A BUDGET OF TWO NOW, so this fixture carries the three repeats the real
   * episode had rather than the one it used to.
   *
   * At zero, this check fired on 47% of 129 beat-sized chunks of the reference
   * corpus. Part of that was a genuine bug - a phrase made entirely of names was
   * exempt across beats and not within one, so a term of art used twice counted -
   * and the rest is that four hundred words of real speech reuses a phrase now and
   * then. The measured fault was several repeats in one beat: the drill described
   * twice in nearly the same words, the sum of money three times, the time on the
   * clock twice.
   */
  it('catches a beat that circles the same things several times', () => {
    const payoff =
      'Property now put at just short of fourteen million pounds. ' +
      'The drill was built for grinding through concrete and steel, and they went in at twenty past nine. ' +
      'Diamonds, gold, jewellery, cash, all of it sitting behind those boxes for exactly this reason, ' +
      'and all of it gone by the time the sun came up on the Sunday. It did not stay theirs. ' +
      'The drill was built for grinding through concrete and steel, which is why the wall gave way. ' +
      'They had come back at twenty past nine on the second night as well. ' +
      'Which means two thirds of nearly fourteen million pounds simply never came back.';
    expect(codesOf(payoff)).toContain('forward:restatesItself');
  });

  it('allows a phrase reused once, which real speech does constantly', () => {
    const fine =
      'Property now put at just short of fourteen million pounds. ' +
      'Diamonds, gold, jewellery, cash, all of it sitting behind those boxes for exactly this reason, ' +
      'and all of it gone by the time the sun came up on the Sunday. It did not stay theirs. ' +
      'Which means two thirds of nearly fourteen million pounds simply never came back.';
    expect(codesOf(fine)).not.toContain('forward:restatesItself');
  });

  it('leaves deliberate adjacent repetition alone', () => {
    // "Box after box after box" is rhetoric, and it is good. Distance is what
    // separates rhetoric from going over old ground, so distance is what the
    // check measures.
    expect(codesOf('they had gone through box after box after box')).toEqual([]);
  });

  it('does not fire on contractions, which used to look like repetition', () => {
    // Splitting on the apostrophe turns every "don't" into the token "t", and
    // then an episode of ordinary speech reports itself as repetitive.
    //
    // The example changed when the across-beat threshold dropped to three
    // content words: the old one was "they don't know / she doesn't know what
    // he doesn't know", which at three words genuinely IS a repeated phrase.
    // A test fixture that only passed because the threshold was too loose was
    // testing the threshold, not the contractions.
    const soFar = "They don't know who unlocked the shutter that night.";
    expect(codesOf("She doesn't remember the name on the lease.", soFar)).toEqual([]);
  });

  it('is quiet on an episode that says each thing once', () => {
    const soFar = 'The lift was disabled at half past nine. They climbed down the shaft.';
    expect(codesOf('The drill bit into the wall until the pump gave out at four in the morning.', soFar)).toEqual(
      []
    );
  });
});

describe('checkForward - talking about the telling', () => {
  const meta = [
    "And here's where the story you think you're in stops being the story you're actually in.",
    "You'd be forgiven for thinking that's the end of it.",
    'That is exactly what you would expect.',
    "One last thing worth knowing, and then I'll leave you with it.",
  ].join(' ');

  it('catches a beat that keeps discussing itself', () => {
    expect(codes(meta)).toContain('forward:aboutTheTelling');
  });

  it('allows one aside, because one is warmth', () => {
    expect(codes("You'd be forgiven for thinking that's the end of it.")).toEqual([]);
  });

  it('exempts the orientation beat, whose job is to address the listener', () => {
    // The same listener who objected to the forced engagement also said there
    // was "no pre talk". Orientation is the pre-talk, and it must stay free to
    // say what the episode is and what it will settle.
    expect(codes(meta, true)).toEqual([]);
  });
});

describe('the closing beat may make one callback', () => {
  /**
   * TWO INSTRUCTIONS THAT CONTRADICTED EACH OTHER, and the contradiction was
   * mine. A listener asked for no repetition, so checkRepetition blocks any
   * phrase reused across beats. The same listener then asked for "a summary or
   * a callback and a proper ending" - and a callback is repetition by that
   * rule.
   *
   * Restating is saying a thing again so the listener does not miss it, which
   * is padding. A callback returns to something they already have so it means
   * something different now they know the rest, which is what an ending IS.
   * Nothing mechanical tells those apart, so the close gets a small budget and
   * every other beat still gets nothing. Counted in matched phrases rather than
   * in callbacks, because one returned clause overlaps itself into two or three
   * matches - measured at 2 for a callback against 22 for a recap.
   */
  const earlier =
    'Reader was jailed over the Brinks Mat robbery back in 1983, when thieves took twenty-six million in gold.';
  const callback =
    'Sixty-five years later he was jailed over the Brinks Mat robbery of 1983, and then he went down a lift shaft.';

  it('allows a single returned phrase when closing', () => {
    expect(checkRepetition(callback, earlier, { isClose: true })).toEqual([]);
  });

  it('still blocks the same phrase anywhere else', () => {
    expect(checkRepetition(callback, earlier).map((p) => p.code)).toContain(
      'forward:repeatsEpisode'
    );
  });

  it('does not let the close become a recap', () => {
    // One callback is an ending. Four is the episode again in worse words.
    const recap =
      'Reader was jailed over the Brinks Mat robbery back in 1983, when thieves took twenty-six million in gold, ' +
      'and Perkins was convicted in 1985 over the Security Express job that took close to six million pounds.';
    const soFar =
      earlier +
      ' Perkins was convicted in 1985 over the Security Express job that took close to six million pounds.';
    expect(checkRepetition(recap, soFar, { isClose: true }).map((p) => p.code)).toContain(
      'forward:repeatsEpisode'
    );
  });
});

/**
 * THE CHECKS, MEASURED AGAINST REAL WRITING IN BOTH DIRECTIONS.
 *
 * Every string below is verbatim from something: the two long-form transcripts
 * the owner named as the target, or a script this pipeline actually produced.
 * None of it is invented, because both of these checks were wrong in ways an
 * invented example would not have exposed.
 *
 * The recall half exists because a check that fires on good writing is worse
 * than no check at all. checkBridge reported all four non-final beats of a real
 * episode as ending flat while every one of them handed over cleanly, and it
 * burned both revision passes nagging for something already done. DENIAL_CONTRAST
 * called "She was not ready for what waited at the first gate" a fault, which is
 * a negative fact and exactly what FORWARD_GUIDANCE says is welcome.
 */
describe('checkBridge - recognising a real handover', () => {
  const bridges = (t: string) => checkBridge(t, {}).length === 0;

  it.each([
    ['of the seven', 'It was something that arrived fully formed. But of the seven, there was one that was given more attention.'],
    ['a key event', 'What is also important about the Apkallu was the time that they existed. A key event would change everything.'],
    ['the next step', 'This suggests they were part of a protective practice. And that leads to the next step in their story.'],
    ['a question', 'The knowledge of humanity advanced overnight. So what does the evidence actually show?'],
    ['a promise', 'He wants his name to live forever, and you will see how important that is later.'],
    ['a consequence pending', 'However you tell it, one thing is clear. They had just flipped off the gods, and the gods had noticed.'],
    ['a curse not yet paid', 'May Enkidu have no one to bury him. It would not be long before it came true.'],
  ])('recognises the reference hinge: %s', (_l, text) => {
    expect(bridges(text)).toBe(true);
  });

  it.each([
    ['you need to know', 'She chooses who. Before any gate opens, though, you need to know what the Sumerians believed was waiting underneath the ground they stood on.'],
    ['what waited', 'She was ready for the gods to refuse her. She was not ready for what waited at the first gate.'],
    ['what happens next', 'A sister who has just found him. What happens next divides a year into two halves, and not everyone who has studied these tablets agrees on where the story actually ends.'],
    ['not all of the pieces', 'She could only decide, once, who paid it. But even that decision comes down to us in pieces, and not all of the pieces found their way here the same way.'],
  ])('recognises our own real handover: %s', (_l, text) => {
    expect(bridges(text)).toBe(true);
  });

  it.each([
    ['a summary that stops', 'The tablets were copied by different scribes in different centuries. That is what they will always give you.'],
    ['a beat that just ends', 'He was named Ganesha. He is worshipped now as the one who removes obstacles.'],
  ])('still catches a genuinely flat ending: %s', (_l, text) => {
    expect(bridges(text)).toBe(false);
  });

  it('says nothing about the closing beat, which has nothing to hand to', () => {
    expect(checkBridge('He is worshipped now as the one who removes obstacles.', { isFinal: true })).toEqual([]);
  });
});

describe('DENIAL_CONTRAST - the redefinition is what makes it a fault', () => {
  const denies = (t: string) =>
    checkForward(t).some((p) => p.code === 'forward:denialContrast');

  it.each([
    ['a comma redefinition', 'It was not a theory, it was a measurement.'],
    ['a but redefinition', 'This was not a burglary but a demolition.'],
    ['a just redefinition', 'They were not professionals, just men with a drill.'],
  ])('catches %s', (_l, text) => {
    expect(denies(text)).toBe(true);
  });

  it.each([
    ['a negative fact with a parallel', 'She was not ready for what waited at the first gate.'],
    ['an absence that is the finding', 'It was not written down anywhere in the record.'],
    ['a plain negative about a person', 'He was not going to back down from that.'],
  ])('leaves alone %s', (_l, text) => {
    expect(denies(text)).toBe(false);
  });
});
