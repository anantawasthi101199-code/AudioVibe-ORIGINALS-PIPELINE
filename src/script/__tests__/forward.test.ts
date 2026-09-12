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
import { checkForward } from '../forward';

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
