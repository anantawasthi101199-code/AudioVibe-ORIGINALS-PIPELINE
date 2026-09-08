import { parsePersona } from '../../canon/load';
import {
  checkStyle,
  countWords,
  measure,
  NETWORK_BANNED_PHRASES,
  splitSentences,
  stdDev,
  vocabularyOverlap,
} from '../style';

const card = parsePersona(`
id: t
handle: t
name: T
category: Educational
thesis: x
audience: y
register: z
hosts: [{id: host, name: Host, role: Narrates the show., voice: {provider: elevenlabs, voiceId: v}}]
styleCard:
  sentenceWordsMean: 15
  sentenceWordsStdDevMin: 5
  questionsPer100Words: 1
  secondPersonPer100Words: 1
  hedgesPer100WordsMax: 2
  metaphorDomains: [x]
  forbiddenPhrases: [cautionary tale]
formats: [f]
episodeSeconds: [300, 400]
allowedRiskTiers: [general]
`).styleCard;

describe('splitSentences', () => {
  it('splits on terminal punctuation', () => {
    expect(splitSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?']);
  });

  it('does not split on common abbreviations', () => {
    // Otherwise "Dr. Smith" counts as two sentences and wrecks the length stats.
    expect(splitSentences('Dr. Smith arrived. He left.')).toEqual(['Dr. Smith arrived.', 'He left.']);
  });

  it('does not split on initials', () => {
    expect(splitSentences('J. R. Hartley wrote it. Then he stopped.')).toHaveLength(2);
  });
});

describe('countWords', () => {
  it('ignores bare punctuation', () => {
    expect(countWords('one two - three')).toBe(3);
  });
});

describe('stdDev', () => {
  it('is zero for identical values', () => {
    expect(stdDev([5, 5, 5])).toBe(0);
  });

  it('needs at least two values', () => {
    expect(stdDev([5])).toBe(0);
  });
});

describe('measure', () => {
  it('counts questions, second person and hedges per 100 words', () => {
    const m = measure('You might want this. Do you? Your call.');
    expect(m.questionsPer100Words).toBeGreaterThan(0);
    expect(m.secondPersonPer100Words).toBeGreaterThan(0);
    expect(m.hedgesPer100Words).toBeGreaterThan(0);
  });

  it('finds network banned phrases regardless of case', () => {
    expect(measure("Let's Dive In to this").bannedFound).toContain("let's dive in");
  });

  it('finds show-specific forbidden phrases', () => {
    expect(measure('a cautionary tale', ['cautionary tale']).bannedFound).toContain('cautionary tale');
  });

  it('reports a type-token ratio, so repetitive prose is visible', () => {
    expect(measure('the the the the').typeTokenRatio).toBeLessThan(0.5);
    expect(measure('alpha beta gamma delta').typeTokenRatio).toBe(1);
  });
});

describe('checkStyle', () => {
  // Deliberately varied sentence lengths, no hedges, no banned phrases.
  const good = [
    'The alarm had been off for eleven weeks.',
    'Nobody noticed, because the log that would have shown it was filled in on Fridays for the week ahead, which meant the column was always complete and never true.',
    'That is the part worth slowing down on.',
    'The regulator found it in an afternoon.',
    'What took eleven weeks to happen took one visit and a single question about who signed the Thursday entry to unravel completely.',
    'It cost four million pounds.',
  ].join(' ');

  it('passes a varied, unhedged draft', () => {
    const { violations } = checkStyle(good, card);
    expect(violations.filter((v) => v.blocking)).toEqual([]);
  });

  it('BLOCKS uniform sentence length', () => {
    // The clearest tell of generated prose, and the reason a mean alone is not
    // a style card. Every sentence here is exactly five words.
    const uniform = Array.from({ length: 8 }, (_, i) => `Alpha beta gamma delta ${i}.`).join(' ');
    const { violations } = checkStyle(uniform, card);
    expect(violations.some((v) => v.rule === 'sentenceWordsStdDevMin' && v.blocking)).toBe(true);
  });

  it('does not judge variance on a very short draft', () => {
    // Three sentences cannot demonstrate a distribution, and failing them would
    // make short beats unwritable.
    const { violations } = checkStyle('One two three. Four five six. Seven eight nine.', card);
    expect(violations.some((v) => v.rule === 'sentenceWordsStdDevMin')).toBe(false);
  });

  it('BLOCKS a banned phrase', () => {
    const { violations } = checkStyle(`${good} Here's the thing.`, card);
    expect(violations.some((v) => v.rule === 'bannedPhrases' && v.blocking)).toBe(true);
  });

  it('BLOCKS excessive hedging', () => {
    // The evidence layer already decides how confident a claim may be. Prose
    // adding a second vaguer layer of doubt is how a grounded show turns mushy.
    const hedged = 'It might perhaps possibly be somewhat arguably true. It could maybe be relatively fairly so.';
    const { violations } = checkStyle(hedged, card);
    expect(violations.some((v) => v.rule === 'hedgesPer100WordsMax' && v.blocking)).toBe(true);
  });

  it('reports mean drift as ADVISORY, not blocking', () => {
    // A gate that rejects a good draft for being one word long on average
    // teaches people to widen the card until it means nothing.
    const short = 'One two. Three four five six seven eight nine ten eleven twelve. One. Two three four. Five. Six seven eight nine ten eleven.';
    const { violations } = checkStyle(short, card);
    const meanViolation = violations.find((v) => v.rule === 'sentenceWordsMean');
    if (meanViolation) expect(meanViolation.blocking).toBe(false);
  });

  it('returns the measurement alongside the violations', () => {
    expect(checkStyle(good, card).measurement.words).toBeGreaterThan(0);
  });
});

describe('NETWORK_BANNED_PHRASES', () => {
  it('is all lowercase, since matching lowercases the text', () => {
    for (const p of NETWORK_BANNED_PHRASES) expect(p).toBe(p.toLowerCase());
  });
});

describe('vocabularyOverlap', () => {
  it('is high for the same text', () => {
    const t = 'regulator alarm maintenance logs inspection findings report';
    expect(vocabularyOverlap(t, t)).toBe(1);
  });

  it('is low for unrelated texts', () => {
    expect(
      vocabularyOverlap(
        'regulator alarm maintenance logs inspection',
        'sourdough proving basket kitchen flour'
      )
    ).toBe(0);
  });

  it('is zero when either side is empty', () => {
    expect(vocabularyOverlap('', 'anything')).toBe(0);
  });
});
