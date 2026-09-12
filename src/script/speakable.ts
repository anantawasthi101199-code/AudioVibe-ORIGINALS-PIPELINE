/**
 * Whether a sentence can be UNDERSTOOD BY EAR, first time, with no rewinding.
 *
 * THE GAP THIS CLOSES. Everything else in this repo checks whether the prose is
 * good. Nothing checked whether it is good ALOUD, and those are different
 * standards with different failure modes. A reader who loses a clause re-reads
 * the line. A listener who loses a clause has lost the rest of the paragraph,
 * because the words keep arriving and there is no way back.
 *
 * The first real episode was written to a prose standard and read well on the
 * page. Heard, it was hard work:
 *
 *   "A monarch's presence in a room is never incidental to what gets written
 *    afterward, because it changes who the account is for, what it can safely
 *    say, and who has an interest in making sure it was written down one way
 *    rather than another."
 *
 * Forty-one words, four subordinate clauses, and the subject is an abstraction.
 * On the page it is a decent sentence. In the ear it is a wall, and by the time
 * "rather than another" arrives the listener has lost "a monarch's presence".
 *
 * WHAT IS MEASURED, AND WHY THESE THINGS. All of it is arithmetic over the
 * text, so it costs nothing and cannot drift the way a model's opinion would.
 *
 *   1. BREATH LENGTH. A sentence longer than about twenty-five words cannot be
 *      said in one breath at a natural pace, so the speaker must break it
 *      somewhere the writing did not choose. Written prose can run long because
 *      the eye rests wherever it likes; spoken prose cannot.
 *
 *   2. CLAUSE DEPTH. Subordinate clauses are the actual difficulty. A listener
 *      holds the main clause in working memory while a subordinate one runs,
 *      and two nested is the practical limit before the thread drops. This is
 *      the measure that would have caught the sentence above, which is not
 *      unusually long by written standards.
 *
 *   3. FRONT-LOADING. "Because the record was written for lawyers, and because
 *      nobody expected it to be read aloud, the phrasing is dry." The listener
 *      has to hold two clauses with no idea what they attach to. The same
 *      sentence with the main clause first is immediately followable.
 *
 *   4. ABSTRACT SUBJECTS. "A monarch's presence is never incidental" versus
 *      "The king was in the room, and that changed what could be written down".
 *      Concrete subjects doing visible things are how spoken narrative works.
 *
 * WHAT IS NOT MEASURED. Word difficulty, deliberately. Long words are fine when
 * they are the right word and the show has defined them - "justiciary",
 * "pilliwinks" - and a syllable count would punish exactly the specificity that
 * makes this material worth hearing.
 */

export interface SpeakabilityMeasurement {
  sentences: number;
  /** Sentences over the one-breath limit. */
  overlong: number;
  longestWords: number;
  /** Mean subordinate clauses per sentence. */
  clauseDepthMean: number;
  /** Sentences opening with a subordinate clause before the main one. */
  frontLoaded: number;
  /** Share of sentences whose subject is an abstraction. */
  abstractSubjects: number;
}

export interface SpeakabilityProblem {
  rule: string;
  detail: string;
  blocking: boolean;
  /** The worst offender, so a rewrite has something to point at. */
  example?: string;
}

/**
 * One breath, at narration pace.
 *
 * Around 150 words a minute means twenty-five words is roughly ten seconds,
 * which is the far end of what a narrator delivers without breaking. Sentences
 * beyond it are not forbidden - one now and then is a deliberate rush - but a
 * script full of them is unspeakable.
 */
export const BREATH_WORDS = 25;

/** Above this share of over-long sentences, the script is hard work. */
export const MAX_OVERLONG_SHARE = 0.12;

/** Mean subordinate clauses per sentence, above which the thread drops. */
export const MAX_CLAUSE_DEPTH = 1.0;

/** Share of sentences that may open on a subordinate clause. */
export const MAX_FRONT_LOADED_SHARE = 0.2;

/** Share of sentences that may have an abstraction as their subject. */
export const MAX_ABSTRACT_SUBJECT_SHARE = 0.25;

const SUBORDINATORS =
  /\b(because|although|though|whereas|while|unless|since|if|when|whenever|after|before|until|as|that|which|who|whom|whose|where)\b/gi;

const FRONT_SUBORDINATORS =
  /^(because|although|though|whereas|while|unless|since|if|when|whenever|after|before|until|having|being|given|despite|in order)\b/i;

/**
 * Abstractions that make poor subjects for spoken narrative.
 *
 * Not a vocabulary blacklist - these words are fine inside a sentence. What is
 * being caught is a sentence whose SUBJECT is one of them, because then nothing
 * visible is doing anything and the listener has nothing to picture.
 */
const ABSTRACT_SUBJECT =
  /^(the |a |an |this |that |its |their |his |her )?(presence|absence|existence|nature|question|issue|matter|fact|idea|notion|concept|process|situation|context|significance|implication|tendency|possibility|reality|purpose|relationship|distinction|difference|problem|point)\b/i;

export const sentencesOf = (text: string): string[] =>
  text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);

const wordsIn = (sentence: string): string[] =>
  sentence.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));

/**
 * Subordinate clauses in a sentence, approximately.
 *
 * Counted from subordinating words, which over-counts slightly ("that" is
 * sometimes a determiner) and under-counts slightly (some clauses have no
 * marker). It does not need to be exact: it is a threshold over a whole script,
 * where both errors wash out, and the alternative is a parser.
 */
export const clauseDepth = (sentence: string): number =>
  (sentence.match(SUBORDINATORS) ?? []).length;

export const measureSpeakability = (text: string): SpeakabilityMeasurement => {
  const sentences = sentencesOf(text);
  if (!sentences.length) {
    return {
      sentences: 0,
      overlong: 0,
      longestWords: 0,
      clauseDepthMean: 0,
      frontLoaded: 0,
      abstractSubjects: 0,
    };
  }

  let overlong = 0;
  let longestWords = 0;
  let clauses = 0;
  let frontLoaded = 0;
  let abstract = 0;

  for (const sentence of sentences) {
    const n = wordsIn(sentence).length;
    if (n > BREATH_WORDS) overlong++;
    if (n > longestWords) longestWords = n;

    clauses += clauseDepth(sentence);
    if (FRONT_SUBORDINATORS.test(sentence)) frontLoaded++;
    if (ABSTRACT_SUBJECT.test(sentence)) abstract++;
  }

  return {
    sentences: sentences.length,
    overlong,
    longestWords,
    clauseDepthMean: clauses / sentences.length,
    frontLoaded,
    abstractSubjects: abstract / sentences.length,
  };
};

/** The sentence that most needs rewriting, for an error worth acting on. */
const worst = (text: string, score: (s: string) => number): string | undefined => {
  const sentences = sentencesOf(text);
  if (!sentences.length) return undefined;
  return sentences.reduce((a, b) => (score(b) > score(a) ? b : a));
};

/**
 * Below this many sentences, none of these shares mean anything.
 *
 * Every threshold here is a proportion, and a proportion over five sentences is
 * just "did one of them run long". A real episode is two hundred and fifty; a
 * three-minute segment is around forty. Judging anything shorter produces
 * confident nonsense, which is worse than silence because somebody acts on it.
 *
 * Same reasoning as MIN_TURNS_TO_JUDGE in voices.ts, and the same number of
 * arguments about it later if it is not written down.
 */
export const MIN_SENTENCES_TO_JUDGE = 40;

export const checkSpeakability = (
  text: string
): { measurement: SpeakabilityMeasurement; problems: SpeakabilityProblem[] } => {
  const m = measureSpeakability(text);
  const problems: SpeakabilityProblem[] = [];

  if (m.sentences < MIN_SENTENCES_TO_JUDGE) return { measurement: m, problems };

  const overlongShare = m.overlong / m.sentences;
  if (overlongShare > MAX_OVERLONG_SHARE) {
    problems.push({
      rule: 'breathLength',
      detail:
        `${Math.round(overlongShare * 100)}% of sentences run past ${BREATH_WORDS} words, ` +
        `which is one breath at narration pace. The longest is ${m.longestWords} words. ` +
        `A listener cannot re-read; a sentence they lose takes the paragraph with it.`,
      blocking: true,
      example: worst(text, (s) => wordsIn(s).length),
    });
  }

  if (m.clauseDepthMean > MAX_CLAUSE_DEPTH) {
    problems.push({
      rule: 'clauseDepth',
      detail:
        `${m.clauseDepthMean.toFixed(1)} subordinate clauses per sentence, over ${MAX_CLAUSE_DEPTH}. ` +
        `This is the measure that matters most for listening: a subordinate clause asks the ` +
        `listener to hold the main one open, and two at once is where the thread drops.`,
      blocking: true,
      example: worst(text, clauseDepth),
    });
  }

  const frontShare = m.frontLoaded / m.sentences;
  if (frontShare > MAX_FRONT_LOADED_SHARE) {
    problems.push({
      rule: 'frontLoaded',
      detail:
        `${Math.round(frontShare * 100)}% of sentences open on a subordinate clause before ` +
        `saying what they are about. On the page the eye waits; in the ear the listener is ` +
        `holding words with nothing to attach them to. Put the main clause first.`,
      blocking: true,
      example: worst(text, (s) => (FRONT_SUBORDINATORS.test(s) ? wordsIn(s).length : 0)),
    });
  }

  if (m.abstractSubjects > MAX_ABSTRACT_SUBJECT_SHARE) {
    problems.push({
      rule: 'abstractSubjects',
      detail:
        `${Math.round(m.abstractSubjects * 100)}% of sentences have an abstraction as their ` +
        `subject. "A monarch's presence is never incidental" gives a listener nothing to ` +
        `picture; "the king was in the room" does. Put a person or a thing in front.`,
      // Advisory. Some abstraction is unavoidable in analysis, and blocking on
      // it would push the writing toward a childishness nobody asked for.
      blocking: false,
    });
  }

  return { measurement: m, problems };
};
