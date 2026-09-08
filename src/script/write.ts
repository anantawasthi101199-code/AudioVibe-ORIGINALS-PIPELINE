/**
 * Filling beats with prose.
 *
 * WRITTEN FOR THE EAR, which is a real constraint rather than a style note. A
 * listener cannot re-read a sentence, cannot see a parenthesis, and cannot tell
 * a semicolon from a full stop. Prose that is fine on a page can be unfollowable
 * out loud, and the rules in the system prompt below are all consequences of
 * that rather than preferences.
 *
 * THE WRITER SEES ONLY WHAT IT NEEDS. It gets the beat it is writing, the
 * claims available for that beat, and what the previous beat ended on. It does
 * not get the whole corpus, because a writer holding fourteen documents starts
 * summarising them instead of writing the beat; and it does not get the whole
 * script, because that is how a ten minute episode drifts into a different show
 * halfway through.
 *
 * IT CANNOT INTRODUCE FACTS. Every factual assertion has to come from the claims
 * it is handed, which are already bound to verified quotes. That is why the
 * claims are passed in rather than the sources.
 */
import { z } from 'zod';
import { Persona, canonAsOf } from '../canon/schema';
import { Beat, EpisodeFormat } from '../formats/schema';
import { Claim } from '../evidence/claim';
import { extractJson, LlmClient } from '../models/client';
import { NETWORK_BANNED_PHRASES } from './style';

export const scriptBeatSchema = z.object({
  beatId: z.string(),
  beatType: z.string(),
  text: z.string().min(1),
  /** Claim ids this beat used, so the ledger can be traced to the audio. */
  claimIds: z.array(z.string()).default([]),
});

export type ScriptBeat = z.infer<typeof scriptBeatSchema>;

export const scriptSchema = z.object({
  personaId: z.string(),
  formatId: z.string(),
  title: z.string().min(1),
  /** What the app shows under the title. */
  description: z.string().min(1),
  beats: z.array(scriptBeatSchema).min(1),
  writerModel: z.string(),
});

export type Script = z.infer<typeof scriptSchema>;

/** Words per second of speech, for turning a target duration into a word count. */
export const WORDS_PER_SECOND = 2.6;

export const wordsForBeat = (beat: Beat): { min: number; max: number } => ({
  min: Math.round(beat.seconds[0] * WORDS_PER_SECOND),
  max: Math.round(beat.seconds[1] * WORDS_PER_SECOND),
});

const earRules = [
  'Write for the ear. A listener cannot re-read a sentence.',
  'Vary sentence length deliberately. Uniform sentence length is the clearest sign of generated prose, and it is checked.',
  'No parentheses, no semicolons, no bullet points, no headings.',
  'No "firstly", "secondly", "finally" scaffolding.',
  'Speak numbers as speech: "about three in ten", not "31.4 per cent". The exact figure lives in the sources list.',
  'Name specific things. Not "a regulator" but the regulator.',
  'Never open a beat by announcing what the beat is about.',
  'Do not use the word "episode" unless the beat explicitly calls for it.',
];

const buildSystem = (persona: Persona, isoDate: string): string => {
  const canon = canonAsOf(persona, isoDate);
  const say = (kind: string) =>
    canon
      .filter((c) => c.kind === kind)
      .map((c) => `- ${c.text.trim()}`)
      .join('\n');

  return `You write one beat of an audio show. You are given the beat, the facts
available for it, and what came before. Write only that beat.

SHOW: ${persona.name}
THESIS: ${persona.thesis}
AUDIENCE: ${persona.audience}
REGISTER: ${persona.register}

WHAT THIS SHOW BELIEVES
${say('belief') || '- (none recorded)'}

WHAT THIS SHOW NEVER DOES
${say('taboo') || '- (none recorded)'}

HOW IT WRITES
${say('stylistic_rule') || '- (none recorded)'}

WRITING FOR AUDIO
${earRules.map((r) => `- ${r}`).join('\n')}

NEVER USE THESE PHRASES
${NETWORK_BANNED_PHRASES.concat(persona.styleCard.forbiddenPhrases)
  .map((p) => `- ${p}`)
  .join('\n')}

FACTS
You may state a fact ONLY if it appears in the CLAIMS you are given. Do not add
figures, dates, names or causes from your own knowledge, however confident you
are. If a claim is not there, write around it. Claims are pre-verified against
their sources; anything you add is not.

Return JSON only: {"text": "the beat, as spoken prose", "claimIds": ["ids used"]}`;
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
}

export const writeBeat = async (
  ctx: BeatContext,
  writer: LlmClient,
  onCost?: (pence: number) => void
): Promise<ScriptBeat> => {
  const { min, max } = wordsForBeat(ctx.beat);

  const claims = ctx.claims.length
    ? ctx.claims.map((c) => `[${c.id}] (${c.type}) ${c.text}`).join('\n')
    : '(none available - write this beat without stating new facts)';

  const res = await writer.complete({
    system: buildSystem(ctx.persona, ctx.isoDate),
    prompt: [
      `EPISODE ANGLE: ${ctx.angle}`,
      `BEAT: ${ctx.beat.id} (${ctx.beat.type})`,
      `THIS BEAT MUST: ${ctx.beat.function}`,
      ctx.beat.constraints.length ? `CONSTRAINTS:\n${ctx.beat.constraints.map((c) => `- ${c}`).join('\n')}` : '',
      `LENGTH: ${min} to ${max} words.`,
      ctx.previousTail ? `THE PREVIOUS BEAT ENDED:\n"...${ctx.previousTail}"` : 'This is the opening beat.',
      `CLAIMS:\n${claims}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    temperature: 0.85,
    maxTokens: Math.max(1200, max * 3),
  });
  onCost?.(res.costPence);

  const parsed = z
    .object({ text: z.string().min(1), claimIds: z.array(z.string()).default([]) })
    .parse(extractJson(res.text));

  return {
    beatId: ctx.beat.id,
    beatType: ctx.beat.type,
    text: parsed.text.trim(),
    claimIds: parsed.claimIds,
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
      `OPENING: ${beats[0]?.text ?? ''}`,
      `PAYOFF: ${beats.find((b) => b.beatType === 'payoff')?.text ?? ''}`,
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

  for (const beat of input.format.beats) {
    const written = await writeBeat(
      {
        persona: input.persona,
        format: input.format,
        beat,
        claims: input.claims.filter((c) => c.beatId === beat.id),
        previousTail,
        angle: input.angle,
        isoDate: input.isoDate,
      },
      writer,
      onCost
    );
    beats.push(written);
    previousTail = tailOf(written.text);
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

export const fullText = (script: Script): string => script.beats.map((b) => b.text).join('\n\n');
