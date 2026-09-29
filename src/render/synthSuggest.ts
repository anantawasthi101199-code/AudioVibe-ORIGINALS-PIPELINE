/**
 * Turning a sentence into synthesiser settings.
 *
 * WHAT THIS IS AND IS NOT. It is a shortcut to a starting point, not a
 * generator. Nothing it returns is needed to make a sound: every control has a
 * default, the form works with the box empty, and a beat made entirely by hand
 * renders identically. That ordering is deliberate - a studio where the only
 * way to get a bed is to ask a model is a studio that cannot make a bed when
 * the model is down, and it is also one where nobody learns what the knobs do.
 *
 * THE CHEAP MODEL, AND IT IS THE RIGHT CHOICE RATHER THAN A COMPROMISE. This is
 * a mapping task: read a mood, fill in twenty-four numbers from a list that
 * tells you what each one means and what range it takes. There is no judgement
 * in it that a larger model would make better, and the whole call lands around
 * a tenth of a penny.
 *
 * THE CONTROLS ARE THE PROMPT. `CONTROLS` is serialised into the request rather
 * than described in prose, so a knob added to synth.ts is a knob the model
 * knows about immediately, with its real range and its real explanation. A
 * hand-written list here would be a second definition, and it would be wrong
 * within a week without anything failing.
 *
 * AND THE SCHEMA IS THE BACKSTOP. Whatever comes back is parsed by
 * `synthSchema`, so an out-of-range number is a caught error rather than an
 * ffmpeg expression nobody can read. Free, and it means the model's answer can
 * never reach the renderer in a shape the renderer does not expect.
 */
import { completeJson, LlmClient } from '../models/client';
import {
  CONTROLS,
  DEFAULTS,
  MODE_NOTES,
  PROGRESSIONS,
  SynthSettings,
  VOICES,
  synthSchema,
} from './synth';

/**
 * What the model is shown: every control, its range, and what it does.
 *
 * Built from CONTROLS rather than written out, for the reason in the header.
 */
export const controlsForPrompt = (): string =>
  JSON.stringify(
    CONTROLS.map((c) => ({
      id: c.id,
      kind: c.kind,
      ...(c.options ? { options: c.options.map((o) => o.value) } : {}),
      ...(c.min !== undefined ? { min: c.min, max: c.max } : {}),
      what: c.help,
    })),
    null,
    1
  );

export const SUGGEST_SYSTEM = `You set up a synthesiser that makes background music for spoken audio.

You are given a description and you return the settings. Nothing else.

WHAT THIS MUSIC IS FOR. It plays underneath somebody talking, for ten to twenty
minutes, quieter than the voice. A listener should not be able to describe it
afterwards. That is the job, and it rules out most of what makes music
interesting on its own: no melody anybody could hum, no rhythm that pulls
attention, nothing that arrives or resolves.

THINGS THAT GO WRONG, IN ORDER OF HOW OFTEN.

1. TOO MUCH. Six instruments at high density is mud, and mud under speech is
   worse than silence. Two voices is usually right and three is a lot.
2. TOO BRIGHT. Anything above about 3000 Hz starts competing with consonants,
   which is exactly the part of speech a listener needs to understand words.
   Dark is nearly always the safer mistake.
3. TOO BUSY. Notes arriving often makes a listener track them. Low density and
   slow tempo are what "background" means.
4. TOO CLEAN. A perfectly dry sound with one harmonic reads as synthetic
   immediately. Some room and some air are not decoration.

THE MODES, WHICH DECIDE MOOD MORE THAN ANYTHING ELSE
${Object.entries(MODE_NOTES)
  .map(([k, v]) => `  ${k}: ${v}`)
  .join('\n')}

THE CHORD MOVEMENTS
${Object.entries(PROGRESSIONS)
  .map(([k, v]) => `  ${k}: ${v.note}`)
  .join('\n')}

THE INSTRUMENTS
${Object.entries(VOICES)
  .map(([k, v]) => `  ${k}: ${v.note}`)
  .join('\n')}

Answer with every field. Stay inside every range. Do not explain yourself.`;

export interface Suggestion {
  settings: SynthSettings;
  /** One line on what was made of the description, for the person who asked. */
  reading: string;
}

/**
 * Settings for a description.
 *
 * FAILS BACK TO THE DEFAULTS RATHER THAN THROWING, because the box is optional
 * and the form is not. Somebody who typed a sentence and got a model error has
 * lost nothing they could not get by turning the knobs themselves, so the
 * failure is reported alongside a working starting point rather than instead of
 * one.
 */
export const suggestSynth = async (
  description: string,
  model: LlmClient,
  onCost?: (pence: number) => void
): Promise<Suggestion> => {
  const prompt = `THE DESCRIPTION
${description.trim()}

THE CONTROLS, with their ranges and what each one does
${controlsForPrompt()}

Return ONLY this JSON object, with every control set:

{
  "reading": "one short line on what you took the description to mean",
  "settings": { ${CONTROLS.map((c) => `"${c.id}": ...`).join(', ')} }
}`;

  const reply = await completeJson<{ reading?: unknown; settings?: unknown }>(
    model,
    {
      system: SUGGEST_SYSTEM,
      prompt,
      // The answer is two dozen numbers. The ceiling is for a small model's
      // preamble, not for the settings.
      maxTokens: 3_000,
      effort: 'low',
      // The system prompt is the same on every call and is most of the tokens.
      cacheSystem: true,
      // Some spread, or every description of a quiet scene returns one bed.
      temperature: 0.7,
    },
    onCost
  );

  return {
    settings: synthSchema.parse({ ...DEFAULTS, ...(reply.settings as object) }),
    reading: typeof reply.reading === 'string' ? reply.reading : description.trim(),
  };
};
