/**
 * Measured against the real episode that prompted the request, so the
 * thresholds mean something rather than being round numbers.
 */
import {
  LONG_WORD_SHARE,
  MIN_WORDS_TO_JUDGE,
  NOMINAL_PER_100,
  checkPlainWords,
  measurePlainness,
  syllables,
} from '../plain';

const pad = (text: string) => `${text} ${'word '.repeat(MIN_WORDS_TO_JUDGE)}`;

describe('measurePlainness', () => {
  it('does not count names, which a show cannot avoid saying', () => {
    // A show about Piper Alpha has to say "Piper Alpha", and an episode about
    // Occidental has to say "Occidental". Counting those would measure the
    // subject rather than the vocabulary.
    expect(measurePlainness('Occidental Aberdeen Piper Alpha').longShare).toBe(0);
  });

  it('does not count a spoken-out number or a hyphenated compound', () => {
    // "Sixty-seven" and "hand-tightened" are long by syllable and simple by
    // every measure that matters to a listener.
    expect(measurePlainness('sixty-seven hand-tightened five-oh-four').longShare).toBe(0);
  });

  it('counts a verb turned into a noun', () => {
    const m = measurePlainness('the decision and the maintenance and the recommendation');
    expect(m.nominalPer100).toBeGreaterThan(0);
    expect(m.worstNominal).toContain('decision');
  });

  it('leaves ordinary nouns that merely end that way', () => {
    // "Question", "person" and "evidence" are not verbs wearing noun clothes,
    // and a check that flagged them would be reporting on English.
    expect(measurePlainness('the question the person the evidence the witness').nominalPer100).toBe(
      0
    );
  });
});

describe('syllables', () => {
  it('is roughly right, which is all the ratio needs', () => {
    expect(syllables('the')).toBe(1);
    expect(syllables('decide')).toBe(2);
    expect(syllables('recertification')).toBeGreaterThanOrEqual(5);
  });
});

describe('checkPlainWords', () => {
  it('says nothing about a passage too short to have a ratio', () => {
    expect(checkPlainWords('An investigation of the situation.')).toEqual([]);
  });

  it('reports heavy nominalisation without blocking it', () => {
    // Advisory on purpose. There are already ten blocking checks on the
    // writing, and every rejection pushes prose toward the safe and the flat.
    // Three nominalisations in about 150 words: over the 1.1 target, well
    // under the 3 that means the beat has stopped being speech.
    const heavy = pad('The decision followed an investigation into the maintenance of the pump.');
    const found = checkPlainWords(heavy).find((p) => p.rule === 'plain:nominalisations');
    expect(found).toBeDefined();
    expect(found!.blocking).toBe(false);
  });

  it('BLOCKS prose that has stopped being speech altogether', () => {
    const report =
      'The determination of the causation of the situation required the ' +
      'consideration of the documentation, the verification of the information, ' +
      'and the authorisation of the implementation. ';
    expect(checkPlainWords(report.repeat(6)).some((p) => p.blocking)).toBe(true);
  });

  it('is quiet on plain speech', () => {
    const plain = pad(
      'He pulled the valve out and capped the pipe by hand. He wrote on his permit ' +
        'that the pump must not be started. Then he left the permit in the control ' +
        'room and went back to work.'
    );
    expect(checkPlainWords(plain)).toEqual([]);
  });

  it('has thresholds tighter than the episode that prompted them', () => {
    // The measured episode ran 8.2% long words and 1.6 nominalisations. Targets
    // below both, or nothing would change.
    expect(LONG_WORD_SHARE).toBeLessThan(0.082);
    expect(NOMINAL_PER_100).toBeLessThan(1.6);
  });
});
