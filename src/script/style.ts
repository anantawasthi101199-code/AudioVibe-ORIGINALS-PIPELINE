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

/**
 * The 200 commonest English words.
 *
 * Used as a cheap stand-in for perplexity. Real perplexity needs a model's
 * logprobs, which means a call per draft; the share of tokens drawn from this
 * list moves in the same direction for free. Generated prose reaches for the
 * statistically likely word, so an unusually high common-word share is the
 * lexical half of the same tell that uniform sentence length is the rhythmic
 * half of.
 */
const COMMON_WORDS = new Set(
  ('the be to of and a in that have i it for not on with he as you do at this but his by from they we say her ' +
   'she or an will my one all would there their what so up out if about who get which go me when make can like ' +
   'time no just him know take people into year your good some could them see other than then now look only come ' +
   'its over think also back after use two how our work first well way even new want because any these give day ' +
   'most us is are was were been being has had did does done said says going got made much many more very such ' +
   'own same those own here where why while does off down before between under again both few own too through ' +
   'during without within around against among since until upon another every each either neither always never ' +
   'often sometimes really quite rather almost enough still yet already however therefore thus hence indeed')
    .split(' ')
);

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
  /**
   * Share of tokens drawn from the 200 commonest English words.
   *
   * The lexical half of the AI tell. Detection research treats predictable word
   * choice as co-equal with uniform rhythm, and this pipeline measured only the
   * rhythm until now.
   */
  commonWordRatio: number;
  /**
   * Distinct sentence openings over sentences.
   *
   * A very cheap and very reliable signal: generated prose starts sentence
   * after sentence with "The", "It" and "This", where a person varies where a
   * sentence enters.
   */
  openerDiversity: number;
  /** Share of trigrams that occur more than once. Phrase-level self-repetition. */
  repeatedTrigramRatio: number;
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

  const commonWordRatio = tokens.length
    ? tokens.filter((t) => COMMON_WORDS.has(t)).length / tokens.length
    : 0;

  // First two words of each sentence. Two rather than one, because "The
  // regulator" and "The alarm" are different entrances while "The" alone
  // collapses everything that begins with an article.
  const openers = sentences
    .map((s) => (s.toLowerCase().match(/[a-z']+/g) ?? []).slice(0, 2).join(' '))
    .filter(Boolean);
  const openerDiversity = openers.length ? new Set(openers).size / openers.length : 1;

  const trigrams: string[] = [];
  for (let i = 0; i + 2 < tokens.length; i++) {
    trigrams.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  const trigramCounts = new Map<string, number>();
  for (const g of trigrams) trigramCounts.set(g, (trigramCounts.get(g) ?? 0) + 1);
  const repeatedTrigramRatio = trigrams.length
    ? [...trigramCounts.values()].filter((n) => n > 1).length / trigramCounts.size
    : 0;

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
    commonWordRatio,
    openerDiversity,
    repeatedTrigramRatio,
    bannedFound,
  };
};

/**
 * Thresholds for the lexical tells.
 *
 * Set loose deliberately. These measure a tendency rather than a mistake, and a
 * gate that fires on ordinary prose gets widened until it means nothing. They
 * exist to catch the draft that is obviously machine-shaped, not to police
 * word choice.
 */
export const MIN_OPENER_DIVERSITY = 0.62;
export const MAX_COMMON_WORD_RATIO = 0.58;
export const MAX_REPEATED_TRIGRAM_RATIO = 0.06;

/** Below this many sentences these measures are noise, not signal. */
const LEXICAL_MIN_SENTENCES = 6;

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

  // The lexical half of the AI tell, which this file measured nothing of until
  // now. Detection research treats predictable word choice as co-equal with
  // uniform rhythm; the rhythm check above was only ever half the story.
  if (m.sentences >= LEXICAL_MIN_SENTENCES) {
    if (m.openerDiversity < MIN_OPENER_DIVERSITY) {
      violations.push({
        rule: 'openerDiversity',
        detail:
          `${((1 - m.openerDiversity) * 100).toFixed(0)}% of sentences start the same way as another. ` +
          `Vary where a sentence enters, not just how long it is.`,
        blocking: true,
      });
    }

    if (m.repeatedTrigramRatio > MAX_REPEATED_TRIGRAM_RATIO) {
      violations.push({
        rule: 'repeatedPhrases',
        detail: `${(m.repeatedTrigramRatio * 100).toFixed(0)}% of three-word phrases repeat`,
        blocking: true,
      });
    }

    // Advisory: a high common-word share can be a legitimately plain register,
    // and blocking it would push the writer towards thesaurus prose, which is
    // worse than the thing it fixes.
    if (m.commonWordRatio > MAX_COMMON_WORD_RATIO) {
      violations.push({
        rule: 'commonWordRatio',
        detail: `${(m.commonWordRatio * 100).toFixed(0)}% of words are among the 200 commonest, which reads as predictable`,
        blocking: false,
      });
    }
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
