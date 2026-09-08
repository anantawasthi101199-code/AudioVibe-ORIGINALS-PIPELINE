/**
 * Is episode twelve better than episode three?
 *
 * The gate answers "may this go out". It cannot answer "is this getting
 * better", because every check in it is a floor: an episode can clear all of
 * them and still be dull. Without something that measures improvement, the
 * format library and the style card get tuned on hunches.
 *
 * WHY PAIRWISE AND NOT A SCORE. Asking a model to rate an episode out of ten
 * produces a number that drifts with prompt wording and clusters around seven.
 * Asking which of two is better is a question with a stable answer, and
 * aggregate win rate turns out to be a sharper signal than an aggregate rubric
 * score for exactly the qualities a rubric blurs.
 *
 * THE THREE BIASES THIS CONTROLS FOR, because a judge that is not controlled is
 * not a measurement:
 *
 *   Position    - judges favour whichever came first, independently of quality.
 *                 Every pair is therefore asked BOTH WAYS and a disagreement
 *                 between the two orderings is recorded as a tie rather than
 *                 quietly resolved.
 *   Self-preference - a model scores its own family's output higher, by as much
 *                 as tens of percent. The judge is therefore the VERIFIER
 *                 client, which is already required to be a different family
 *                 from the writer.
 *   Verbosity   - judges reward length. The prompt says so explicitly, which
 *                 does not eliminate it but measurably reduces it.
 *
 * COSTS NOTHING PER RUN. This is a separate command, not a pipeline stage. It
 * is for the moment somebody wants to know whether a change to a beat sheet
 * helped, which is a question asked occasionally rather than every episode.
 */
import { extractJson, LlmClient } from '../models/client';

export interface Contender {
  label: string;
  title: string;
  text: string;
}

export type Outcome = 'a' | 'b' | 'tie';

export interface ComparisonResult {
  a: string;
  b: string;
  /** Which won after both orderings agreed, or a tie when they did not. */
  outcome: Outcome;
  /** What each ordering said, kept so position bias is visible rather than hidden. */
  forward: Outcome;
  reversed: Outcome;
  reason: string;
  costPence: number;
}

const SYSTEM = `You judge which of two audio scripts is better to LISTEN to.

You are given two scripts, A and B. Decide which one a listener would rather
hear, and say why in one sentence.

What matters:
- Does it earn attention in the first few lines, and keep it?
- Does it say specific things, or general ones?
- Does it sound like people talking, or like text being read?
- Does it land somewhere, or just stop?

What does NOT matter:
- Length. A shorter script is not worse for being shorter, and a longer one is
  not better for being longer.
- Which one appears first.
- Formatting, or the presence of speaker labels.

If they are genuinely close, say "tie". A tie is a real answer and is more
useful than a coin flip.

Reply with JSON only: {"winner": "A" | "B" | "tie", "reason": "one sentence"}`;

const parseOutcome = (raw: string, swapped: boolean): { outcome: Outcome; reason: string } => {
  let parsed: { winner?: string; reason?: string };
  try {
    parsed = extractJson(raw);
  } catch {
    return { outcome: 'tie', reason: 'judge returned unparseable output' };
  }

  const winner = String(parsed.winner ?? '').trim().toUpperCase();
  const reason = parsed.reason ?? '';

  if (winner === 'A') return { outcome: swapped ? 'b' : 'a', reason };
  if (winner === 'B') return { outcome: swapped ? 'a' : 'b', reason };
  return { outcome: 'tie', reason };
};

const ask = async (
  first: Contender,
  second: Contender,
  judge: LlmClient,
  swapped: boolean
): Promise<{ outcome: Outcome; reason: string; costPence: number }> => {
  const res = await judge.complete({
    system: SYSTEM,
    // Titles are included because a title is part of what a listener chooses
    // on, but labels are not: telling the judge which show or which run
    // produced a script invites it to reason about the pipeline rather than the
    // writing.
    prompt: [
      `SCRIPT A\nTitle: ${first.title}\n\n${first.text}`,
      `SCRIPT B\nTitle: ${second.title}\n\n${second.text}`,
    ].join('\n\n---\n\n'),
    temperature: 0,
    maxTokens: 300,
  });

  return { ...parseOutcome(res.text, swapped), costPence: res.costPence };
};

/**
 * Compare two scripts, asking both orderings.
 *
 * A disagreement between the orderings means the judge was responding to
 * position rather than to quality, and the honest report of that is a tie. Both
 * verdicts are kept so the rate of disagreement is itself visible: if most
 * pairs disagree, the judge is not measuring anything and the harness should be
 * distrusted rather than its output believed.
 */
export const compare = async (
  a: Contender,
  b: Contender,
  judge: LlmClient
): Promise<ComparisonResult> => {
  const forward = await ask(a, b, judge, false);
  const reversed = await ask(b, a, judge, true);

  const agreed = forward.outcome === reversed.outcome;

  return {
    a: a.label,
    b: b.label,
    outcome: agreed ? forward.outcome : 'tie',
    forward: forward.outcome,
    reversed: reversed.outcome,
    reason: agreed ? forward.reason : `orderings disagreed (${forward.outcome} vs ${reversed.outcome})`,
    costPence: forward.costPence + reversed.costPence,
  };
};

export const formatComparison = (r: ComparisonResult): string => {
  const winner = r.outcome === 'tie' ? 'tie' : r.outcome === 'a' ? r.a : r.b;
  const lines = [
    `${r.a}  vs  ${r.b}`,
    `  winner: ${winner}`,
    `  reason: ${r.reason}`,
  ];
  if (r.forward !== r.reversed) {
    lines.push(
      '  NOTE: the two orderings disagreed, which means the judge responded to',
      '        position rather than quality. Recorded as a tie.'
    );
  }
  lines.push(`  cost:   ${r.costPence.toFixed(2)}p`);
  return lines.join('\n');
};
