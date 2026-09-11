/**
 * The first eight seconds.
 *
 * More listeners are lost here than anywhere else, and writing one opening and
 * accepting it wastes the cheapest improvement available: openings are short,
 * so generating twenty and choosing costs almost nothing.
 *
 * WHAT MAKES A HOOK WORK, from the information-gap account of curiosity. A gap
 * has to be SPECIFIC to be felt. "Something strange happened in 1943" names no
 * missing piece and produces no pull. "Twenty-seven men went into that forest
 * and twenty-six came out" names exactly one, and you cannot not want it.
 *
 * So the scoring below rewards concreteness - a number, a name, a place, a
 * date - and punishes the things that quietly close the gap: explaining, being
 * abstract, announcing what the episode is about, or answering in the same
 * breath as asking.
 *
 * SCORED DETERMINISTICALLY FIRST, then judged. Deterministic scoring is free
 * and catches most of it; asking a model to rank twenty openings costs one
 * call. Asking a model to rank on its own would be both slower and worse, since
 * "which of these is most intriguing" is exactly the judgement models are least
 * consistent at.
 */
import { completeJson, extractJson, LlmClient } from '../models/client';

export interface HookScore {
  text: string;
  score: number;
  /** Human-readable, so a rejected hook explains itself in the run artifact. */
  notes: string[];
}

/**
 * Openings that announce rather than hook.
 *
 * Every one of these tells the listener they are about to be told something,
 * which is an invitation to decide whether they want to be.
 */
const ANNOUNCING = [
  /^(so|now|ok|okay|right|well)[,\s]/i,
  /\b(today|in this (episode|one)|we'?re going to|we'?ll be|let'?s talk about|i want to talk about)\b/i,
  /\b(have you ever|did you know|imagine (if|a|that))\b/i,
  /\b(this is the story of|the story of how)\b/i,
];

/**
 * Words that resolve rather than open.
 *
 * A hook containing "because" has usually already answered itself.
 */
const RESOLVING = /\b(because|which is why|the reason (is|was)|it turns out|the answer)\b/i;

/** Concreteness signals: a number, a year, a proper noun, a place. */
const HAS_DIGIT = /\d/;
const HAS_YEAR = /\b(1[6-9]\d{2}|20[0-2]\d)\b/;
const HAS_PROPER_NOUN = /(?:^|[.!?]\s+|\s)([A-Z][a-z]{2,})/;

/**
 * The window a hook has to land in.
 *
 * Long enough to plant something specific, short enough that the gap arrives
 * before attention does. Around 8 to 14 seconds of speech.
 */
export const HOOK_MIN_WORDS = 12;
export const HOOK_MAX_WORDS = 42;

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Score one opening. Higher is better; anything at or below zero is unusable.
 *
 * The weights are deliberately blunt. This is a filter that removes obviously
 * weak openings before a model looks at the rest - precision here would be
 * false precision.
 */
export const scoreHook = (text: string): HookScore => {
  const notes: string[] = [];
  let score = 0;
  const n = words(text);

  // --- Fatal: it announces itself ---
  for (const pattern of ANNOUNCING) {
    if (pattern.test(text.trim())) {
      notes.push('announces the episode instead of opening a gap');
      score -= 10;
      break;
    }
  }

  // --- Fatal: it answers itself ---
  if (RESOLVING.test(text)) {
    notes.push('contains its own explanation, which closes the gap it opened');
    score -= 8;
  }

  // --- Concreteness: the gap has to be about something specific ---
  if (HAS_DIGIT.test(text)) {
    score += 3;
    notes.push('carries a number');
  }
  if (HAS_YEAR.test(text)) {
    score += 1;
  }
  if (HAS_PROPER_NOUN.test(text.replace(/^\W*\w+/, ''))) {
    score += 2;
    notes.push('names something specific');
  }

  // --- Length ---
  if (n < HOOK_MIN_WORDS) {
    score -= 4;
    notes.push(`only ${n} words, too short to plant anything specific`);
  } else if (n > HOOK_MAX_WORDS) {
    score -= 3;
    notes.push(`${n} words, long enough that the gap arrives late`);
  } else {
    score += 2;
  }

  // --- A question mark is usually the lazy version of a gap ---
  if (text.trim().endsWith('?')) {
    score -= 2;
    notes.push('asks the question rather than making the listener ask it');
  }

  // --- Abstraction penalty ---
  const abstractions = (text.match(
    /\b(things?|stuff|something|somehow|incredible|amazing|shocking|unbelievable|fascinating|crazy)\b/gi
  ) ?? []).length;
  if (abstractions) {
    score -= abstractions * 2;
    notes.push(`${abstractions} vague word(s) where a specific one belongs`);
  }

  return { text: text.trim(), score, notes };
};

/** Rank candidates best-first, dropping anything scoring at or below zero. */
export const rankHooks = (candidates: string[]): HookScore[] =>
  candidates
    .map(scoreHook)
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score);

const GENERATE_SYSTEM = `You write opening lines for an audio show. Not the
episode - just the first thing a listener hears.

An opening's only job is to make someone need to know what happens next. It
does that by naming ONE specific thing they do not know yet.

Good openings:
- Lead with a concrete detail: a number, a name, a date, an object.
- State a fact that does not add up, and stop.
- Trust the listener. Do not explain.

Never:
- Announce the episode ("today we're looking at", "this is the story of").
- Start with "So," or "Now," or "Have you ever".
- Ask a question. Make the listener ask it.
- Use "incredible", "shocking", "amazing", "fascinating".
- Answer, or half-answer, in the same breath.

Return JSON only: {"hooks": ["...", "...", ...]}`;

const CHOOSE_SYSTEM = `You pick the best opening line for an audio show.

You are given several candidates. Choose the one that most makes a listener
need to hear what comes next.

Prefer the one that names the most specific unexplained thing. Distrust any
that sound clever without being concrete. Length is not quality.

Return JSON only: {"index": <0-based>, "reason": "one sentence"}`;

/**
 * Write many openings, filter deterministically, then let a model choose.
 *
 * The two-stage shape matters. The deterministic pass removes the announcing
 * and self-answering openings for free, so the model only ever chooses between
 * candidates that are already structurally sound - which is a judgement it is
 * much better at than "is this intriguing" in the abstract.
 */
export const writeHook = async (
  input: { angle: string; loopQuestion: string; register: string; count?: number },
  writer: LlmClient,
  onCost?: (pence: number) => void
): Promise<{ text: string; considered: HookScore[]; reason: string }> => {
  const count = input.count ?? 16;

  // Sixteen openings in one reply is the call most likely to run long, so it is
  // also the one most likely to be cut off mid-list. completeJson gives it more
  // room once rather than letting the competition fail and fall back to an
  // ordinary cold open, which is a quality loss nothing would report.
  const parsed = await completeJson<{ hooks?: string[] }>(
    writer,
    {
      system: GENERATE_SYSTEM,
      prompt: [
        `EPISODE: ${input.angle}`,
        `THE QUESTION THE OPENING MUST PLANT (without answering it): ${input.loopQuestion}`,
        `THE SHOW SOUNDS LIKE: ${input.register}`,
        `Write ${count} different openings. Vary the angle of attack, not just the wording.`,
      ].join('\n\n'),
      temperature: 1,
      maxTokens: 3000,
    },
    onCost
  );
  const ranked = rankHooks(parsed.hooks ?? []);

  if (!ranked.length) {
    throw new Error(
      `every one of ${parsed.hooks?.length ?? 0} candidate openings failed scoring. ` +
        `That usually means the loop question is too vague to plant.`
    );
  }

  // One candidate needs no judging.
  const shortlist = ranked.slice(0, 5);
  if (shortlist.length === 1) {
    return { text: shortlist[0]!.text, considered: ranked, reason: 'only candidate that scored' };
  }

  const chosen = await writer.complete({
    system: CHOOSE_SYSTEM,
    prompt: shortlist.map((h, i) => `${i}. ${h.text}`).join('\n'),
    temperature: 0,
    maxTokens: 200,
  });
  onCost?.(chosen.costPence);

  let index = 0;
  let reason = '';
  try {
    const pick = extractJson<{ index?: number; reason?: string }>(chosen.text);
    if (typeof pick.index === 'number' && pick.index >= 0 && pick.index < shortlist.length) {
      index = pick.index;
    }
    reason = pick.reason ?? '';
  } catch {
    // Fall back to the top deterministic score, which is a fine answer.
    reason = 'chooser returned unparseable output; used the highest-scoring candidate';
  }

  return { text: shortlist[index]!.text, considered: ranked, reason };
};
