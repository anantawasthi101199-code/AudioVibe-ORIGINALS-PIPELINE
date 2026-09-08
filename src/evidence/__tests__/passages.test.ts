/**
 * Passage selection exists to fix one specific failure: the relevant paragraph
 * of a filing or an incident report is very often on page nine, and taking the
 * first N characters silently misses it.
 */
import { scorePassages, selectPassages, splitPassages } from '../passages';

/**
 * A section padded past the 900-character packing target, so each one becomes
 * its own passage. That is what a real document's sections look like, and a
 * fixture of one-line paragraphs would all pack into a single passage and test
 * nothing.
 */
const section = (text: string) => `${text}${' filler words here.'.repeat(55)}`;

const bodyOf = (count: number, label: string) =>
  Array.from({ length: count }, (_, i) => section(`${label} ${i}.`)).join('\n\n');

describe('splitPassages', () => {
  it('splits on paragraph boundaries, not fixed sizes', () => {
    // Cutting at a fixed token count separates a sentence from the number it
    // refers to, and here it would also break quote spans.
    expect(splitPassages('One.\n\nTwo.\n\nThree.', 5)).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('packs short paragraphs together up to the target', () => {
    expect(splitPassages('a\n\nb\n\nc', 100)).toHaveLength(1);
  });

  it('leaves an over-long paragraph whole rather than cutting it', () => {
    const long = 'x'.repeat(500);
    expect(splitPassages(`short\n\n${long}`, 100)).toContain(long);
  });

  it('handles a document with no paragraph breaks', () => {
    expect(splitPassages('just one block of text', 100)).toEqual(['just one block of text']);
  });
});

describe('scorePassages', () => {
  it('ranks the passage that matches the query above one that does not', () => {
    const scored = scorePassages(
      ['The weather was pleasant that spring.', 'The regulator fined the operator four million pounds.'],
      ['regulator fine operator']
    );
    expect(scored[1]!.score).toBeGreaterThan(scored[0]!.score);
  });

  it('saturates term frequency, so keyword stuffing does not win', () => {
    // Without saturation, a passage repeating one query word eight times
    // outranks one that actually answers the question.
    const stuffed = 'regulator regulator regulator regulator regulator regulator regulator regulator.';
    const real = 'The regulator issued a fine to the operator after the alarm failure.';
    const scored = scorePassages([stuffed, real], ['regulator operator alarm fine']);
    expect(scored[1]!.score).toBeGreaterThan(scored[0]!.score);
  });

  it('ignores stop words, which carry no signal', () => {
    expect(scorePassages(['the and of that this', 'regulator'], ['the and of'])[0]!.score).toBe(0);
  });

  it('scores zero when nothing matches', () => {
    expect(scorePassages(['sourdough proving basket'], ['regulator']).every((p) => p.score === 0)).toBe(
      true
    );
  });
});

describe('selectPassages', () => {
  const BURIED = 'The regulator fined the operator four point two million pounds in March 2024.';

  it('returns a short document untouched', () => {
    expect(selectPassages('short doc', ['anything'], 1000)).toBe('short doc');
  });

  it('FINDS THE RELEVANT PARAGRAPH ON PAGE NINE', () => {
    // The whole reason this module exists. Taking the first 3000 characters of
    // this document would return preamble and nothing else.
    const doc = `${bodyOf(12, 'Preamble section')}\n\n${BURIED}`;

    const selected = selectPassages(doc, ['regulator fine operator millions'], 3000);
    expect(selected).toContain(BURIED);
    expect(selected.length).toBeLessThan(doc.length / 2);
    expect(doc.slice(0, 3000)).not.toContain(BURIED);
  });

  it('always keeps the head, which carries the thesis and the date', () => {
    // A passage from the middle arrives with no idea what document it is from,
    // and the extractor needs that to judge what a paragraph means.
    const head = 'ANNUAL REPORT 2024. This document covers the year to December.';
    const doc = `${head}\n\n${bodyOf(12, 'Body')}\n\n${BURIED}`;
    expect(selectPassages(doc, ['regulator'], 3000)).toContain('ANNUAL REPORT 2024');
  });

  it('marks where text was dropped, so nothing is quoted across a join', () => {
    // Two unrelated paragraphs read as continuous would let the extractor
    // produce a quote that exists in our text and in no document.
    const doc = `Head paragraph here.\n\n${bodyOf(10, 'Middle')}\n\n${BURIED}`;
    expect(selectPassages(doc, ['regulator fined operator'], 2500)).toContain('[...]');
  });

  it('does not spend budget on passages that matched nothing', () => {
    const doc = `Head.\n\n${bodyOf(10, 'Irrelevant')}`;
    // Nothing but the head scored, so nothing but the head is returned - even
    // though there is budget left over.
    expect(selectPassages(doc, ['regulator'], 3000).trim()).toBe('Head.');
  });

  it('falls back to truncation when a document has one huge paragraph', () => {
    expect(selectPassages('x'.repeat(5000), ['anything'], 1000)).toHaveLength(1000);
  });
});
