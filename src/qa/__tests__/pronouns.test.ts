/**
 * Every string here is from the real episode and the real corpus that produced
 * the error, because the error is subtle and an invented example would be
 * easier to catch than the genuine one.
 */
import { checkPronouns, genderInSources } from '../pronouns';

// Verbatim from the sources fetched for that run.
const CORPUS = [
  'In the Crown Court at Woolwich Sentencing remarks of HHJ Kinch 9th March 2016.',
  'HHJ Christopher Kinch QC 9 March 2016.',
  'Judge Christopher Kinch QC said he did not know if it could be proved as had been claimed in court that it was the biggest burglary in English legal history.',
  'The court rises for His Honour Judge Kinch.',
].join(' ');

// Verbatim from the script the gate passed.
const SCRIPT = [
  'All of that comes to us in one voice, because everything in this story is drawn from the sentencing remarks of a judge called HHJ Kinch.',
  'What her remarks work out, piece by piece, is the question sitting underneath everything.',
  'Old-school professionals, Kinch called them, and she meant it plainly.',
  'Then the sentences, one at a time, the way Kinch read them out in that courtroom.',
].join(' ');

describe('checkPronouns', () => {
  it('catches the judge the episode called "her"', () => {
    const problems = checkPronouns(SCRIPT, CORPUS, ['HHJ Kinch']);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.name).toBe('Kinch');
    expect(problems[0]!.used).toBe('she');
    expect(problems[0]!.supported).toBe('he');
  });

  it('says nothing when the script agrees with the sources', () => {
    const right = 'Kinch set out what he had decided, and he read the sentences out one by one.';
    expect(checkPronouns(right, CORPUS, ['HHJ Kinch'])).toEqual([]);
  });

  it('says nothing when the script uses the name rather than a pronoun', () => {
    // The behaviour the writer is now told to prefer, and it must never be
    // punished for it.
    const safe = 'Kinch set out the reasons. Kinch then read the sentences out one by one.';
    expect(checkPronouns(safe, CORPUS, ['HHJ Kinch'])).toEqual([]);
  });

  it('says nothing about a person the sources never gender', () => {
    // Guessing here would make this check the exact thing it exists to prevent.
    const quiet = 'The vault was opened in April. Basil was never identified.';
    expect(genderInSources(quiet, 'Basil')).toBeNull();
    expect(checkPronouns('Basil did what he came to do.', quiet, ['Basil'])).toEqual([]);
  });

  it('is not fooled by one stray pronoun belonging to somebody else', () => {
    // Real documents are full of other people. A single "her" in a sentence
    // about a man must not flip the answer.
    const mixed =
      'Judge Kinch said he had considered the reports. He told the court that her account, ' +
      'given by the witness, was not disputed. He passed sentence.';
    expect(genderInSources(mixed, 'Kinch')).toBe('he');
  });

  it('ignores names it was not asked about', () => {
    // Scoped to the planned cast, so a capitalised word like "Easter" or
    // "Hatton" never becomes a person with a gender.
    expect(checkPronouns(SCRIPT, CORPUS, ['Brian Reader'])).toEqual([]);
  });
});
