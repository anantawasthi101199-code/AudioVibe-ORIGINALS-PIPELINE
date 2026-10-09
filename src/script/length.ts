/**
 * How long a script will run, and whether that is too long (owner, 2026-10-09).
 *
 *   episode: a loud warning past 15 minutes, voicing BLOCKED past 20
 *   short:   a loud warning past 3 minutes,  voicing BLOCKED past 5
 *
 * Not a cap on writing: a script may be saved at any length, so it can be cut
 * down. What is blocked is spending on the voice of one that is far too long.
 * Estimated from the words actually spoken (delivery tags left out, the outro
 * in) at the pipeline's own speaking rate, WORDS_PER_SECOND.
 */
import { countWords } from './style';
import { WORDS_PER_SECOND } from './write';

export const LENGTH_LIMITS = {
  short: { warnSeconds: 3 * 60, blockSeconds: 5 * 60 },
  episode: { warnSeconds: 15 * 60, blockSeconds: 20 * 60 },
} as const;

export interface LengthCheck {
  kind: 'short' | 'episode';
  words: number;
  seconds: number;
  warnSeconds: number;
  blockSeconds: number;
  /** The most words before the warning, and before the block. */
  warnWords: number;
  blockWords: number;
  level: 'ok' | 'warn' | 'block';
}

const spokenWords = (script: { beats: Array<{ turns: Array<{ text: string }> }> }): number =>
  countWords(
    script.beats
      .flatMap((b) => b.turns.map((t) => t.text))
      .join(' ')
      .replace(/\[[^\]]{1,48}\]/g, ' ')
  );

export const lengthCheck = (
  script: { beats: Array<{ turns: Array<{ text: string }> }> },
  kind: 'short' | 'episode'
): LengthCheck => {
  const limits = LENGTH_LIMITS[kind];
  const words = spokenWords(script);
  const seconds = words / WORDS_PER_SECOND;
  return {
    kind,
    words,
    seconds,
    ...limits,
    warnWords: Math.floor(limits.warnSeconds * WORDS_PER_SECOND),
    blockWords: Math.floor(limits.blockSeconds * WORDS_PER_SECOND),
    level: seconds > limits.blockSeconds ? 'block' : seconds > limits.warnSeconds ? 'warn' : 'ok',
  };
};

const mins = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** Why voicing is refused, in words a person can act on. */
export const lengthRefusal = (c: LengthCheck): string =>
  `this script is about ${mins(c.seconds)} long (${c.words} words). A ${c.kind} cannot be voiced past ` +
  `${c.blockSeconds / 60} minutes (${c.blockWords} words); cut it down and save, then voice it.`;
