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

/**
 * THE OUTRO IS OPTIONAL AND CHOSEN (owner, 2026-10-09). Each channel has three
 * outros for shorts and three for episodes in voice-master.yaml; the run page
 * offers them in a dropdown with a tick box. The choice lives in ONE place, the
 * saved script: the outro is the fixed turn at the end of the last part, so
 * what is voiced is exactly the script as saved, outro included or not. The
 * script editors hide it and leave it alone; only setOutro changes it.
 */
interface Fixable {
  speaker: string;
  text: string;
  fixed?: boolean;
}
interface HasFixableBeats {
  beats: Array<{ turns: Fixable[] }>;
}

/** The channel's outros for this kind, in their order in voice-master.yaml. */
export const outroOptions = (persona: Persona, kind: 'long' | 'short'): string[] => {
  const list = kind === 'short' ? persona.signoffShort ?? persona.signoff : persona.signoff;
  if (!list) return [];
  return (typeof list === 'string' ? [list] : list).map((t) => t.replace(/\s+/g, ' ').trim());
};

/** The outro a script ends on now, or null when it has none. */
export const currentOutro = (script: HasFixableBeats): string | null => {
  const last = script.beats[script.beats.length - 1];
  const fixed = last?.turns.filter((t) => t.fixed) ?? [];
  return fixed.length ? fixed[fixed.length - 1]!.text.replace(/\s+/g, ' ').trim() : null;
};

/** The beats with every fixed outro turn taken out: what the editors show. */
export const withoutOutro = <T extends HasFixableBeats>(script: T): T => ({
  ...script,
  beats: script.beats.map((b) => ({ ...b, turns: b.turns.filter((t) => !t.fixed) })),
});

/** The script ending on exactly this outro, or on none (null). */
export const setOutro = <T extends HasFixableBeats>(script: T, outro: string | null): T => {
  const bare = withoutOutro(script);
  const last = bare.beats[bare.beats.length - 1];
  if (!outro || !last) return bare;
  const speaker = last.turns[last.turns.length - 1]?.speaker ?? script.beats[script.beats.length - 1]?.turns[0]?.speaker ?? 'narrator';
  const beats = bare.beats.map((b, i) =>
    i === bare.beats.length - 1 ? { ...b, turns: [...b.turns, { speaker, text: outro, fixed: true }] } : b
  );
  return { ...bare, beats };
};
