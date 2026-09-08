/**
 * Conversation, and the audio tags that make it sound like one.
 *
 * WHY THIS EXISTS SEPARATELY FROM write.ts. Writing a monologue and writing an
 * exchange are different jobs, and the second one is where almost all of the
 * "does this sound human" gain lives. Polished prose read by a synthetic voice
 * is what TTS has always sounded like; two people working something out is not.
 *
 * WHAT ACTUALLY MAKES IT SOUND HUMAN, and it is not the tags. It is that the
 * two hosts want different things. One has read the documents; the other has
 * not and presses. That gives the conversation a reason to exist, which is the
 * thing missing from every AI podcast where two voices agree enthusiastically
 * for ten minutes. The disfluencies are the surface of that, not the cause, and
 * sprinkling them onto agreement does not work.
 */
import { z } from 'zod';

/**
 * Audio tags the renderer understands.
 *
 * A closed set on purpose. The provider accepts arbitrary bracketed text and
 * silently speaks anything it does not recognise, so an invented tag becomes a
 * host saying the word "thoughtful" out loud in the middle of a sentence. Every
 * tag a writer may use is listed here and anything else is stripped.
 */
export const AUDIO_TAGS = [
  'laughs',
  'sighs',
  'exhales',
  'hesitates',
  'pauses',
  'interrupting',
  'overlapping',
  'quietly',
  'slowly',
  'emphatically',
] as const;

export type AudioTag = (typeof AUDIO_TAGS)[number];

const TAG_PATTERN = /\[([a-z ]+)\]/gi;

/** Remove tags the renderer does not know, leaving the words untouched. */
export const stripUnknownTags = (text: string): string =>
  text.replace(TAG_PATTERN, (whole, inner: string) =>
    (AUDIO_TAGS as readonly string[]).includes(inner.trim().toLowerCase()) ? whole : ''
  );

/** Text with every tag removed, which is what style scoring must measure. */
export const withoutTags = (text: string): string =>
  text
    .replace(TAG_PATTERN, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();

export const turnSchema = z.object({
  /** Host id from the persona's cast. */
  speaker: z.string().min(1),
  text: z.string().min(1),
});

export type Turn = z.infer<typeof turnSchema>;

/**
 * How much of a beat one host may hold before it stops being a conversation.
 *
 * A "dialogue" where one host delivers 400 words and the other says "right" is
 * a monologue with interruptions, and it is what a writer produces by default
 * because it is easier. Checked rather than requested.
 */
export const MAX_TURN_SHARE = 0.72;

/** Shortest gap between speaker changes, in turns, before it reads as ping-pong. */
export const MIN_TURNS_PER_BEAT = 2;

export interface DialogueProblem {
  rule: string;
  detail: string;
}

/**
 * Structural checks on an exchange. Deterministic, and run before any model is
 * asked whether the conversation is any good.
 */
export const checkDialogue = (turns: Turn[], hostIds: string[]): DialogueProblem[] => {
  const problems: DialogueProblem[] = [];

  const unknown = turns.filter((t) => !hostIds.includes(t.speaker));
  if (unknown.length) {
    problems.push({
      rule: 'unknownSpeaker',
      detail: `speaks as ${[...new Set(unknown.map((t) => t.speaker))].join(', ')}, who are not in the cast`,
    });
  }

  // Only meaningful for a show with more than one host.
  if (hostIds.length < 2) return problems;

  if (turns.length < MIN_TURNS_PER_BEAT) {
    problems.push({
      rule: 'tooFewTurns',
      detail: `has ${turns.length} turn(s); a conversation beat needs at least ${MIN_TURNS_PER_BEAT}`,
    });
  }

  const words = (t: Turn) => withoutTags(t.text).split(/\s+/).filter(Boolean).length;
  const total = turns.reduce((n, t) => n + words(t), 0);

  if (total > 0) {
    for (const host of hostIds) {
      const share = turns.filter((t) => t.speaker === host).reduce((n, t) => n + words(t), 0) / total;
      if (share > MAX_TURN_SHARE) {
        problems.push({
          rule: 'monologueInDisguise',
          detail:
            `${host} speaks ${(share * 100).toFixed(0)}% of the words. Above ` +
            `${(MAX_TURN_SHARE * 100).toFixed(0)}% this is a monologue with interruptions.`,
        });
      }
    }
  }

  // A beat where only one host speaks is not an exchange, whatever its length.
  if (new Set(turns.map((t) => t.speaker)).size < 2) {
    problems.push({
      rule: 'oneSidedBeat',
      detail: 'only one host speaks in this beat',
    });
  }

  return problems;
};

/**
 * Guidance handed to the writer for conversation.
 *
 * Phrased as things to DO rather than things to avoid, because "do not sound
 * robotic" produces a model's idea of not-robotic, which is exclamation marks.
 */
export const DIALOGUE_GUIDANCE = [
  'Two people working something out, not two people presenting it. They can disagree, and the disagreement should be about something real in the evidence.',
  'Let one of them be wrong occasionally, and corrected. That is what makes the correction worth hearing.',
  'Interrupt where a real person would: to object, to finish a thought, to ask what a number actually means. Not at random.',
  'Someone may trail off, restate a thing badly and then say it better, or admit they do not follow. Real conversation contains repair.',
  'Short turns are allowed. "Wait, how much?" is a turn.',
  'Do not have them thank each other, recap what they just said, or announce what they are about to do.',
  'No host may narrate a paragraph at another. If one of them has a lot to say, the other should be pushing on it.',
  `Audio tags you may use, sparingly and only where earned: ${AUDIO_TAGS.map((t) => `[${t}]`).join(' ')}. Anything else is spoken aloud by the renderer and will sound absurd.`,
];
