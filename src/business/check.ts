/**
 * The business lane's checks. Free and deterministic, like the news lane's,
 * and sharing the same source-text checks (qa/sourceText.ts) without sharing
 * anything else.
 *
 *   BLOCKS publish:
 *     a figure the source does not contain (years included: a wrong founding
 *       year is the commonest error in a retold company history)
 *     a quotation the source does not contain (words in a real person's mouth)
 *     an "unknown" the source never stated
 *     talking about "the source" or "the article" instead of telling
 *     no follow ask in the last part
 *     a short over three minutes
 *   REPORTS for a person:
 *     names the source never uses
 *     the story jumping back in time after the hook
 */
import { Persona } from '../canon/schema';
import { EpisodeFormat } from '../formats/schema';
import { checkLedger } from '../evidence/claim';
import { Source } from '../evidence/source';
import { GateFinding, GateReport, runGate } from '../qa/gate';
import {
  aboutThePage,
  inventedQuotes,
  unfamiliarNames,
  unsourcedUnknowns,
  unsupportedFigures,
} from '../qa/sourceText';
import { Script, WORDS_PER_SECOND, beatText, fullText } from '../script/write';
import { countWords } from '../script/style';

/** The owner's ceiling for a short: "under 3 mins". */
export const MAX_SHORT_SECONDS = 180;

/** Backwards jumps in years tolerated before the order is reported. */
export const CHRONOLOGY_SLACK_YEARS = 2;

/**
 * Times the story steps back in time, part by part after the hook. A hook may
 * start anywhere; after it the life is told in order, and a listener who hears
 * 1985, then 1962, then 1991 loses the thread.
 */
export const chronologyJumps = (beats: Array<{ turns: Array<{ text: string }> }>, now: Date): number => {
  const thisYear = now.getUTCFullYear();
  let latest = 0;
  let jumps = 0;
  // Skip the hook (first) and the ending (last), which look back and forward
  // on purpose.
  for (const beat of beats.slice(1, -1)) {
    const text = beat.turns.map((t) => t.text).join(' ');
    for (const m of text.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)) {
      const y = Number(m[1]);
      if (y > thisYear) continue;
      if (latest && y < latest - CHRONOLOGY_SLACK_YEARS) jumps += 1;
      latest = Math.max(latest, y);
    }
  }
  return jumps;
};

/** The problems a revision (when switched on) is told to fix. */
export const businessDraftProblems = (
  beats: Array<{ beatId: string; turns: Array<{ text: string }> }>,
  input: { source: string; now: Date; kind: 'short' | 'long' }
): string[] => {
  const text = beats.map((b) => b.turns.map((t) => t.text).join(' ')).join('\n');
  const problems: string[] = [];
  const figures = unsupportedFigures(text, input.source, input.now);
  if (figures.length) problems.push(`figures that are not in the source: ${figures.join(', ')}`);
  const quotes = inventedQuotes(text, input.source);
  if (quotes.length) problems.push(`quotations the source does not contain: "${quotes.join('", "')}"`);
  const last = beats[beats.length - 1];
  if (!last || !/\bfollow/i.test(last.turns.map((t) => t.text).join(' '))) {
    problems.push('the last part never asks the listener to follow');
  }
  if (input.kind === 'short' && countWords(text) / WORDS_PER_SECOND > MAX_SHORT_SECONDS - 10) {
    problems.push(`about ${Math.round(countWords(text) / WORDS_PER_SECOND)}s read aloud, over a short's budget`);
  }
  return problems;
};

export interface BusinessGateInput {
  persona: Persona;
  format: EpisodeFormat;
  script: Script;
  source: Source;
  /** The cleaned text the script was written from. */
  text: string;
  durationS: number;
  measured: boolean;
  now: Date;
  priorTexts?: Array<{ label: string; text: string }>;
  stagesOff?: string[];
}

export const businessGate = (input: BusinessGateInput): GateReport => {
  const script = fullText(input.script);
  const host = input.persona.hosts[0]!;
  const names = unfamiliarNames(script, input.text, [input.persona.name, host.name]);

  // The shared gate in its "reference" mode: no claim ledger on this lane, and
  // every property of the audio still checked. Same as the news lane.
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
    corpusText: input.text,
    castNames: [],
    stagesOff: input.stagesOff,
    evidence: 'reference',
    referenceReview: {
      checked: true,
      unanswered: [],
      unsupported: names.map((n) => `the name "${n}" does not appear in the source`),
    },
    sources: [input.source],
  });

  const findings: GateFinding[] = [...base.findings];
  const add = (check: string, detail: string, blocking = true) =>
    findings.push({ check, detail, blocking });

  const figures = unsupportedFigures(script, input.text, input.now);
  if (figures.length) {
    add(
      'bizFigures',
      `the script says ${figures.join(', ')}, and the source does not contain ` +
        `${figures.length === 1 ? 'that figure' : 'those figures'}. A wrong year or amount in a ` +
        `company's history is the error a listener who knows it catches first.`
    );
  }

  for (const quote of inventedQuotes(script, input.text)) {
    add('bizQuote', `"${quote}" is in quotation marks and the source never says it.`);
  }

  for (const unknown of unsourcedUnknowns(script, input.text)) {
    add('bizUnknown', `"${unknown}" says something is not known, and the source never says so.`);
  }

  const page = aboutThePage(script);
  if (page) {
    add('bizMeta', `"${page}" talks about the page instead of telling the story.`);
  }

  const closing = input.script.beats[input.script.beats.length - 1];
  if (!closing || !/\bfollow/i.test(beatText(closing))) {
    add('bizOutro', 'the last part never asks the listener to follow the show.');
  }

  if (input.format.kind === 'short' && input.durationS > MAX_SHORT_SECONDS) {
    add(
      'bizShortLength',
      `${input.measured ? 'runs' : 'would run about'} ${Math.round(input.durationS)}s. A short is under three minutes.`
    );
  }

  const jumps = chronologyJumps(input.script.beats, input.now);
  if (jumps > 2) {
    add(
      'bizChronology',
      `the story steps back in time ${jumps} times after the hook. Told in order, a life is ` +
        `easy to follow by ear; told out of order, it is not.`,
      false
    );
  }

  return { ...base, passed: !findings.some((f) => f.blocking), findings };
};

export const estimatedSeconds = (script: Script): number =>
  countWords(fullText(script)) / WORDS_PER_SECOND;
