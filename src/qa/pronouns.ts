/**
 * Whether the script gets real people's pronouns right.
 *
 * WHY THIS HAD TO EXIST, and it is the most serious gap found in the pipeline
 * so far. An episode called the sentencing judge "her" throughout - "the way
 * Kinch read them out", "she meant it plainly", "stood in front of her". The
 * corpus says "HHJ Christopher Kinch QC", "His Honour Judge Kinch", and "he did
 * not know", four times over. The gate passed all of it.
 *
 * THE EVIDENCE LAYER COULD NOT SEE IT, BY CONSTRUCTION. Every factual assertion
 * has to come from a verified claim, and the gate checks that each claim is
 * entailed by its quote. But no claim mentioned the judge at all: his name came
 * from the episode brief, and everything else about him was invented in the
 * connective prose BETWEEN the claims. That prose is not checked by anything,
 * because the design assumed facts only enter through claims.
 *
 * A pronoun is a factual assertion about a real person. This one was wrong,
 * about a named living judge, in a show whose entire pitch is that somebody
 * went and read the file.
 *
 * WHY A CHECK RATHER THAN AN INSTRUCTION. The writer was told to take facts
 * only from the claims, and did - it did not state a false fact about the
 * judge, it used a pronoun, which does not feel like stating a fact. An
 * instruction against it would have to be remembered on every sentence. The
 * corpus is right there and it knows the answer.
 *
 * DELIBERATELY CONSERVATIVE. It reports only where the sources are clear and
 * consistent, because a false accusation here would teach everyone to ignore
 * it. A person the sources never gender is not reported at all - see
 * MIN_EVIDENCE and DOMINANCE.
 */

export interface PronounProblem {
  name: string;
  /** The gendered pronoun the script used for them. */
  used: string;
  /** What the sources use. */
  supported: string;
  detail: string;
}

const HE = /\b(he|him|his)\b/gi;
const SHE = /\b(she|her|hers)\b/gi;

/**
 * How many gendered references the sources must contain before this check will
 * act on them. One stray pronoun in a quoted aside is not evidence.
 */
export const MIN_EVIDENCE = 2;

/**
 * How lopsided the sources must be to count as settled.
 *
 * Real documents contain other people, so a sentence about one man can easily
 * carry a "her" belonging to somebody else. Three to one is enough to be sure
 * without being fooled by that.
 */
export const DOMINANCE = 3;

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

/**
 * How far past a mention of somebody to keep reading, in characters.
 *
 * A DOCUMENT NAMES SOMEBODY AND THEN STOPS NAMING THEM. "Judge Kinch said he
 * had considered the reports. He told the court. He passed sentence." - all the
 * pronoun evidence is in sentences that never repeat the name, so looking only
 * at sentences containing it finds almost nothing and the check goes quiet
 * exactly where it should speak.
 *
 * The window is the cost of that: it can pull in a neighbouring person's
 * pronouns, which is what DOMINANCE is for.
 */
export const EVIDENCE_WINDOW = 300;

/**
 * The stretch of corpus that is about a person, as the evidence on them.
 *
 * Matched on the surname, because that is how documents refer back to somebody
 * after introducing them, and it is what a script does too.
 */
const textAbout = (corpus: string, surname: string): string => {
  const safe = surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${safe}\\b`, 'gi');

  const windows: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(corpus))) {
    windows.push(corpus.slice(m.index, m.index + EVIDENCE_WINDOW));
  }
  return windows.join(' ');
};

/**
 * Gender as the sources have it, or null where they do not settle it.
 *
 * Null is a real answer and is treated as one: a person the record never
 * genders is a person this check has nothing to say about, and guessing would
 * make it the thing it exists to prevent.
 */
export const genderInSources = (corpus: string, surname: string): 'he' | 'she' | null => {
  const about = textAbout(corpus, surname);
  if (!about) return null;

  const he = count(about, HE);
  const she = count(about, SHE);

  if (he >= MIN_EVIDENCE && he >= she * DOMINANCE) return 'he';
  if (she >= MIN_EVIDENCE && she >= he * DOMINANCE) return 'she';
  return null;
};

/**
 * Names in the script that look like people, paired with the pronouns used
 * nearest to them.
 *
 * Attribution is by proximity: a gendered pronoun belongs to the most recent
 * person named before it. Crude, and right often enough to be useful, because
 * narration introduces a person and then talks about them - which is the rule
 * the roster now enforces anyway.
 */
/**
 * How far after a name a pronoun may still be about that person, in words.
 *
 * WITHOUT A LIMIT THIS CHECK SILENTLY DOES NOTHING, which is how it was first
 * written. Carrying "the last person named" indefinitely meant a beat that
 * introduced the judge and then spent four sentences on the six burglars banked
 * all of THEIR pronouns against the judge. On the real episode that produced
 * five "he" and five "she" for one man, a tie, and no finding - the check
 * agreeing with itself that there was nothing to see.
 *
 * Twenty words is about one sentence. Beyond that, a pronoun with no name near
 * it is not evidence about anybody in particular, and the right thing is to
 * count nothing rather than to guess.
 */
export const ATTRIBUTION_WORDS = 20;

export const checkPronouns = (
  scriptText: string,
  corpusText: string,
  /** Names worth checking, usually the planned cast. Others are ignored. */
  known: string[]
): PronounProblem[] => {
  const surnames = known
    .map((n) => n.trim().split(/\s+/).pop() ?? '')
    .filter((s) => s.length >= 3);
  if (!surnames.length) return [];

  const words = scriptText
    .replace(/\[[^\]]{0,40}\]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  // Nearest preceding name wins, and only within a sentence's reach of it.
  const usedBy = new Map<string, { he: number; she: number }>();
  let current: string | null = null;
  let sinceName = 0;

  for (const raw of words) {
    const word = raw.replace(/[^A-Za-z']/g, '');
    if (!word) continue;

    const hit = surnames.find((s) => s.toLowerCase() === word.toLowerCase());
    if (hit) {
      current = hit;
      sinceName = 0;
      continue;
    }

    sinceName++;
    if (!current || sinceName > ATTRIBUTION_WORDS) continue;

    const lower = word.toLowerCase();
    const tally = usedBy.get(current) ?? { he: 0, she: 0 };
    if (lower === 'he' || lower === 'him' || lower === 'his') tally.he++;
    else if (lower === 'she' || lower === 'her' || lower === 'hers') tally.she++;
    else continue;
    usedBy.set(current, tally);
  }

  const problems: PronounProblem[] = [];
  for (const [surname, tally] of usedBy) {
    const used = tally.he > tally.she ? 'he' : tally.she > tally.he ? 'she' : null;
    if (!used) continue;

    const supported = genderInSources(corpusText, surname);
    if (!supported || supported === used) continue;

    problems.push({
      name: surname,
      used,
      supported,
      detail:
        `the script calls ${surname} "${used}", and the sources use "${supported}". ` +
        `A pronoun is a factual assertion about a real person, and this one is ` +
        `not in any claim - it was written into the prose between them.`,
    });
  }

  return problems;
};

/**
 * What the writer is told, so this mostly does not have to fire.
 *
 * The instruction alone is not enough, which is why the check exists, but it is
 * nearly free and it removes the commonest case: a name whose gender the writer
 * has no way of knowing.
 */
export const PRONOUN_RULE =
  'A PRONOUN IS A FACT. Never assign "he" or "she" to a real person unless the ' +
  'claims you were given say so. If they do not, use the name, or the role, or ' +
  '"they" - all of which read perfectly naturally and none of which can be ' +
  'wrong. Guessing from a name is how a show that has read the file gets a real ' +
  "person's identity wrong in public.";
