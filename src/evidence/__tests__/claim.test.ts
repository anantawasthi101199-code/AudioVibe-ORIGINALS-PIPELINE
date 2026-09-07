/**
 * The deterministic half of verification.
 *
 * The case that matters most is a quote that is a plausible PARAPHRASE of the
 * document rather than a thing the document says. A semantic verifier handed
 * such a quote will often approve it, because the quote does support the claim
 * - it just is not in the source. Checking existence before meaning closes that
 * hole for free, and these tests are mostly about that.
 */
import { Source } from '../source';
import {
  beatsBelowClaimFloor,
  Claim,
  checkClaimShape,
  checkLedger,
  locateQuote,
  MIN_QUOTE_CHARS,
  normaliseForMatch,
} from '../claim';

const SOURCE_TEXT = [
  'The regulator fined the operator 4.2 million pounds in March 2024.',
  '',
  'Investigators found that the alarm had been disabled for eleven weeks,',
  'and that maintenance logs were completed in advance.',
  '',
  'The report notes that shorter shifts were associated with fewer incidents,',
  'though it stops short of claiming a causal link.',
].join('\n');

const source = (over: Partial<Source> = {}): Source =>
  ({
    id: 'src1',
    url: 'https://www.gov.uk/report',
    title: 'A Report',
    retrievedAt: '2026-09-07T12:00:00.000Z',
    contentHash: 'a'.repeat(64),
    tier: 'T1',
    text: SOURCE_TEXT,
    httpStatus: 200,
    ...over,
  }) as Source;

const claim = (over: Partial<Claim> = {}): Claim => ({
  id: 'c1',
  text: 'The operator was fined 4.2 million pounds.',
  type: 'statistic',
  beatId: 'stakes',
  sourceId: 'src1',
  quote: 'The regulator fined the operator 4.2 million pounds in March 2024.',
  contested: false,
  ...over,
});

describe('normaliseForMatch', () => {
  it('folds whitespace so a line break does not fail a real quote', () => {
    expect(normaliseForMatch('one\n  two\ttthree'.replace('tt', 't'))).toBe('one two three');
  });

  it('folds typographic quotes and dashes', () => {
    // A document with a curly apostrophe and a quote with a straight one are
    // the same words.
    expect(normaliseForMatch('it’s “fine” — really')).toBe('it\'s "fine" - really');
  });
});

describe('locateQuote', () => {
  it('finds a verbatim quote', () => {
    expect(locateQuote(SOURCE_TEXT, 'The regulator fined the operator 4.2 million pounds in March 2024.').found).toBe(true);
  });

  it('finds a quote that spans a line break in the source', () => {
    // Extraction inserts newlines at block boundaries; a model quoting the span
    // will not reproduce that layout, and rejecting over it would be wrong.
    expect(
      locateQuote(SOURCE_TEXT, 'the alarm had been disabled for eleven weeks, and that maintenance logs were completed in advance.').found
    ).toBe(true);
  });

  it('REJECTS a plausible paraphrase', () => {
    // The whole point. This is what the source almost says, and a semantic
    // verifier would likely approve it.
    const check = locateQuote(SOURCE_TEXT, 'The regulator issued a fine of 4.2 million pounds to the operator in March of 2024.');
    expect(check.found).toBe(false);
    expect(check).toMatchObject({ reason: 'not_present' });
  });

  it('rejects a quote too short to prove anything', () => {
    // A three-word span occurs in almost any document by chance.
    expect(locateQuote(SOURCE_TEXT, 'the report')).toMatchObject({ found: false, reason: 'too_short' });
    expect(MIN_QUOTE_CHARS).toBeGreaterThan(20);
  });

  it('rejects an empty quote', () => {
    expect(locateQuote(SOURCE_TEXT, '   ')).toMatchObject({ found: false, reason: 'empty' });
  });
});

describe('checkClaimShape', () => {
  it('accepts a well-formed statistic', () => {
    expect(checkClaimShape(claim(), source())).toEqual([]);
  });

  it('rejects a statistic that states no number', () => {
    expect(checkClaimShape(claim({ text: 'The operator was fined heavily.' }), source())[0]?.problem).toMatch(
      /states no number/
    );
  });

  it('rejects a statistic whose quote carries no number', () => {
    // A figure that has lost its source figure is one somebody remembered
    // rather than read.
    const problems = checkClaimShape(
      claim({ quote: 'Investigators found that the alarm had been disabled for many weeks.' }),
      source()
    );
    expect(problems.some((p) => /quote contains no number/.test(p.problem))).toBe(true);
  });

  it('REFUSES to upgrade a correlation to a cause', () => {
    // The rule that keeps the case-study and self-help lanes honest.
    const problems = checkClaimShape(
      claim({
        type: 'causal',
        text: 'Shorter shifts caused fewer incidents.',
        quote: 'The report notes that shorter shifts were associated with fewer incidents,',
      }),
      source()
    );
    expect(problems[0]?.problem).toMatch(/only reports an association/);
  });

  it('allows a causal claim when the source states a cause', () => {
    const problems = checkClaimShape(
      claim({
        type: 'causal',
        text: 'The disabled alarm led to the incident.',
        quote: 'Investigators found that the disabled alarm led to the incident that followed in the plant.',
      }),
      source({
        text: 'Investigators found that the disabled alarm led to the incident that followed in the plant.',
      })
    );
    expect(problems).toEqual([]);
  });

  it('refuses to attribute a position on a T4 source', () => {
    const problems = checkClaimShape(
      claim({ type: 'attribution', text: 'The chief engineer opposed the change.' }),
      source({ tier: 'T4' })
    );
    expect(problems[0]?.problem).toMatch(/T4 source/);
  });
});

describe('checkLedger', () => {
  it('passes a clean ledger and reports tiers per beat', () => {
    const report = checkLedger([claim()], [source()]);
    expect(report.ok).toBe(true);
    expect(report.tierByBeat.stakes).toBe('T1');
    expect(report.claimsByBeat.stakes).toBe(1);
  });

  it('takes the WEAKEST tier for a beat', () => {
    // One forum post cannot be laundered into fact by sitting beside a paper.
    const report = checkLedger(
      [claim(), claim({ id: 'c2', sourceId: 'src2' })],
      [source(), source({ id: 'src2', tier: 'T4', url: 'https://reddit.com/x' })]
    );
    expect(report.tierByBeat.stakes).toBe('T4');
  });

  it('flags a claim citing a source that is not in the corpus', () => {
    // Should be impossible given sources only exist by fetching, but if it ever
    // happens a claim invented its own reference and that must be loud.
    const report = checkLedger([claim({ sourceId: 'ghost' })], [source()]);
    expect(report.ok).toBe(false);
    expect(report.problems[0]?.kind).toBe('missing_source');
  });

  it('fails a paraphrased quote', () => {
    const report = checkLedger(
      [claim({ quote: 'The regulator issued a 4.2 million pound fine to the operator during March 2024.' })],
      [source()]
    );
    expect(report.ok).toBe(false);
    expect(report.problems[0]?.kind).toBe('quote_not_in_source');
  });

  it('reports every problem, not just the first', () => {
    const report = checkLedger(
      [claim({ id: 'a', sourceId: 'ghost' }), claim({ id: 'b', quote: 'nope' })],
      [source()]
    );
    expect(report.problems).toHaveLength(2);
  });
});

describe('beatsBelowClaimFloor', () => {
  it('names beats that did not meet the format floor', () => {
    expect(beatsBelowClaimFloor({ mechanism: 2 }, { mechanism: 4, cold_open: 0 })).toEqual([
      'mechanism',
    ]);
  });

  it('treats a beat with no claims at all as below a nonzero floor', () => {
    expect(beatsBelowClaimFloor({}, { mechanism: 4 })).toEqual(['mechanism']);
  });

  it('ignores beats with no floor', () => {
    expect(beatsBelowClaimFloor({}, { cold_open: 0 })).toEqual([]);
  });
});
