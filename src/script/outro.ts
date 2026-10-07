/**
 * The channel's outro, said word for word.
 *
 * WHY THE WRITER NO LONGER WRITES IT. It used to be handed the sign-off and told
 * to land on it "in your own words", so every episode ended slightly
 * differently and none of them ended the way the channel had chosen. The owner
 * asked for fixed outros (2026-10-07): a few exact texts per channel, kept in
 * voice-master.yaml, one picked per episode.
 *
 * So the writer is told to stop on its last real sentence, and the outro is
 * appended here as its own turn, in the host's voice. Deterministic, free, and
 * visible in the script editor like any other line.
 */
import { Persona } from '../canon/schema';
import { OUTRO_RULE, signoffFor } from './storyScript';

export { OUTRO_RULE };

interface HasBeats {
  beats: Array<{ turns: Array<{ speaker: string; text: string }> }>;
}

/**
 * The script with its outro as the final turn of the last beat.
 *
 * Idempotent: a script that already ends on this outro is returned unchanged,
 * so a resumed run or a re-check never says goodbye twice. The seed is the
 * run's topic, so the same episode always gets the same outro.
 */
export const withOutro = <T extends HasBeats>(
  script: T,
  persona: Persona,
  kind: 'long' | 'short',
  seed: string
): T => {
  const outro = signoffFor(persona, kind, seed)?.replace(/\s+/g, ' ').trim();
  const last = script.beats[script.beats.length - 1];
  if (!outro || !last?.turns.length) return script;
  // Already there, whether appended before or written out verbatim by the writer.
  const flat = (t: string) => t.replace(/\s+/g, ' ').trim();
  if (last.turns.some((t) => flat(t.text).endsWith(outro))) return script;

  const speaker = last.turns[last.turns.length - 1]!.speaker;
  const turn = { speaker, text: outro, fixed: true };
  const beats = script.beats.map((b, i) =>
    i === script.beats.length - 1 ? { ...b, turns: [...b.turns, turn] } : b
  );
  return { ...script, beats };
};
