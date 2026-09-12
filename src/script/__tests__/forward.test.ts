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
import { checkForward, checkRepetition } from '../forward';

const codes = (text: string, isOrientation = false) =>
  checkForward(text, { isOrientation }).map((p) => p.code);

describe('checkForward - the negation tic', () => {
  it('catches a fragment that opens by denying something nobody said', () => {
    const real =
      "Reader's first conviction for burglary came in 1950, when he was eleven years old. " +
      'Not eleven months into a criminal career. Eleven years old, full stop.';
    expect(codes(real)).toContain('forward:negationOpener');
  });

  it('catches the other three from the same episode', () => {
    for (const real of [
      'Not a legend, not a heist film pitch.',
      'Not from the newspaper version, not from whatever you already half-remember.',
      'Not a gang bursting through a wall with a sledgehammer.',
    ]) {
      expect(codes(real)).toContain('forward:negationOpener');
    }
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

  it('does not fire on a tag at the head of a sentence', () => {
    // Tags are stripped first, or "[quietly] Not..." would be invisible and
    // "[quietly] Nobody came" might look like one.
    expect(codes('[quietly] Not a single door was locked.')).toContain(
      'forward:negationOpener'
    );
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

  it('catches a beat saying the same thing twice inside itself', () => {
    // The sum of money, given twice in the payoff beat.
    const payoff =
      'Property now put at just short of fourteen million pounds. ' +
      'Diamonds, gold, jewellery, cash, all of it sitting behind those boxes for exactly this reason, ' +
      'and all of it gone by the time the sun came up on the Sunday. It did not stay theirs. ' +
      'Surveillance work and what came out afterward at trial put names to faces, and eventually to sentences. ' +
      'Which means two thirds of nearly fourteen million pounds simply never came back.';
    expect(codesOf(payoff)).toContain('forward:restatesItself');
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
    const soFar = "They don't know. He doesn't know either, and they don't ask.";
    expect(codesOf("She doesn't know what he doesn't know.", soFar)).toEqual([]);
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
