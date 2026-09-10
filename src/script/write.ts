/**
 * Filling beats with conversation.
 *
 * EVERY BEAT IS TURNS. A narrated show is a cast of one and produces beats with
 * a single turn; a two-host show produces an exchange. One code path, because a
 * special case for monologue is a special case that rots.
 *
 * WRITTEN FOR THE EAR, which is a real constraint rather than a style note. A
 * listener cannot re-read a sentence, cannot see a parenthesis, and cannot tell
 * a semicolon from a full stop.
 *
 * THE WRITER SEES ONLY WHAT IT NEEDS. The beat it is writing, the claims for
 * that beat, and what the previous beat ended on. Not the whole corpus, because
 * a writer holding fourteen documents starts summarising them instead of
 * writing the beat. Not the whole script, because that is how a ten minute
 * episode drifts into a different show halfway through.
 *
 * IT CANNOT INTRODUCE FACTS. Every factual assertion has to come from the claims
 * it is handed, which are already bound to verified quotes. That is why claims
 * are passed in and sources are not.
 *
 * AND IT GETS A SECOND CHANCE. Writing once and judging is how the first
 * version of this worked, and it wasted every rejection: the gate knew exactly
 * what was wrong and the only available response was a human. Now a beat that
 * fails its deterministic checks is handed those failures and rewritten. The
 * literature on long-form generation is consistent that draft-critique-revise
 * is where quality comes from, and it costs one extra call on the beats that
 * need it rather than on every beat.
 */
import { z } from 'zod';
import { Persona, canonAsOf, isDialogueShow } from '../canon/schema';
import { Beat, EpisodeFormat } from '../formats/schema';
import { Claim } from '../evidence/claim';
import { extractJson, LlmClient } from '../models/client';
import { NETWORK_BANNED_PHRASES, checkStyle } from './style';
import { loopBrief, openBefore } from './loops';
import { checkVoices, voiceBrief } from './voices';
import { writeHook } from './hooks';
import {
  checkDialogue,
  DIALOGUE_GUIDANCE,
  DialogueProblem,
  stripUnknownTags,
  Turn,
  turnSchema,
  withoutTags,
} from './dialogue';

export const scriptBeatSchema = z.object({
  beatId: z.string(),
  beatType: z.string(),
  turns: z.array(turnSchema).min(1),
  /** Claim ids this beat used, so the ledger can be traced to the audio. */
  claimIds: z.array(z.string()).default([]),
  /** How many revision passes this beat needed. Useful signal about a format. */
  revisions: z.number().int().nonnegative().default(0),
});

export type ScriptBeat = z.infer<typeof scriptBeatSchema>;

export const scriptSchema = z.object({
  personaId: z.string(),
  formatId: z.string(),
  title: z.string().min(1),
  description: z.string().min(1),
  beats: z.array(scriptBeatSchema).min(1),
  writerModel: z.string(),
});

export type Script = z.infer<typeof scriptSchema>;

/** Words per second of speech, for turning a target duration into a word count. */
export const WORDS_PER_SECOND = 2.6;

/**
 * How many times a beat may be rewritten before the run gives up on it.
 *
 * Two. A first rewrite fixes the ordinary case; a second catches a beat that
 * traded one violation for another. Past that the failure is usually in the
 * claims or the beat definition rather than the prose, and burning calls on it
 * spends money to arrive at the same place.
 */
export const MAX_REVISIONS = 2;

export const wordsForBeat = (beat: Beat): { min: number; max: number } => ({
  min: Math.round(beat.seconds[0] * WORDS_PER_SECOND),
  max: Math.round(beat.seconds[1] * WORDS_PER_SECOND),
});

/** Everything a beat's turns say, tags removed, for scoring and for length. */
export const beatText = (beat: { turns: Turn[] }): string =>
  beat.turns.map((t) => withoutTags(t.text)).join('\n');

export const fullText = (script: Script): string =>
  script.beats.map((b) => beatText(b)).join('\n\n');

const EAR_RULES = [
  'Write for the ear. A listener cannot re-read a sentence.',
  'Vary sentence length deliberately. Uniform sentence length is the clearest sign of generated speech, and it is measured.',
  'No parentheses, no semicolons, no bullet points, no headings.',
  'No "firstly", "secondly", "finally" scaffolding.',
  'Speak numbers as speech: "about three in ten", not "31.4 per cent". The exact figure lives in the sources list.',
  'Name specific things. Not "a regulator" but the regulator.',
  'Never open a beat by announcing what the beat is about.',
];

const buildSystem = (persona: Persona, isoDate: string): string => {
  const canon = canonAsOf(persona, isoDate);
  const say = (kind: string) =>
    canon
      .filter((c) => c.kind === kind)
      .map((c) => `- ${c.text.trim().replace(/\s+/g, ' ')}`)
      .join('\n');

  // Roles AND measurable speech habits. The habits are what stop two hosts
  // converging into one person by the fourth beat.
  const cast = voiceBrief(persona.hosts);

  const dialogue = isDialogueShow(persona);

  return `You write one beat of an audio show, as spoken turns.

SHOW: ${persona.name}
THESIS: ${persona.thesis.trim().replace(/\s+/g, ' ')}
AUDIENCE: ${persona.audience.trim().replace(/\s+/g, ' ')}
REGISTER: ${persona.register.trim().replace(/\s+/g, ' ')}

THE CAST
${cast}

WHAT THIS SHOW BELIEVES
${say('belief') || '- (none recorded)'}

WHAT THIS SHOW NEVER DOES
${say('taboo') || '- (none recorded)'}

HOW IT WRITES
${say('stylistic_rule') || '- (none recorded)'}

WRITING FOR AUDIO
${EAR_RULES.map((r) => `- ${r}`).join('\n')}
${
  dialogue
    ? `\nWRITING A CONVERSATION\n${DIALOGUE_GUIDANCE.map((r) => `- ${r}`).join('\n')}`
    : ''
}

NEVER USE THESE PHRASES
${NETWORK_BANNED_PHRASES.concat(persona.styleCard.forbiddenPhrases)
  .map((p) => `- ${p}`)
  .join('\n')}

FACTS
You may state a fact ONLY if it appears in the CLAIMS you are given. Do not add
figures, dates, names or causes from your own knowledge, however confident you
are. If a claim is not there, write around it. Claims are pre-verified against
their sources; anything you add is not.

Return JSON only:
{"turns": [{"speaker": "${persona.hosts[0]!.id}", "text": "..."}], "claimIds": ["ids used"]}`;
};

export interface BeatContext {
  persona: Persona;
  format: EpisodeFormat;
  beat: Beat;
  claims: Claim[];
  /** The tail of the previous beat, so the join does not read as a seam. */
  previousTail?: string;
  angle: string;
  isoDate: string;
  /**
   * What this beat must leave unanswered, and what it must answer.
   *
   * Handed over as an instruction rather than left to inference. "Do not answer
   * this" is followable; "be intriguing" is not.
   */
  loops?: string;
  /**
   * A pre-selected opening line for the first beat.
   *
   * Chosen by a competition the writer never sees, so it cannot talk itself out
   * of a strong opening. See writeScript and hooks.ts.
   */
  openWith?: string;
}

const buildPrompt = (ctx: BeatContext): string => {
  const { min, max } = wordsForBeat(ctx.beat);
  const claims = ctx.claims.length
    ? ctx.claims.map((c) => `[${c.id}] (${c.type}) ${c.text}`).join('\n')
    : '(none available - write this beat without stating new facts)';

  return [
    `EPISODE ANGLE: ${ctx.angle}`,
    `BEAT: ${ctx.beat.id} (${ctx.beat.type})`,
    `THIS BEAT MUST: ${ctx.beat.function}`,
    ctx.beat.constraints.length
      ? `CONSTRAINTS:\n${ctx.beat.constraints.map((c) => `- ${c}`).join('\n')}`
      : '',
    `LENGTH: ${min} to ${max} words across all turns.`,
    ctx.previousTail ? `THE PREVIOUS BEAT ENDED:\n"...${ctx.previousTail}"` : 'This is the opening beat.',
    ctx.loops ? `CURIOSITY - what this beat must and must not answer:\n${ctx.loops}` : '',
    ctx.openWith ? `OPEN WITH EXACTLY THIS LINE, then continue:\n"${ctx.openWith}"` : '',
    `CLAIMS:\n${claims}`,
  ]
    .filter(Boolean)
    .join('\n\n');
};

const parseTurns = (raw: string): { turns: Turn[]; claimIds: string[] } => {
  const parsed = z
    .object({ turns: z.array(turnSchema).min(1), claimIds: z.array(z.string()).default([]) })
    .parse(extractJson(raw));

  return {
    // Unknown tags are stripped here rather than rejected. The renderer speaks
    // anything bracketed it does not recognise, so an invented tag becomes a
    // host saying "thoughtful" out loud mid-sentence.
    turns: parsed.turns.map((t) => ({
      speaker: t.speaker.trim(),
      text: stripUnknownTags(t.text).replace(/\s+/g, ' ').trim(),
    })),
    claimIds: parsed.claimIds,
  };
};

/**
 * Everything wrong with a draft beat, deterministically.
 *
 * Style and dialogue structure only. Factuality is not checked here because the
 * writer was only given verified claims in the first place, and re-checking it
 * per draft would multiply the verifier's cost by the revision count.
 */
export const critiqueBeat = (
  turns: Turn[],
  persona: Persona,
  beat: Beat
): { blocking: string[]; advisory: string[] } => {
  const blocking: string[] = [];
  const advisory: string[] = [];

  const dialogueProblems: DialogueProblem[] = checkDialogue(
    turns,
    persona.hosts.map((h) => h.id)
  );
  for (const p of dialogueProblems) blocking.push(p.detail);

  // Whether the two hosts still sound like two people. The most common way an
  // AI two-hander falls apart, and invisible to read-through because every
  // individual line is fine.
  const { problems: voiceProblems } = checkVoices(turns, persona.hosts);
  for (const p of voiceProblems) (p.blocking ? blocking : advisory).push(p.detail);

  const text = turns.map((t) => withoutTags(t.text)).join('\n');
  const { violations } = checkStyle(text, persona.styleCard);
  for (const v of violations) (v.blocking ? blocking : advisory).push(v.detail);

  // Length is advisory: a beat twenty words over does not need a rewrite, and
  // rejecting on it teaches the writer to pad or clip mid-thought.
  const words = text.split(/\s+/).filter(Boolean).length;
  const { min, max } = wordsForBeat(beat);
  if (words < min * 0.6 || words > max * 1.5) {
    blocking.push(`runs ${words} words against a target of ${min} to ${max}`);
  } else if (words < min || words > max) {
    advisory.push(`runs ${words} words against a target of ${min} to ${max}`);
  }

  return { blocking, advisory };
};

const REVISE_INSTRUCTION = `Your previous draft of this beat failed specific
checks. Rewrite it so it does not.

Fix ONLY what is listed. Do not rewrite what was working, do not change the
facts, and do not add claims. Keep the same claim ids unless a fix genuinely
removes one.`;

/**
 * Write one beat, then revise it until it passes or the budget of attempts runs
 * out.
 *
 * The revision prompt carries the previous draft AND the specific failures.
 * Handing back only the failures produces a fresh draft that fails differently;
 * handing back both produces a repair.
 */
export const writeBeat = async (
  ctx: BeatContext,
  writer: LlmClient,
  onCost?: (pence: number) => void
): Promise<ScriptBeat> => {
  const system = buildSystem(ctx.persona, ctx.isoDate);
  const prompt = buildPrompt(ctx);

  // Calls made, not revisions made. The first is a draft, so revisions are
  // calls minus one - counting attempts directly is how this reported three
  // revisions for one draft plus two rewrites.
  let calls = 0;
  let current: { turns: Turn[]; claimIds: string[] } | null = null;
  let lastFailures: string[] = [];

  while (calls <= MAX_REVISIONS) {
    const isRevision = current !== null;
    calls++;

    const res = await writer.complete({
      system,
      prompt: isRevision
        ? [
            prompt,
            '',
            REVISE_INSTRUCTION,
            '',
            `YOUR PREVIOUS DRAFT:\n${JSON.stringify({ turns: current!.turns }, null, 2)}`,
            '',
            `WHAT FAILED:\n${lastFailures.map((f) => `- ${f}`).join('\n')}`,
          ].join('\n')
        : prompt,
      // Lower on revision: the first draft wants range, a repair wants
      // precision, and a hot rewrite tends to discard the parts that worked.
      temperature: isRevision ? 0.4 : 0.85,
      maxTokens: Math.max(1500, wordsForBeat(ctx.beat).max * 4),
    });
    onCost?.(res.costPence);

    current = parseTurns(res.text);
    const { blocking } = critiqueBeat(current.turns, ctx.persona, ctx.beat);

    if (!blocking.length) break;
    lastFailures = blocking;
  }

  return {
    beatId: ctx.beat.id,
    beatType: ctx.beat.type,
    turns: current!.turns,
    claimIds: current!.claimIds,
    revisions: calls - 1,
  };
};

/** The last few words of a beat, used to join the next one without a seam. */
export const tailOf = (text: string, words = 25): string =>
  text.split(/\s+/).slice(-words).join(' ');

const TITLE_SYSTEM = `You write the title and description for one episode.

The title is what someone sees in a feed. Make it specific and concrete: name
the thing. No colons introducing a subtitle, no "How X changed Y forever", no
question titles, no numbers-in-a-list framing.

The description is two sentences, plain, saying what the episode establishes.

Return JSON only: {"title": "...", "description": "..."}`;

export const writeTitle = async (
  persona: Persona,
  angle: string,
  beats: ScriptBeat[],
  writer: LlmClient,
  onCost?: (pence: number) => void
): Promise<{ title: string; description: string }> => {
  const res = await writer.complete({
    system: TITLE_SYSTEM,
    prompt: [
      `SHOW: ${persona.name}`,
      `ANGLE: ${angle}`,
      `OPENING: ${beats[0] ? beatText(beats[0]) : ''}`,
      `PAYOFF: ${(() => {
        const payoff = beats.find((b) => b.beatType === 'payoff');
        return payoff ? beatText(payoff) : '';
      })()}`,
    ].join('\n\n'),
    temperature: 0.8,
    maxTokens: 400,
  });
  onCost?.(res.costPence);

  return z
    .object({ title: z.string().min(1), description: z.string().min(1) })
    .parse(extractJson(res.text));
};

/**
 * Write every beat in order.
 *
 * Sequential rather than parallel, and that costs wall-clock time on purpose:
 * each beat is given the tail of the one before it, which is what stops the
 * joins reading as seams between separately-written paragraphs.
 */
export const writeScript = async (
  input: {
    persona: Persona;
    format: EpisodeFormat;
    claims: Claim[];
    angle: string;
    isoDate: string;
  },
  writer: LlmClient,
  onCost?: (pence: number) => void
): Promise<Script> => {
  const beats: ScriptBeat[] = [];
  let previousTail: string | undefined;

  // THE OPENING IS WRITTEN DIFFERENTLY FROM EVERY OTHER BEAT.
  //
  // More listeners are lost in the first eight seconds than anywhere else, and
  // an opening is short enough that writing sixteen of them and choosing costs
  // almost nothing. Every other beat gets one draft plus revisions; this one
  // gets a competition it has to win on measurable curiosity-gap properties.
  let openingHook: string | undefined;
  const firstLoop = input.format.loops[0];
  if (firstLoop && input.format.beats[0]?.type === 'cold_open') {
    try {
      const hook = await writeHook(
        {
          angle: input.angle,
          loopQuestion: firstLoop.question,
          register: input.persona.register.trim().replace(/\s+/g, ' '),
        },
        writer,
        onCost
      );
      openingHook = hook.text;
    } catch {
      // A failed competition must not cost the episode. The cold open is then
      // written normally, which is exactly what happened before this existed.
    }
  }

  for (const [index, beat] of input.format.beats.entries()) {
    const written = await writeBeat(
      {
        persona: input.persona,
        format: input.format,
        beat,
        claims: input.claims.filter((c) => c.beatId === beat.id),
        previousTail,
        angle: input.angle,
        isoDate: input.isoDate,
        loops: input.format.loops.length
          ? loopBrief(beat, input.format.loops, openBefore(input.format.beats, index))
          : undefined,
        openWith: index === 0 ? openingHook : undefined,
      },
      writer,
      onCost
    );
    beats.push(written);
    previousTail = tailOf(beatText(written));
  }

  const { title, description } = await writeTitle(input.persona, input.angle, beats, writer, onCost);

  return {
    personaId: input.persona.id,
    formatId: input.format.id,
    title,
    description,
    beats,
    writerModel: writer.model,
  };
};
