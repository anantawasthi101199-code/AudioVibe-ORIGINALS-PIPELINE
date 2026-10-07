/**
 * voice-master.yaml: how every launch channel sounds, in one validated file.
 *
 * The persona YAML says what a channel thinks and writes. This file says how it
 * SOUNDS: the host's ElevenLabs and GPT voices, a written delivery guide, the
 * tags that suit it and the ones that never do, pronunciations, and the outros
 * said word for word. A channel listed here takes all of that from here, so
 * there is one place to change it and one diff to review.
 *
 * STRICT ON PURPOSE. Unknown fields are refused rather than ignored: a misspelt
 * `stabilty` that silently did nothing would be found by a listener, weeks later.
 */
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { z } from 'zod';

const text = z.string().trim().min(1);

export const OPENAI_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse',
] as const;

const channelSchema = z
  .object({
    /** The host id in personas/<id>.yaml whose voice this is. */
    host: z.string().regex(/^[a-z0-9_]+$/),
    name: text,
    elevenlabs: z
      .object({
        /** REPLACE_* until a voice is picked; the renderer refuses a placeholder. */
        voiceId: text,
        voiceName: text,
        stability: z.number().min(0).max(1),
        similarity: z.number().min(0).max(1),
        /** The Voice Design prompt the voice came from, kept as provenance. */
        designPrompt: text,
      })
      .strict(),
    openai: z
      .object({
        voice: z.enum(OPENAI_VOICES),
        /** GPT only: turned into words (steadiness, colour) in its spoken direction. */
        stability: z.number().min(0).max(1).optional(),
        style: z.number().min(0).max(1).optional(),
        speed: z.number().min(0.5).max(2).optional(),
        direction: text.optional(),
      })
      .strict(),
    /**
     * Who this host IS: temperament, what they care about, how they react,
     * their humour. Added to the persona's register, so every writer for the
     * channel gets it; that is what keeps one personality across the channel.
     */
    personality: text,
    /** How this host speaks, in plain English. Used by the tag pass. */
    delivery: text,
    tags: z
      .object({
        use: z.array(text).min(1),
        never: z.array(text).default([]),
      })
      .strict(),
    pronounce: z
      .array(z.object({ word: text, sayAs: text, ipa: text.optional() }).strict())
      .default([]),
    outros: z
      .object({
        episode: z.array(text).default([]),
        short: z.array(text).default([]),
      })
      .strict(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const clash = c.tags.use.filter((t) => c.tags.never.includes(t));
    if (clash.length) {
      ctx.addIssue({ code: 'custom', path: ['tags'], message: `in both use and never: ${clash.join(', ')}` });
    }
  });

export const voiceMasterSchema = z
  .object({
    version: z.literal(1),
    channels: z.record(z.string().regex(/^[a-z0-9-]+$/), channelSchema),
  })
  .strict();

export type ChannelVoice = z.infer<typeof channelSchema>;
export type VoiceMaster = z.infer<typeof voiceMasterSchema>;

export class VoiceMasterError extends Error {
  constructor(file: string, problems: string[]) {
    super(`${file} is not valid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'VoiceMasterError';
  }
}

export const voiceMasterFile = (): string =>
  process.env.FOUNDRY_VOICE_MASTER ?? path.resolve(__dirname, '..', '..', 'voice-master.yaml');

export const parseVoiceMaster = (source: string, label = '<inline>'): VoiceMaster => {
  let raw: unknown;
  try {
    raw = YAML.parse(source);
  } catch (err) {
    throw new VoiceMasterError(label, [`invalid YAML: ${(err as Error).message}`]);
  }
  const result = voiceMasterSchema.safeParse(raw);
  if (!result.success) {
    throw new VoiceMasterError(
      label,
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    );
  }
  return result.data;
};

/** The whole file, or null when there is none (tests, archived fixtures). Read fresh each time: it is small. */
export const loadVoiceMaster = (file = voiceMasterFile()): VoiceMaster | null =>
  fs.existsSync(file) ? parseVoiceMaster(fs.readFileSync(file, 'utf8'), file) : null;

export const channelVoice = (id: string): ChannelVoice | null =>
  loadVoiceMaster()?.channels[id] ?? null;

/**
 * Put a channel's master entry into its raw persona, BEFORE the persona is
 * validated, so the persona file no longer has to carry a voice or sign-off.
 * The host's voice and the sign-offs are replaced outright: two sources for one
 * fact is how they drift.
 */
export const applyVoiceMaster = (raw: unknown, entry: ChannelVoice, label: string): unknown => {
  if (!raw || typeof raw !== 'object') return raw;
  const persona = raw as { hosts?: Array<Record<string, unknown>>; [k: string]: unknown };
  const host = persona.hosts?.find((h) => h.id === entry.host);
  if (!host) {
    throw new VoiceMasterError(label, [
      `host "${entry.host}" is not in this persona (has: ${(persona.hosts ?? []).map((h) => h.id).join(', ')})`,
    ]);
  }

  host.voice = {
    provider: 'elevenlabs',
    voiceId: entry.elevenlabs.voiceId,
    draftVoiceId: entry.openai.voice,
    ...(entry.openai.direction ? { direction: entry.openai.direction } : {}),
    ...(entry.openai.speed ? { speed: entry.openai.speed } : {}),
    settings: {
      stability: entry.elevenlabs.stability,
      similarity_boost: entry.elevenlabs.similarity,
      // GPT-only, read by openaiTts.instructionsFor and never sent to Eleven.
      ...(entry.openai.stability !== undefined ? { gpt_stability: entry.openai.stability } : {}),
      ...(entry.openai.style !== undefined ? { gpt_style: entry.openai.style } : {}),
    },
    pronounce: entry.pronounce,
    neverTags: entry.tags.never,
  };

  // Every writer reads `register`, so this is the one place the personality has
  // to go for all of them to write in it.
  persona.register =
    `${String(persona.register ?? '').trim()}\n\nTHE HOST'S PERSONALITY: ${entry.personality} ` +
    'It shows in how the host talks and reacts, never in an invented personal life: ' +
    'no memories, family, childhood or places they have been.';

  delete persona.signoff;
  delete persona.signoffShort;
  if (entry.outros.episode.length) persona.signoff = entry.outros.episode;
  if (entry.outros.short.length) persona.signoffShort = entry.outros.short;
  return persona;
};
