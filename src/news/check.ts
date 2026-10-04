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
import {
  namesSource,
  unfamiliarNames,
  unsourcedUnknowns,
  unsupportedFigures,
} from '../qa/sourceText';

/** The owner's ceiling: "a short less than 3 minutes". */
export const MAX_NEWS_SECONDS = 180;

/**
 * The ceiling the SCRIPT is held to, below the real one on purpose. Speech rate
 * is an estimate, and a script estimated at 179 seconds renders over.
 */
export const MAX_SCRIPT_SECONDS = 170;

// THE SOURCE-TEXT CHECKS LIVE IN qa/sourceText.ts, shared with the business
// lane so neither lane imports the other. Re-exported for this lane's callers.
export {
  EXACT_BELOW,
  ROUNDING_TOLERANCE,
  figuresIn,
  namesSource,
  unfamiliarNames,
  unsourcedUnknowns,
  unsupportedFigures,
} from '../qa/sourceText';

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
  /** Every outlet reported from, for a roundup. Defaults to [outlet]. */
  outlets?: string[];
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

  const outlets = input.outlets ?? [input.outlet];
  const names = unfamiliarNames(text, article, [
    input.persona.name,
    host.name,
    ...outlets,
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

  for (const outlet of outlets.filter((o) => !namesSource(text, o))) {
    add(
      'newsSource',
      `the report never says it comes from ${outlet}. One source, named on air, is the ` +
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
