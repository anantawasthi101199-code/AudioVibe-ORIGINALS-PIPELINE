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

/**
 * Share of ordinary words that may run to three syllables or more, advisory.
 *
 * DELIBERATELY BELOW THE REFERENCE CORPUS, AND LEFT THERE AFTER NEARLY RAISING IT.
 *
 * The corpus of 25 long-form transcripts runs a median of 12.5% long words, so
 * 6.5% sits below its entire distribution and this note fires on almost every
 * beat. That looked like a miscalibration and the fix looked obvious.
 *
 * It is not, for two reasons. That corpus leans heavily on clinical and
 * scientific explainers - ADHD, BPD, postpartum depression, dark energy - whose
 * vocabulary is genuinely heavier than a told story's, so its median is the wrong
 * target for this network. And this number is an ASPIRATION rather than a
 * refusal: it says the network wants to be plainer than the average explainer,
 * which is a decision somebody made on purpose, and a test pins it to be tighter
 * than the episode that prompted it.
 *
 * So the aspiration stays and only the REFUSAL moved. See LONG_WORD_BLOCK, which
 * was sitting at the corpus median and sending back 58% of the target. An
 * advisory that fires often is a gradient to read; a block that fires often is a
 * good episode refused, and only the second one is a defect.
 */
export const LONG_WORD_SHARE = 0.065;

/** Nominalisations per hundred ordinary words, advisory. Same argument as above. */
export const NOMINAL_PER_100 = 1.1;

/**
 * Where it stops being heavy and starts not being speech.
 *
 * RE-SET FROM A REFERENCE CORPUS, AND THE OLD NUMBERS WERE AT ITS MEDIAN.
 *
 * These were 0.12 and 3, justified as "well past anything a real episode has
 * produced - the worst measured was 8.6% and 1.8". That was true of the only
 * evidence available at the time, which was this studio's own output. Measured
 * against 129 beat-sized chunks of 25 long-form transcripts the owner named as
 * the target:
 *
 *              p50     p75     p90     p95     p99
 *   longShare  0.125   0.160   0.185   0.196   0.218
 *   nominal    2.37    3.56    4.48    5.24    6.53
 *
 * So 0.12 sat at the target's MEDIAN and would have sent back 58% of it, and 3
 * sat between its median and p75 and would have sent back 36%. A threshold set
 * from our own worst output will always be tight, because our own output is what
 * we are trying to improve.
 *
 * Now at roughly the corpus p95: we essentially never refuse writing of the kind
 * we are aiming at, and still catch prose that has genuinely turned into a
 * report.
 *
 * GENRE CAVEAT, recorded because it will matter later. That corpus leans heavily
 * on clinical and scientific explainers - ADHD, BPD, postpartum depression, dark
 * energy - which legitimately carry long words. A myth retelling should be
 * plainer than its p95, and the place to say so is the persona, not here. These
 * are the network's outer bounds, not a target.
 */
export const LONG_WORD_BLOCK = 0.2;
export const NOMINAL_BLOCK = 5.2;

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
  // GENERIC ON PURPOSE. This used to say "where a technical term is the actual
  // subject and cannot be avoided", which let almost everything through: a city
  // nobody has heard of, a job title, an institution, a word from the language
  // the story is in. None of those are technical terms and all of them stop a
  // listener dead, because a listener cannot look anything up and cannot ask.
  'THE FIRST TIME A LISTENER MEETS AN UNFAMILIAR WORD, GIVE IT TO THEM. Anything outside everyday speech gets a few plain words attached the first time it is used, and after that it is just the short name. This covers far more than jargon: a job ("an epidemiologist, one of the people who work out how a disease is spreading"), a place ("Uruk, a city in what is now southern Iraq"), an institution ("the Cullen Inquiry, the public investigation set up afterwards"), a piece of equipment, a title, a rank, a word from another language, a period of history.',
  'ATTACH THE EXPLANATION, DO NOT STOP FOR IT. It belongs in the same breath as the word, as an aside - never as its own sentence beginning "now, a ziggurat is...". Stopping to define something is how a story turns into a lecture, and the listener feels the gear change.',
  'If an unfamiliar word appears once and nothing depends on it, cut the word rather than explaining it. A name the listener will never meet again costs them more to hold than it is worth.',
  // A DEFINITION IS NOT A PICTURE. The rule above gets the words right and a
  // listener can still finish the sentence holding nothing: "dynamic
  // contrast-enhanced MRI, a technique that tracks how a substance spreads
  // through tissue over time" is accurate, plain, and pictures nothing. A
  // listener told a health episode was "too technical to be followed" while
  // liking everything in it, which is this exactly - every term defined, none
  // of them landed.
  'WHERE SOMETHING IS HARD TO PICTURE, ANCHOR IT TO SOMETHING ORDINARY. A size, a speed, a distance, a quantity or a physical process the listener has never seen gets one short comparison to something they have: the gaps between cells widening "by about a fifth, the difference between a crowd you can walk through and one you cannot"; a dose "about what is in a strong cup of coffee"; a duration "roughly a working week". One clause, in the same breath, and only where the thing genuinely cannot be pictured without it.',
  'THE COMPARISON IS A HANDLE, NOT THE EXPLANATION. Give the real mechanism and the real number, then the comparison so the listener can hold it. A comparison that arrives INSTEAD of the mechanism has taken the content away, which is worse than being technical - the listener leaves feeling they understood something and holding nothing they can use. Never more than one per idea, and never a chain of them.',
  'Keep it continuous. One thing leads to the next, and the listener never has to hold something in mind waiting for it to be picked up later.',
];
