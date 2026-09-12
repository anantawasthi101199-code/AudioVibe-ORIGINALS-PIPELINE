/**
 * Plain words, which is a different thing from short sentences.
 *
 * WHERE THIS CAME FROM. A listener heard a finished episode and asked for
 * "simple language, simple straightforward and continuous". The prose measured
 * fine on every existing instrument - sentence length, variance, clause depth,
 * signposting - because none of them look at the WORDS.
 *
 * Measured on that episode: 8.6% of ordinary words ran to three syllables or
 * more, and 1.8 per hundred were nominalisations. That is unremarkable on a
 * page and noticeably heavy in the ear.
 *
 * THE NOMINALISATION IS THE REAL CULPRIT and it is worth naming precisely,
 * because "use simpler words" is not followable and this is. English lets you
 * turn a verb into a noun - decide becomes decision, maintain becomes
 * maintenance, recommend becomes recommendation - and every time you do, the
 * sentence loses the person doing it:
 *
 *   "a decision was made that a response was not required"
 *   "somebody decided nobody needed to go and look"
 *
 * Same fact. The second one has a person in it, is shorter, and has no word in
 * it a twelve-year-old would stumble on. That is the whole technique, and it
 * gets one rule rather than a lecture.
 *
 * DELIBERATELY ADVISORY, EXCEPT AT THE EXTREME. There are already ten blocking
 * checks on the writing, and every rejection pushes prose toward the safe and
 * the flat - a risk worth naming rather than adding to. So this reports, the
 * prompt does the work, and it only blocks at a level well past anything a real
 * episode has produced, where the beat has stopped being speech.
 */

export interface PlainProblem {
  rule: string;
  detail: string;
  blocking: boolean;
  example?: string;
}

/**
 * Rough syllable count.
 *
 * Vowel groups, with a silent trailing "e" removed. Wrong on a handful of words
 * and right on the shape of a script, which is what is being measured.
 */
export const syllables = (word: string): number =>
  (word.toLowerCase().replace(/e$/, '').match(/[aeiouy]+/g) ?? []).length || 1;

/**
 * Endings that mark a verb turned into a noun.
 *
 * Not every match is a fault - "question" and "person" are ordinary words that
 * happen to end this way - which is why this feeds a DENSITY rather than
 * flagging individual words. A script with one is unremarkable; a script with
 * one every forty words is an essay.
 */
const NOMINAL = /(tion|sion|ment|ance|ence|ity|ness|ism)s?$/i;

/** Words this fires on constantly and should not: ordinary nouns, not nominalisations. */
const NOT_REALLY = new Set([
  'question',
  'person',
  'moment',
  'business',
  'witness',
  'distance',
  'chance',
  'sentence',
  'science',
  'silence',
  'evidence',
  'once',
  'since',
]);

export interface PlainMeasurement {
  words: number;
  longShare: number;
  nominalPer100: number;
  worstLong: string[];
  worstNominal: string[];
}

/**
 * Ordinary words only.
 *
 * Names are excluded because a show about Piper Alpha has to say "Piper Alpha",
 * and hyphenated compounds because "hand-tightened" is two plain words a
 * speaker says without trouble. Numbers written out - "sixty-seven",
 * "five-oh-four" - are long by syllable count and simple by every measure that
 * matters, so they go too.
 */
const ordinaryWords = (text: string): string[] =>
  text
    .replace(/\[[^\]]{0,40}\]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z'-]/g, ''))
    .filter(Boolean)
    .filter((w) => !/^[A-Z]/.test(w))
    .filter((w) => !w.includes('-'));

export const measurePlainness = (text: string): PlainMeasurement => {
  const words = ordinaryWords(text);
  if (!words.length) {
    return { words: 0, longShare: 0, nominalPer100: 0, worstLong: [], worstNominal: [] };
  }

  const long = words.filter((w) => syllables(w) >= 3);
  const nominal = words.filter((w) => NOMINAL.test(w) && !NOT_REALLY.has(w.toLowerCase()));

  return {
    words: words.length,
    longShare: long.length / words.length,
    nominalPer100: (nominal.length / words.length) * 100,
    worstLong: [...new Set(long)].sort((a, b) => syllables(b) - syllables(a)).slice(0, 6),
    worstNominal: [...new Set(nominal)].slice(0, 6),
  };
};

/** Below this many words, the ratios are noise. */
export const MIN_WORDS_TO_JUDGE = 120;

/** Share of ordinary words that may run to three syllables or more. */
export const LONG_WORD_SHARE = 0.065;

/** Nominalisations per hundred ordinary words. */
export const NOMINAL_PER_100 = 1.1;

/**
 * Where it stops being heavy and starts not being speech.
 *
 * Set well past anything a real episode has produced - the worst measured was
 * 8.6% and 1.8 - so this only fires on prose that has genuinely turned into a
 * report.
 */
export const LONG_WORD_BLOCK = 0.12;
export const NOMINAL_BLOCK = 3;

export const checkPlainWords = (text: string): PlainProblem[] => {
  const m = measurePlainness(text);
  if (m.words < MIN_WORDS_TO_JUDGE) return [];

  const problems: PlainProblem[] = [];

  if (m.nominalPer100 > NOMINAL_PER_100) {
    problems.push({
      rule: 'plain:nominalisations',
      detail:
        `${m.nominalPer100.toFixed(1)} nominalisations per 100 words, against ${NOMINAL_PER_100}. ` +
        `Each one hides the person doing the thing: "a decision was made" rather than ` +
        `"somebody decided".`,
      blocking: m.nominalPer100 > NOMINAL_BLOCK,
      example: m.worstNominal.join(', '),
    });
  }

  if (m.longShare > LONG_WORD_SHARE) {
    problems.push({
      rule: 'plain:longWords',
      detail:
        `${Math.round(m.longShare * 100)}% of ordinary words run to three syllables or more, ` +
        `against ${Math.round(LONG_WORD_SHARE * 100)}%. Names, numbers and hyphenated ` +
        `compounds are not counted, so this is genuinely the vocabulary.`,
      blocking: m.longShare > LONG_WORD_BLOCK,
      example: m.worstLong.join(', '),
    });
  }

  return problems;
};

/**
 * What the writer is told.
 *
 * ONE TECHNIQUE, NAMED, WITH AN EXAMPLE. "Use simpler words" is not followable
 * and produces a model's idea of simple, which is short flat sentences about
 * nothing. "Put the person back in the sentence" is a thing to do, and doing it
 * fixes the vocabulary as a side effect.
 */
export const PLAIN_GUIDANCE = [
  'PUT THE PERSON BACK IN THE SENTENCE. English lets you turn a verb into a noun - decide becomes decision, maintain becomes maintenance - and every time you do, whoever did it disappears. "A decision was made that a response was not required" becomes "somebody decided nobody needed to go and look". Shorter, plainer, and it has a person in it.',
  'Use the word a person would use out loud. Not "recertification" but "it was due to be checked". Not "the regulatory overhaul that followed" but "the rules changed". If a word only appears in documents, say what it means instead.',
  'Where a technical term is the actual subject and cannot be avoided, say it once and say what it is in the same breath, in ordinary words. "A pressure safety valve, the thing that lets gas escape before it can build up." Then just use the short name.',
  'Keep it continuous. One thing leads to the next, and the listener never has to hold something in mind waiting for it to be picked up later.',
];
