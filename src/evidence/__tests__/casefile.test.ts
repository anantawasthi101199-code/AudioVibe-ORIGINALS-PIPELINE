/**
 * The case file is the only thing standing between one article and a script
 * about real people, and what is pinned here is the set of failures that would
 * let something false through while every stage reported success.
 *
 * The free checks matter most. They run before the script is paid for, they
 * cost nothing, and each one is a way this lane goes wrong rather than a
 * tidiness rule: a file with no victim is a file about whoever did it, and a
 * victim with no background is a case number.
 *
 * The rendering matters nearly as much, because it is the only thing the writer
 * ever sees. A contested claim that does not reach the writer marked as
 * contested becomes a fact in the script.
 */
import {
  CaseFile,
  MAX_CARRY,
  caseFileSchema,
  caseReviewSchema,
  checkCaseFile,
  renderCaseFile,
} from '../casefile';

const person = (over: Partial<CaseFile['cast'][number]> = {}) => ({
  name: 'Julia Wallace',
  role: 'victim' as const,
  who: 'killed in her own front room',
  background: 'A pianist who held musical evenings at home.',
  carry: true,
  ...over,
});

const file = (over: Partial<CaseFile> = {}): CaseFile =>
  caseFileSchema.parse({
    caseName: 'The murder of Julia Wallace',
    oneLine: 'A man was sent to an address that did not exist, and came home to find his wife dead.',
    hook: 'The address had a North, a South and a West, and no East at all.',
    context: ['Liverpool, 1931.'],
    cast: [person(), person({ name: 'William Wallace', role: 'convicted', who: 'her husband' })],
    places: [{ name: '29 Wolverton Street', picture: 'A row of houses put up in 1910.' }],
    chronology: [
      { when: '19 January 1931', what: 'A message was left at the chess club.', who: ['William Wallace'] },
      { when: '20 January 1931', what: 'He went looking for the address.', who: ['William Wallace'] },
      { when: 'later that night', what: 'He found her in the front room.', who: ['William Wallace'] },
    ],
    investigation: ['He gave four voluntary statements.'],
    outcome: { status: 'overturned', what: 'Convicted, then quashed on appeal.', when: 'May 1931' },
    contested: [],
    unknown: [],
    sourceIds: ['s1'],
    ...over,
  });

describe('checkCaseFile', () => {
  it('passes a file that has a victim, a background and a chronology', () => {
    expect(checkCaseFile(file())).toEqual([]);
  });

  /**
   * THE ONE THIS LANE EXISTS TO PREVENT. A case file with no victim is a file
   * about whoever did it, and nothing downstream would notice.
   */
  it('catches a file with no victim in it', () => {
    const problems = checkCaseFile(
      file({ cast: [person({ name: 'William Wallace', role: 'convicted' })] })
    );
    expect(problems.some((p) => p.includes('no victim'))).toBe(true);
  });

  it('catches a victim nobody described', () => {
    const problems = checkCaseFile(file({ cast: [person({ background: '   ' })] }));
    expect(problems.some((p) => p.includes('case number'))).toBe(true);
  });

  it('catches a chronology too short to be one', () => {
    const problems = checkCaseFile(
      file({ chronology: [{ when: '1931', what: 'She died.', where: '', who: [], certainty: 'established' }] })
    );
    expect(problems.some((p) => p.includes('not a chronology'))).toBe(true);
  });

  /** A name that acts and was never introduced is a name the listener cannot place. */
  it('catches somebody who acts in the chronology and is not in the cast', () => {
    const problems = checkCaseFile(
      file({
        chronology: [
          { when: '19 January', what: 'Took the call.', where: '', who: ['Beattie'], certainty: 'established' },
          { when: '20 January', what: 'Went looking.', where: '', who: ['William Wallace'], certainty: 'established' },
          { when: 'that night', what: 'Found her.', where: '', who: ['William Wallace'], certainty: 'established' },
        ],
      })
    );
    expect(problems.some((p) => p.includes('"Beattie"'))).toBe(true);
  });

  it('caps the names a listener is asked to carry', () => {
    const many = Array.from({ length: MAX_CARRY + 1 }, (_, i) =>
      person({ name: `Person ${i}`, role: i === 0 ? 'victim' : 'witness' })
    );
    expect(checkCaseFile(file({ cast: many })).some((p) => p.includes('to carry'))).toBe(true);
  });

  /** An empty cast is a different failure and must not be reported as a missing victim. */
  it('says nothing about a victim when there is no cast at all', () => {
    expect(checkCaseFile(file({ cast: [] })).some((p) => p.includes('no victim'))).toBe(false);
  });
});

describe('renderCaseFile', () => {
  it('puts the hook first, because it is the first line of the episode', () => {
    const out = renderCaseFile(file());
    expect(out.indexOf('no East at all')).toBeLessThan(out.indexOf('THE CHRONOLOGY'));
  });

  /**
   * A contested claim that does not reach the writer MARKED contested becomes a
   * fact in the script, about a real person. This is the reversal of the myth
   * lane, where the disagreements are deliberately withheld.
   */
  it('shows the writer what is contested, and who says it', () => {
    const out = renderCaseFile(
      file({
        contested: [
          { claim: 'Wallace made the call himself.', whoSays: 'the prosecution', why: 'entirely circumstantial' },
        ],
      })
    );

    expect(out).toContain('DISPUTED');
    expect(out).toContain('Wallace made the call himself.');
    expect(out).toContain('the prosecution');
    expect(out).toContain('NOT settled');
  });

  it('marks an alleged event in the chronology and leaves an established one alone', () => {
    const out = renderCaseFile(
      file({
        chronology: [
          { when: '19 January', what: 'A message was left.', where: '', who: [], certainty: 'established' },
          { when: '20 January', what: 'He confessed.', where: '', who: [], certainty: 'alleged' },
          { when: 'later', what: 'He retracted it.', where: '', who: [], certainty: 'disputed' },
        ],
      })
    );

    expect(out).toContain('[ALLEGED]');
    expect(out).toContain('[DISPUTED]');
    expect(out).not.toContain('A message was left. [ESTABLISHED]');
  });

  it('tells the writer what the record does not say', () => {
    const out = renderCaseFile(file({ unknown: ['Who made the call.'] }));
    expect(out).toContain('WHAT THE RECORD DOES NOT SAY');
    expect(out).toContain('Who made the call.');
  });

  /**
   * A place with no recorded detail is honest and an invented one is not, so the
   * empty ones are left out rather than handed over as prompts to fill in.
   */
  it('leaves out a place the document recorded nothing about', () => {
    const out = renderCaseFile(
      file({ places: [{ name: 'Menlove Gardens', picture: '' }] })
    );
    expect(out).not.toContain('Menlove Gardens');
  });

  it('separates the names to carry from the ones said once', () => {
    const out = renderCaseFile(
      file({
        cast: [person(), person({ name: 'A constable', role: 'investigator', carry: false, background: '' })],
      })
    );
    expect(out).toContain('THE PEOPLE TO CARRY');
    expect(out).toContain('NAMED ONCE, OR NOT AT ALL');
  });
});

describe('the schemas', () => {
  it('defaults an event to established rather than leaving it unmarked', () => {
    const parsed = caseFileSchema.parse({
      caseName: 'x',
      oneLine: 'x',
      hook: 'x',
      chronology: [{ when: '1931', what: 'something' }],
      outcome: { status: 'unsolved', what: 'nobody was charged' },
    });
    expect(parsed.chronology[0]!.certainty).toBe('established');
  });

  it('refuses an outcome status it does not recognise', () => {
    expect(() =>
      caseFileSchema.parse({
        caseName: 'x',
        oneLine: 'x',
        hook: 'x',
        outcome: { status: 'probably fine', what: 'x' },
      })
    ).toThrow();
  });

  /**
   * `checked` is the difference between "nothing was found" and "nobody
   * looked", and the gate reads it to fail closed.
   */
  it('treats a review as checked unless it says otherwise', () => {
    expect(caseReviewSchema.parse({}).checked).toBe(true);
    expect(caseReviewSchema.parse({ checked: false, failure: 'timed out' }).checked).toBe(false);
  });
});
