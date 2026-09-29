/**
 * The news lane's checks. All of them free, all of them deterministic.
 *
 * WHY THESE AND NOT A VERIFIER. A report built on one article has exactly one
 * way to be wrong that matters: saying something the article does not. The
 * most damaging form of that on air is a wrong NUMBER - a death toll, a sum, a
 * vote count - and a number is also the one thing that can be checked against
 * the source with no model at all. So figures are checked exactly and BLOCK;
 * names are checked loosely and are reported for a person to read, because a
 * name can legitimately be spelled or shortened differently.
 *
 * The rest are the owner's requirements, each made checkable:
 *   one dependable source   the outlet is named on air
 *   a proper outro          the last part asks for the follow
 *   under three minutes     estimated before the render, measured after
 *   live and latest         the article's age, checked again at publish time
 */
import { Persona } from '../canon/schema';
import { EpisodeFormat } from '../formats/schema';
import { checkLedger } from '../evidence/claim';
import { Source } from '../evidence/source';
import { GateFinding, GateReport, runGate } from '../qa/gate';
import { Script, WORDS_PER_SECOND, beatText, fullText } from '../script/write';
import { countWords } from '../script/style';
import { Desk } from './desk';
import { ageHours, parseWhen } from './wire';

/** The owner's ceiling: "a short less than 3 minutes". */
export const MAX_NEWS_SECONDS = 180;

/**
 * The ceiling the SCRIPT is held to, below the real one on purpose. Speech rate
 * is an estimate, and a script estimated at 179 seconds renders over.
 */
export const MAX_SCRIPT_SECONDS = 170;

/** How far a spoken figure may be rounded from the article's: "about 40,000". */
export const ROUNDING_TOLERANCE = 0.1;

/** Below this a count is small enough that rounding it is changing it. */
export const EXACT_BELOW = 20;

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, dozen: 12,
};

const MONTHS =
  'january|february|march|april|may|june|july|august|september|october|november|december';

/** Every figure in a text, digits and (for the article) small number words. */
export const figuresIn = (text: string, withWords = false): number[] => {
  const out: number[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  if (withWords) {
    for (const m of text.toLowerCase().matchAll(/\b[a-z]+\b/g)) {
      const n = WORD_NUMBERS[m[0]];
      if (n !== undefined) out.push(n);
    }
  }
  return out;
};

/**
 * Figures in the script that are dates and times, which the script is TOLD to
 * say and the article need not contain in the same form: the day of the month
 * next to a month name, clock times, and the current year.
 */
const exemptSpans = (text: string): Array<[number, number]> => {
  const spans: Array<[number, number]> = [];
  const patterns = [
    new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\b`, 'gi'),
    new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'gi'),
    /\b\d{1,2}[:.]\d{2}\s*(?:am|pm|gmt|bst|utc)?\b/gi,
    /\b\d{1,2}\s*(?:am|pm)\b/gi,
    // "at 10 this morning", "around 6 in the evening": when it was reported,
    // which the writer is TOLD in UK time and the article states in its own zone.
    /\b\d{1,2}\s+(?:o'clock|this (?:morning|afternoon|evening)|in the (?:morning|afternoon|evening)|last night|tonight)\b/gi,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) spans.push([m.index!, m.index! + m[0].length]);
  return spans;
};

/**
 * Figures the script says that the article does not contain.
 *
 * A figure matches when the article has the same number, or - for figures of
 * twenty and over - one within ten per cent of it, which is the rounding a
 * newsreader does. "About 40,000" for 39,812 passes; "about 40,000" for 34,000
 * does not; "5 killed" for four killed never does.
 */
export const unsupportedFigures = (script: string, article: string, now: Date): string[] => {
  const known = figuresIn(article, true);
  const exempt = exemptSpans(script);
  const thisYear = now.getUTCFullYear();
  const problems = new Set<string>();

  for (const m of script.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const at = m.index!;
    if (exempt.some(([a, b]) => at >= a && at < b)) continue;
    const n = Number(m[0].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    if (n === thisYear) continue;

    const matched = known.some((k) =>
      n < EXACT_BELOW || k < EXACT_BELOW
        ? k === n
        : Math.abs(n - k) <= ROUNDING_TOLERANCE * Math.max(k, n)
    );
    if (!matched) problems.add(m[0]);
  }
  return [...problems];
};

const COMMON_CAPITALS = new Set(
  (
    'I A An The This That These Those It Its In On At For From By With As And But Or So If When ' +
    'While After Before Now Then There Here What Why How Who Where Which Monday Tuesday Wednesday ' +
    'Thursday Friday Saturday Sunday January February March April May June July August September ' +
    'October November December Mr Mrs Ms Dr Sir UN NATO EU US UK Again Meanwhile Until Thanks ' +
    'Follow See Bye Goodbye Take Also Still Even Both Some Many Most One Two Three ' +
    // Institutions, which an article often writes as an abbreviation ("U.N.")
    // that the script is told to spell out. Seen live: "Nations" flagged.
    'United Nations States Kingdom Union European Council Security General Assembly White House ' +
    'Ministry Minister President Prime Foreign Secretary Supreme Leader Court Parliament Congress ' +
    'Senate Government Army Navy Air Force Defence Defense Department State Republic'
  ).split(' ')
);

/**
 * Capitalised words the article never uses. Advisory: a name can be written
 * two ways and both be right, and a place named to orient a listener is
 * allowed. What this surfaces for a person is a NAME THE ARTICLE NEVER
 * MENTIONS, which is the other shape of adding something from memory.
 */
export const unfamiliarNames = (script: string, article: string, allowed: string[]): string[] => {
  const haystack = article.toLowerCase();
  const allow = new Set(allowed.flatMap((a) => a.split(/\s+/)).map((w) => w.toLowerCase()));
  const found = new Set<string>();

  for (const sentence of script.split(/(?<=[.!?])\s+/)) {
    const words = sentence.split(/\s+/);
    words.forEach((raw, i) => {
      const word = raw.replace(/^[^A-Za-z]+|[^A-Za-z']+$/g, '').replace(/'s$/, '');
      if (!/^[A-Z][a-zA-Z]{2,}$/.test(word)) return;
      // THE FIRST WORD OF A SENTENCE IS CAPITALISED ANYWAY. Seen live:
      // "Separately" flagged as a name. A real name there is almost always
      // repeated mid-sentence, where it is still checked.
      if (i === 0) return;
      if (COMMON_CAPITALS.has(word) || allow.has(word.toLowerCase())) return;
      if (!haystack.includes(word.toLowerCase())) found.add(word);
    });
  }
  return [...found];
};

/** "the BBC" is said "the BBC" or "BBC"; either counts. */
export const namesSource = (script: string, outlet: string): boolean => {
  const bare = outlet.replace(/^the\s+/i, '').toLowerCase();
  return script.toLowerCase().includes(bare);
};

/**
 * Statements that something is NOT known, and the words that must then be in
 * the source for the statement to be the source's rather than the writer's.
 */
const UNKNOWNS: Array<[RegExp, RegExp]> = [
  [/\bno (date|timeline|timetable|deadline) (has|had) been (set|given|announced)\b/i, /\bno (date|timeline|timetable|deadline)\b/i],
  [/\b(it is|it's|it remains|it was) (not |un)clear\b/i, /\b(not clear|unclear)\b/i],
  [/\b(did|does|has) not (say|said|specify|specified|indicate|indicated) (when|whether|how|what|why)\b/i, /\b(did|does|has) not (say|specify|indicate)\b/i],
  // "behind the scenes" was here and blocked a fair turn of phrase ("has not
  // rejected it behind the scenes"). A phrase is not an unknown.
  [/\b(remains to be seen|no word (yet )?on)\b/i, /\b(remains to be seen|no word)\b/i],
];

export const unsourcedUnknowns = (script: string, article: string): string[] =>
  UNKNOWNS.flatMap(([said, needs]) => {
    const m = script.match(said);
    return m && !needs.test(article) ? [m[0]] : [];
  });

/** Verbs a newsreader never puts in their own voice. */
export const LOADED_VERBS = /\b(claimed|claims|admitted|admits|slammed|slams|blasted|blasts|insisted|vowed)\b/gi;

/**
 * The checks the writer can act on, before any audio exists. The pipeline also
 * reports these as gate findings; they are here separately so a revision (when
 * switched on) is told exactly what to fix.
 */
export const draftProblems = (
  beats: Array<{ beatId: string; turns: Array<{ text: string }> }>,
  input: { article: string; outlet: string; now: Date; closingBeatId: string }
): string[] => {
  const text = beats.map((b) => b.turns.map((t) => t.text).join(' ')).join('\n');
  const problems: string[] = [];

  const figures = unsupportedFigures(text, input.article, input.now);
  if (figures.length) {
    problems.push(`figures that are not in the article: ${figures.join(', ')}`);
  }
  if (!namesSource(text, input.outlet)) {
    problems.push(`the report never says it comes from ${input.outlet}`);
  }
  const close = beats.find((b) => b.beatId === input.closingBeatId);
  if (!close || !/\bfollow/i.test(close.turns.map((t) => t.text).join(' '))) {
    problems.push('the last part never asks the listener to follow');
  }
  const seconds = countWords(text) / WORDS_PER_SECOND;
  if (seconds > MAX_SCRIPT_SECONDS) {
    problems.push(
      `about ${Math.round(seconds)} seconds read aloud, over the ${MAX_SCRIPT_SECONDS} a script ` +
        `is allowed so that the audio lands under three minutes`
    );
  }
  return problems;
};

export interface NewsGateInput {
  persona: Persona;
  format: EpisodeFormat;
  desk: Desk;
  script: Script;
  source: Source;
  outlet: string;
  /** When the article was published, as the run recorded it. */
  publishedAt: string;
  /** Measured if there is audio, else estimated from the words. */
  durationS: number;
  measured: boolean;
  now: Date;
  priorTexts?: Array<{ label: string; text: string }>;
  stagesOff?: string[];
}

/**
 * The shared gate, then the news checks on top of it.
 *
 * THE SHARED GATE RUNS IN ITS "reference" MODE, which skips the claim-ledger
 * sections - there is no ledger on this lane - and keeps every property of the
 * audio: style, repetition, speakability, self-similarity, duration. What the
 * reference review would have been on the story lane, the figure and name
 * checks are here, and they are REAL checks, so `checked: true` is the truth.
 */
export const newsGate = (input: NewsGateInput): GateReport => {
  const text = fullText(input.script);
  const article = input.source.text;
  const host = input.persona.hosts[0]!;

  const names = unfamiliarNames(text, article, [
    input.persona.name,
    host.name,
    input.outlet,
    input.desk.beat,
  ]);

  const base = runGate({
    persona: input.persona,
    format: input.format,
    script: input.script,
    claims: [],
    ledger: checkLedger([], [input.source]),
    verification: { results: [], blocking: [], costPence: 0, verifierModel: '' },
    counterEvidence: [],
    durationS: input.durationS,
    priorTexts: input.priorTexts,
    corpusText: article,
    castNames: [],
    stagesOff: input.stagesOff,
    evidence: 'reference',
    referenceReview: {
      checked: true,
      unanswered: [],
      unsupported: names.map((n) => `the name "${n}" does not appear in the article`),
    },
    sources: [input.source],
  });

  const findings: GateFinding[] = [...base.findings];
  const humanReviewReasons = [...base.humanReviewReasons];
  const add = (check: string, detail: string, blocking = true) =>
    findings.push({ check, detail, blocking });

  const figures = unsupportedFigures(text, article, input.now);
  if (figures.length) {
    add(
      'newsFigures',
      `the report says ${figures.join(', ')}, and the article does not contain ` +
        `${figures.length === 1 ? 'that figure' : 'those figures'}. A wrong number read out as news ` +
        `is the most damaging mistake this channel can make. Fix the script or remake it.`
    );
  }

  if (!namesSource(text, input.outlet)) {
    add(
      'newsSource',
      `the report never says it comes from ${input.outlet}. One source, named on air, is the ` +
        `whole basis on which this channel reports.`
    );
  }

  const closing = input.script.beats[input.script.beats.length - 1];
  if (!closing || !/\bfollow/i.test(beatText(closing))) {
    add('newsOutro', 'the last part never asks the listener to follow the channel.');
  }

  if (input.durationS > MAX_NEWS_SECONDS) {
    add(
      'newsLength',
      `${input.measured ? 'runs' : 'would run about'} ${Math.round(input.durationS)}s. ` +
        `A report on this channel is under three minutes.`
    );
  }

  const when = parseWhen(input.publishedAt);
  const age = when ? ageHours(when, input.now) : Infinity;
  if (age > input.desk.publishWithinHours) {
    add(
      'newsStale',
      `the article is ${Number.isFinite(age) ? `${Math.round(age)} hours` : 'of unknown age and'} ` +
        `old, past the ${input.desk.publishWithinHours} hours this desk allows at publish. It is no ` +
        `longer news. Make a new report instead.`
    );
  }

  // THE PAGE IS NEVER THE SOURCE ON AIR. "The article does not say" survived an
  // explicit rule in the prompt on the first rendered report, so it is checked.
  const meta = text.match(/\bthe (article|report|piece|story) (does not|doesn't|says|notes|adds|mentions)\b[^.]*/gi);
  if (meta?.length) {
    add(
      'newsMeta',
      `"${meta[0]}" talks about the page instead of reporting. A reporter says "${input.outlet} ` +
        `reports", and leaves out what the source does not say.`
    );
  }

  // AN INVENTED UNKNOWN. Seen on the first rendered report: "PBS NewsHour
  // reports no date has been set", a sentence the source never contained,
  // written to fill the what-happens-next slot and credited to the outlet. A
  // statement about what is NOT known is a claim like any other, so it must be
  // in the source in its own words.
  for (const found of unsourcedUnknowns(text, article)) {
    add(
      'newsUnknown',
      `"${found}" says something is not known, and the source never says so. Cut it: a gap ` +
        `in the source is left out, never reported.`
    );
  }

  const loaded = [...new Set((text.match(LOADED_VERBS) ?? []).map((w) => w.toLowerCase()))];
  if (loaded.length) {
    add(
      'newsLoadedWords',
      `"${loaded.join('", "')}" in the reporter's own voice takes a side. Newsreaders say "said".`,
      false
    );
  }

  const passed = !findings.some((f) => f.blocking);
  return {
    ...base,
    passed,
    findings,
    needsHumanReview: base.needsHumanReview || humanReviewReasons.length > 0,
    humanReviewReasons,
  };
};

/** A script's length before any audio: the same estimate the story lanes use. */
export const estimatedSeconds = (script: Script): number =>
  countWords(fullText(script)) / WORDS_PER_SECOND;
