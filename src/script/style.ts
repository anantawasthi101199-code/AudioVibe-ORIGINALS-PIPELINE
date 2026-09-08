/**
 * Scoring prose against a show's style card, and against the network's own
 * list of things no show may say.
 *
 * Entirely deterministic. No model is asked whether a draft sounds right,
 * because "does this sound like the show" is not a question a model answers
 * consistently, and a gate that gives different answers on the same input is
 * not a gate. Everything here is countable.
 *
 * THE MOST IMPORTANT MEASURE IS VARIANCE, NOT AVERAGE. A draft can hit a target
 * mean sentence length perfectly by making every sentence that length, and
 * uniform sentence length is the single clearest tell of generated prose. So a
 * low standard deviation FAILS, and that check catches more bad drafts than the
 * banned-phrase list does.
 */
import { StyleCard } from '../canon/schema';

/**
 * Phrases no AudioVibe show may use, whatever its style card says.
 *
 * Seeded with the well-known model tells and grown from every QA rejection.
 * This list is one of the more valuable things the pipeline accumulates: each
 * entry is a specific way generated prose announces itself, learned once.
 */
export const NETWORK_BANNED_PHRASES = [
  // Register tells
  'delve into',
  'delves into',
  'tapestry',
  'landscape of',
  'realm of',
  'testament to',
  'navigating the',
  'a myriad of',
  'plethora of',
  // Structural tells
  "here's the thing",
  'let me be clear',
  "let's dive in",
  'lets dive in',
  'buckle up',
  'in this episode',
  'in this video',
  'stay tuned',
  'without further ado',
  'that said,',
  // The construction that is almost always empty
  "it's not just",
  'it is not just',
  'more than just',
  // Closing tells
  'the bottom line',
  'at the end of the day',
  'food for thought',
  'only time will tell',
];

const HEDGES = [
  'might',
  'may',
  'could',
  'perhaps',
  'possibly',
  'arguably',
  'somewhat',
  'relatively',
  'fairly',
  'seemingly',
  'apparently',
  'to some extent',
  'in a sense',
  'sort of',
  'kind of',
];

/** Sentences, split on terminal punctuation, ignoring common abbreviations. */
export const splitSentences = (text: string): string[] => {
  const protectedText = text
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|approx|no)\./gi, '$1<DOT>')
    .replace(/\b([A-Z])\./g, '$1<DOT>');

  return protectedText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/<DOT>/g, '.').trim())
    .filter((s) => s.length > 0);
};

export const countWords = (text: string): number =>
  text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;

export const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

export const stdDev = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

export interface StyleMeasurement {
  words: number;
  sentences: number;
  sentenceWordsMean: number;
  sentenceWordsStdDev: number;
  questionsPer100Words: number;
  secondPersonPer100Words: number;
  hedgesPer100Words: number;
  /** Distinct words over total words. Low values mean repetitive prose. */
  typeTokenRatio: number;
  bannedFound: string[];
}

export const measure = (text: string, forbidden: string[] = []): StyleMeasurement => {
  const sentences = splitSentences(text);
  const lengths = sentences.map(countWords);
  const words = countWords(text);
  const per100 = (n: number) => (words ? (n / words) * 100 : 0);

  const lower = text.toLowerCase();
  const questions = sentences.filter((s) => s.trim().endsWith('?')).length;

  const secondPerson = (lower.match(/\b(you|your|yours|you're|youre)\b/g) ?? []).length;
  const hedges = HEDGES.reduce(
    (n, h) => n + (lower.match(new RegExp(`\\b${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')) ?? []).length,
    0
  );

  const tokens = lower.match(/[a-z']+/g) ?? [];
  const typeTokenRatio = tokens.length ? new Set(tokens).size / tokens.length : 0;

  const bannedFound = [...NETWORK_BANNED_PHRASES, ...forbidden].filter((p) =>
    lower.includes(p.toLowerCase())
  );

  return {
    words,
    sentences: sentences.length,
    sentenceWordsMean: mean(lengths),
    sentenceWordsStdDev: stdDev(lengths),
    questionsPer100Words: per100(questions),
    secondPersonPer100Words: per100(secondPerson),
    hedgesPer100Words: per100(hedges),
    typeTokenRatio,
    bannedFound,
  };
};

export interface StyleViolation {
  rule: string;
  detail: string;
  /** Blocking violations fail the draft; advisory ones are reported only. */
  blocking: boolean;
}

/**
 * How far a mean may drift before it counts as off-voice.
 *
 * Generous, deliberately. The style card is a target rather than a specification,
 * and a gate that rejects a good draft for being one word long on average
 * teaches people to widen the card until it means nothing.
 */
export const MEAN_TOLERANCE = 0.4;

export const checkStyle = (text: string, card: StyleCard): {
  measurement: StyleMeasurement;
  violations: StyleViolation[];
} => {
  const m = measure(text, card.forbiddenPhrases);
  const violations: StyleViolation[] = [];

  // BLOCKING: uniform sentence length. The clearest tell there is, and the
  // reason a mean alone is not a style card.
  if (m.sentences >= 5 && m.sentenceWordsStdDev < card.sentenceWordsStdDevMin) {
    violations.push({
      rule: 'sentenceWordsStdDevMin',
      detail:
        `sentence length varies by ${m.sentenceWordsStdDev.toFixed(1)} words, under the ` +
        `${card.sentenceWordsStdDevMin} minimum. Uniform sentence length is the clearest ` +
        `sign of generated prose.`,
      blocking: true,
    });
  }

  // BLOCKING: a phrase nobody on the network may use.
  if (m.bannedFound.length) {
    violations.push({
      rule: 'bannedPhrases',
      detail: `uses ${m.bannedFound.map((p) => `"${p}"`).join(', ')}`,
      blocking: true,
    });
  }

  // BLOCKING: hedging is a ceiling, because the evidence layer already decides
  // how confident a claim may be. Prose adding a second, vaguer layer of doubt
  // is how a grounded show turns mushy.
  if (m.hedgesPer100Words > card.hedgesPer100WordsMax) {
    violations.push({
      rule: 'hedgesPer100WordsMax',
      detail: `hedges ${m.hedgesPer100Words.toFixed(1)} times per 100 words, over the ${card.hedgesPer100WordsMax} ceiling`,
      blocking: true,
    });
  }

  const drift = (actual: number, target: number) =>
    target === 0 ? actual > 0.5 : Math.abs(actual - target) / target > MEAN_TOLERANCE;

  if (drift(m.sentenceWordsMean, card.sentenceWordsMean)) {
    violations.push({
      rule: 'sentenceWordsMean',
      detail: `averages ${m.sentenceWordsMean.toFixed(1)} words per sentence, target ${card.sentenceWordsMean}`,
      blocking: false,
    });
  }

  if (drift(m.questionsPer100Words, card.questionsPer100Words)) {
    violations.push({
      rule: 'questionsPer100Words',
      detail: `asks ${m.questionsPer100Words.toFixed(1)} questions per 100 words, target ${card.questionsPer100Words}`,
      blocking: false,
    });
  }

  if (drift(m.secondPersonPer100Words, card.secondPersonPer100Words)) {
    violations.push({
      rule: 'secondPersonPer100Words',
      detail: `addresses the listener ${m.secondPersonPer100Words.toFixed(1)} times per 100 words, target ${card.secondPersonPer100Words}`,
      blocking: false,
    });
  }

  return { measurement: m, violations };
};

/**
 * How similar two scripts are, by shared distinctive vocabulary.
 *
 * Used two ways. Within the network, to stop five shows converging on one
 * register - which they will, because they share a model. And against the
 * platform's own catalogue, to stop the studio covering what a real creator has
 * already covered well, which is how you lose that creator.
 */
export const vocabularyOverlap = (a: string, b: string, topN = 200): number => {
  const distinctive = (text: string) => {
    const counts = new Map<string, number>();
    for (const w of text.toLowerCase().match(/[a-z']{4,}/g) ?? []) {
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    return new Set(
      [...counts.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, topN)
        .map(([w]) => w)
    );
  };

  const setA = distinctive(a);
  const setB = distinctive(b);
  if (!setA.size || !setB.size) return 0;

  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared++;
  return shared / Math.min(setA.size, setB.size);
};
