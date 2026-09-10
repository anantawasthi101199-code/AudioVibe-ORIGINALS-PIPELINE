/**
 * Open loops: the machinery that makes someone stay.
 *
 * WHAT AN OPEN LOOP IS. A question the listener now wants answered and cannot
 * answer yet. Loewenstein's information-gap account of curiosity is precise
 * about the shape: curiosity is the discomfort of a gap between what you know
 * and what you want to know, so it needs a SPECIFIC missing piece. "Something
 * strange happened" opens nothing. "Twenty-seven went in, twenty-six came out"
 * opens a loop you can feel.
 *
 * THE FINDING THAT DRIVES THE WHOLE DESIGN: an open loop at the START holds
 * attention across the entire runtime, and a loop CLOSED at the start lets the
 * listener leave immediately, satisfied. Almost every weak opening is a closed
 * loop - it summarises, it explains what the episode is about, it answers its
 * own question. That is why the rules below are enforced on the beat sheet
 * rather than requested in a prompt: an opening that closes its own loop is not
 * a style problem, it is the episode failing before it starts.
 *
 * WHY LOOPS ARE DECLARED IN THE FORMAT AND NOT INFERRED FROM THE PROSE. You
 * cannot reliably detect "is this question still open" by reading text. But you
 * can require the beat sheet to say which loops each beat opens and closes,
 * check the arithmetic of that at load, and hand the writer an explicit
 * instruction: this beat opens THIS question and closes NOTHING. Structure is
 * checkable; intent is not.
 */
import { z } from 'zod';

export const loopSchema = z.object({
  /** Referenced by beats that open or close it. */
  id: z.string().regex(/^[a-z0-9_]+$/, 'lowercase, digits and underscores only'),
  /**
   * The question, written as the LISTENER would ask it.
   *
   * Phrased from their side on purpose. "Explain the maintenance log" is a
   * task; "who was signing a log for a week that had not happened yet?" is a
   * gap. Only the second one pulls.
   */
  question: z.string().min(1),
});

export type Loop = z.infer<typeof loopSchema>;

export interface LoopProblem {
  rule: string;
  detail: string;
}

export interface BeatLoops {
  id: string;
  type: string;
  opens: string[];
  closes: string[];
}

/**
 * How far into an episode every loop may be closed.
 *
 * Once nothing is unresolved, there is no reason left to keep listening. Closing
 * the last loop with a third of the runtime still to go is the most common way
 * a well-made episode loses its ending: the payoff lands, and then the audience
 * sits through a reckoning and an outro they have no reason to hear.
 */
export const EARLIEST_FULL_RESOLUTION = 0.75;

/**
 * Validate the loop structure of a beat sheet.
 *
 * Runs at load, so a badly-shaped format fails before it costs an episode.
 */
export const checkLoopStructure = (
  loops: Loop[],
  beats: BeatLoops[],
  opts: { allowDangling?: boolean } = {}
): LoopProblem[] => {
  const problems: LoopProblem[] = [];
  const known = new Set(loops.map((l) => l.id));
  const referenced = beats.some((b) => b.opens.length || b.closes.length);

  // A format that declares no loops and references none has opted out. That is
  // a legitimate choice for a trivial format, and a deliberate one - a test
  // over the shipped formats asserts that every REAL show declares them, so
  // opting out is possible in a fixture and not possible in production.
  if (!loops.length && !referenced) return problems;

  for (const beat of beats) {
    for (const id of [...beat.opens, ...beat.closes]) {
      if (!known.has(id)) {
        problems.push({
          rule: 'unknownLoop',
          detail: `beat "${beat.id}" references loop "${id}", which is not declared`,
        });
      }
    }
  }

  // THE RULE THAT MATTERS MOST. A first beat that closes a loop has told the
  // listener they can go.
  const first = beats[0];
  if (first) {
    if (!first.opens.length) {
      problems.push({
        rule: 'openingOpensNothing',
        detail:
          `the first beat ("${first.id}") opens no loop. An opening that leaves nothing ` +
          `unanswered gives the listener permission to leave.`,
      });
    }
    if (first.closes.length) {
      problems.push({
        rule: 'openingClosesALoop',
        detail:
          `the first beat ("${first.id}") closes ${first.closes.join(', ')}. A loop closed ` +
          `at the start lets the listener leave satisfied; an open one holds them for the ` +
          `whole runtime.`,
      });
    }
  }

  // Loops must be opened before they are closed, and closed at most once.
  const openedAt = new Map<string, number>();
  const closedAt = new Map<string, number>();

  beats.forEach((beat, i) => {
    for (const id of beat.opens) {
      if (openedAt.has(id)) {
        problems.push({ rule: 'reopenedLoop', detail: `loop "${id}" is opened twice` });
      } else {
        openedAt.set(id, i);
      }
    }
    for (const id of beat.closes) {
      const opened = openedAt.get(id);
      if (opened === undefined) {
        problems.push({
          rule: 'closedBeforeOpened',
          detail: `beat "${beat.id}" closes loop "${id}" before anything opened it`,
        });
      } else if (opened === i) {
        // Opening and answering inside one beat is a rhetorical question, not a
        // loop. It reads as the show talking to itself.
        problems.push({
          rule: 'loopClosedWhereOpened',
          detail: `beat "${beat.id}" opens and closes loop "${id}" in the same beat`,
        });
      }
      if (closedAt.has(id)) {
        problems.push({ rule: 'closedTwice', detail: `loop "${id}" is closed twice` });
      } else {
        closedAt.set(id, i);
      }
    }
  });

  for (const loop of loops) {
    if (!openedAt.has(loop.id)) {
      problems.push({ rule: 'unusedLoop', detail: `loop "${loop.id}" is never opened` });
    } else if (!closedAt.has(loop.id) && !opts.allowDangling) {
      problems.push({
        rule: 'danglingLoop',
        detail:
          `loop "${loop.id}" is never closed. Set the format's \`serialised\` flag if that ` +
          `is deliberate - an accidental dangling loop reads as the episode forgetting.`,
      });
    }
  }

  // Nothing left unresolved, too early.
  const debt = loopDebt(beats);
  const firstZero = debt.findIndex((n, i) => n === 0 && i > 0);
  if (firstZero >= 0 && firstZero < Math.floor(beats.length * EARLIEST_FULL_RESOLUTION)) {
    problems.push({
      rule: 'resolvedTooEarly',
      detail:
        `every loop is closed by beat ${firstZero + 1} of ${beats.length}. From there on the ` +
        `listener has no reason to keep going.`,
    });
  }

  return problems;
};

/**
 * How many loops are open after each beat.
 *
 * The shape of this array is the shape of the episode's pull. It should rise
 * early, stay above zero through the middle, and only reach zero at the end -
 * one before the end, for a serialised show.
 */
export const loopDebt = (beats: BeatLoops[]): number[] => {
  let open = 0;
  return beats.map((beat) => {
    open += beat.opens.length;
    open -= beat.closes.length;
    return Math.max(0, open);
  });
};

/**
 * What to tell the writer about loops for one beat.
 *
 * Handed as an instruction rather than left to inference. "Do not answer this"
 * is a thing a writer can follow; "be intriguing" is not.
 */
export const loopBrief = (
  beat: BeatLoops,
  loops: Loop[],
  stillOpen: string[]
): string => {
  const byId = new Map(loops.map((l) => [l.id, l]));
  const lines: string[] = [];

  for (const id of beat.opens) {
    const loop = byId.get(id);
    if (loop) {
      lines.push(
        `OPEN this question, and DO NOT ANSWER IT: "${loop.question}" - make the listener ` +
          `feel the specific thing they do not yet know.`
      );
    }
  }

  for (const id of beat.closes) {
    const loop = byId.get(id);
    if (loop) lines.push(`ANSWER this question here: "${loop.question}"`);
  }

  const carried = stillOpen.filter((id) => !beat.closes.includes(id) && !beat.opens.includes(id));
  if (carried.length) {
    const questions = carried.map((id) => byId.get(id)?.question).filter(Boolean);
    if (questions.length) {
      lines.push(
        `STILL UNANSWERED, and must stay that way: ${questions.map((q) => `"${q}"`).join('; ')}`
      );
    }
  }

  if (!lines.length) lines.push('No loops open or close in this beat.');
  return lines.join('\n');
};

/** Loops open going into each beat, for `loopBrief`. */
export const openBefore = (beats: BeatLoops[], index: number): string[] => {
  const open = new Set<string>();
  for (let i = 0; i < index; i++) {
    for (const id of beats[i]!.opens) open.add(id);
    for (const id of beats[i]!.closes) open.delete(id);
  }
  return [...open];
};
