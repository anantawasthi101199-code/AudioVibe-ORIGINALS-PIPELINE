/**
 * Checks of a script against the ONE document it was written from. Free and
 * deterministic, and shared by every one-source lane (news, business stories)
 * so that neither lane depends on the other.
 *
 * A figure is the one thing that can be checked against a source with no model
 * at all, and a wrong one is the most damaging mistake a factual show can make,
 * so the lanes BLOCK on it. Names are checked loosely and only reported, because
 * a name can be written two ways and both be right.
 */

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

    // A YEAR IS NEVER ROUNDED. 1932 is within ten per cent of 1937, and a
    // company history founded in the wrong year passed this check until a
    // test caught it. A four-digit number without a comma in the range years
    // live in is treated as a year and must match exactly.
    // Trailing punctuation is the sentence, not the number: "In 1932, he...".
    const isYear = /^(1[5-9]\d{2}|20\d{2})$/.test(m[0].replace(/,+$/, ''));
    const matched = known.some((k) =>
      isYear || n < EXACT_BELOW || k < EXACT_BELOW
        ? k === n
        : Math.abs(n - k) <= ROUNDING_TOLERANCE * Math.max(k, n)
    );
    if (!matched) problems.add(m[0].replace(/,+$/, ''));
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

/**
 * Talking about the page instead of telling: "the article says", "the source
 * does not mention". Seen on the first rendered news report.
 */
export const aboutThePage = (script: string): string | null =>
  script.match(
    /\bthe (article|report|piece|story|source|text|page) (does not|doesn't|says|notes|adds|mentions|describes)\b[^.]*/i
  )?.[0] ?? null;

/**
 * Quotation marks around words the source does not contain. A quoted line is
 * a claim that somebody SAID exactly this, and inventing one puts words in a
 * real person's mouth. Short fragments (under four words) are left alone: those
 * are usually a name or a phrase, not a quotation.
 */
export const inventedQuotes = (script: string, source: string): string[] => {
  const flat = (t: string) =>
    t
      .toLowerCase()
      .replace(/[‘’“”"']/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const haystack = flat(source);
  const out: string[] = [];
  for (const m of script.matchAll(/["“]([^"”]{3,400})["”]/g)) {
    const inner = m[1]!;
    if (inner.trim().split(/\s+/).length < 4) continue;
    if (!haystack.includes(flat(inner))) out.push(inner.trim());
  }
  return out;
};
