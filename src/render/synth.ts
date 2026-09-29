/**
 * The synthesiser: every parameter that decides what a bed sounds like.
 *
 * WHY THIS REPLACES THREE STYLES. `bed.ts` had `piano | strings | epic`, which
 * is three sounds, and the owner's verdict was the right one: it "makes similar
 * beats". It did, because the only thing that varied between two beats was the
 * root note. Everything that actually distinguishes one piece of background
 * music from another - what is playing, how it is voiced, how fast, in what
 * mode, how bright, how much room - was hardcoded.
 *
 * SO THE PARAMETERS ARE THE PRODUCT. This file defines them once, as data:
 * `CONTROLS` describes every knob well enough for an interface to draw it and
 * for a model to fill it in, and `synthSchema` is the same set as something the
 * renderer can trust. Neither the page nor the model gets its own copy, because
 * the moment there are two lists they disagree.
 *
 * THE THREE OLD STYLES SURVIVE AS PRESETS, not as a type. An existing beat
 * recipe naming `piano` still renders, and renders the same, which matters
 * because a published episode was mixed against it.
 *
 * WHAT IS DELIBERATELY ABSENT: stereo width. The studio is mono end to end by
 * design - see audioStandard on the platform side - so a width control would be
 * a knob that does nothing, which is worse than no knob.
 *
 * STILL FREE, STILL NO DEPENDENCIES. Every voice is `aevalsrc` evaluating a
 * harmonic stack per sample, the room is `anoisesrc` through `afir`, and the
 * movement is `tremolo` and `vibrato`. No soundfont, no samples, no model in
 * the render path. A model may SUGGEST settings (see suggest.ts), but nothing
 * it returns is needed to make a sound.
 */
import { z } from 'zod';

/* --- Notes ---------------------------------------------------------------- */

export const NOTE_NAMES = [
  'c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b',
] as const;

/**
 * MIDI note number for a name in the bed's octave.
 *
 * OCTAVE 2, AND IT IS NOT A PREFERENCE. This sits under a speaking voice, whose
 * fundamental runs roughly 85 to 255 Hz. A bed rooted in that range competes
 * with the thing it is supposed to support, and no amount of ducking fixes a
 * collision in the same octave. C2 is 65 Hz; the highest root here is B2 at
 * 123 Hz, still under most of a voice.
 */
export const midiFor = (name: string): number => {
  const i = NOTE_NAMES.indexOf(name.toLowerCase() as (typeof NOTE_NAMES)[number]);
  return 36 + (i < 0 ? 0 : i);
};

export const hzFor = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

/* --- Modes ---------------------------------------------------------------- */

/**
 * Semitones above the root, per mode.
 *
 * These are the seven church modes minus locrian, which is left out because its
 * flattened fifth gives it no stable tonic. A bed has to be able to sit still
 * for fifteen minutes, and locrian cannot.
 */
export const MODES: Record<string, number[]> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
};

/** What each mode does to a listener, in the words the model is given. */
export const MODE_NOTES: Record<string, string> = {
  ionian: 'plainly major. Warm and settled, and the easiest to sound bland.',
  dorian: 'minor with a raised sixth. Melancholy that is not sad, and the safest for long listening.',
  phrygian: 'flattened second. Tense, unresolved, faintly foreign. Use it when something is wrong.',
  lydian: 'raised fourth. Wonder, distance, weightlessness. The sound of a reveal.',
  mixolydian: 'major with a flat seventh. Open and unhurried, without the brightness of ionian.',
  aeolian: 'natural minor. Direct sadness, and the most familiar minor there is.',
};

/**
 * Chord movements, as scale degrees.
 *
 * WRITTEN AS DEGREES, NOT AS CHORD NAMES, so one progression works in every
 * mode. `[0, 5, 2, 6]` is i-VI-III-VII in aeolian and I-vi-iii-VII in ionian,
 * and both are the same movement: away from the tonic and back.
 */
export const PROGRESSIONS: Record<string, { degrees: number[]; note: string }> = {
  'return': { degrees: [0, 5, 2, 6], note: 'away from the tonic and back. The default, and the least tiring.' },
  'fall': { degrees: [0, 6, 5, 4], note: 'a descending line. Resignation, settling, an ending.' },
  'lift': { degrees: [0, 4, 5, 3], note: 'the common pop turn. Forward motion, the most familiar shape here.' },
  'drone': { degrees: [0, 0, 0, 0], note: 'no movement at all. One chord for the whole loop, for when the words carry everything.' },
  'unease': { degrees: [0, 6, 1, 6], note: 'returns to the wrong chord. Refuses to settle.' },
  'open': { degrees: [0, 3, 0, 4], note: 'plagal, hymn-like. Spacious and slightly formal.' },
};

/* --- Voices --------------------------------------------------------------- */

/**
 * The instruments, as the physics that distinguishes them.
 *
 * A VOICE IS ITS ENVELOPE AND ITS PARTIALS, and nothing else here. A piano and
 * a bell play the same frequencies; what makes one a piano is a six-millisecond
 * attack and a harmonic series stretched sharp by string stiffness, and what
 * makes the other a bell is inharmonic partials over a long even decay. These
 * are defaults the controls then move.
 */
export const VOICES: Record<
  string,
  {
    note: string;
    /** Harmonic amplitude rolloff. Higher is darker and purer. */
    rolloff: number;
    /** Partial stretch, as a fraction. Nonzero is inharmonic. */
    stretch: number;
    attackS: number;
    decayS: number;
    /** Held level after the decay, 0 for anything struck. */
    sustain: number;
    /** Octaves above the written chord. */
    octave: number;
    gain: number;
  }
> = {
  pad: { note: 'a held string-like tone. Slow in, no attack, the bed of the bed.', rolloff: 1.4, stretch: 0, attackS: 1.1, decayS: 4.5, sustain: 0.55, octave: 1, gain: 1 },
  piano: { note: 'struck and decaying, with the stretched partials of a real string.', rolloff: 1.8, stretch: 0.0012, attackS: 0.006, decayS: 3.2, sustain: 0, octave: 1, gain: 0.85 },
  bell: { note: 'glassy and inharmonic, with a very long tail. Sparse or it dominates.', rolloff: 1.1, stretch: 0.02, attackS: 0.004, decayS: 6, sustain: 0, octave: 2, gain: 0.5 },
  pluck: { note: 'short and dry. The only voice here with any rhythm to it.', rolloff: 2.4, stretch: 0.0008, attackS: 0.004, decayS: 0.55, sustain: 0, octave: 1, gain: 0.7 },
  bass: { note: 'the root, an octave down, barely moving. Felt more than heard.', rolloff: 2.8, stretch: 0, attackS: 0.35, decayS: 5, sustain: 0.6, octave: 0, gain: 0.9 },
  drum: { note: 'a soft low pulse on the bar. A heartbeat, not a beat.', rolloff: 3.5, stretch: 0, attackS: 0.002, decayS: 0.4, sustain: 0, octave: 0, gain: 0.55 },
};

export const VOICE_NAMES = Object.keys(VOICES);

/* --- The parameter set ---------------------------------------------------- */

export const synthSchema = z.object({
  /** Which instruments play. At least one. */
  voices: z.array(z.enum(['pad', 'piano', 'bell', 'pluck', 'bass', 'drum'])).min(1),
  root: z.enum(NOTE_NAMES),
  mode: z.enum(['ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian']),
  progression: z.enum(['return', 'fall', 'lift', 'drone', 'unease', 'open']),

  /** Beats per minute. The bar length, and therefore the loop length. */
  tempo: z.number().min(40).max(120),
  /** Bars in one loop. More is less obviously a loop and costs more to render. */
  bars: z.number().int().min(2).max(8),
  /** How much of the chord is played, 0 for roots only, 1 for everything. */
  density: z.number().min(0).max(1),
  /** How far off the grid the offbeat notes fall. */
  swing: z.number().min(0).max(0.35),

  /** Seconds to full volume. Over half a second reads as a swell rather than a note. */
  attack: z.number().min(0.002).max(3),
  /** Seconds for the note to fall away. */
  decay: z.number().min(0.15).max(9),
  /** Low-pass corner in Hz. The single biggest control over how dark it is. */
  brightness: z.number().min(180).max(9000),
  /** Emphasis at the corner, in dB. Over about 8 it starts to whistle. */
  resonance: z.number().min(0).max(14),
  /** Cents of detune between two copies of each voice. Thickness. */
  detune: z.number().min(0).max(30),
  /** Harmonics per note. One is a sine and sounds like a test tone. */
  partials: z.number().int().min(1).max(8),

  /** Tremolo rate in Hz. Under 0.2 is drift; over 3 is an effect. */
  lfoRate: z.number().min(0.02).max(6),
  /** Tremolo depth. */
  lfoDepth: z.number().min(0).max(0.8),
  /** Pitch wobble in cents. A little is human, a lot is seasick. */
  vibrato: z.number().min(0).max(40),

  /** Reverb tail in seconds. */
  space: z.number().min(0.2).max(9),
  /** How much of the reverb is heard against the dry sound. */
  spaceMix: z.number().min(0).max(1),
  /** Echo time in ms. Zero is off. */
  delay: z.number().min(0).max(1200),
  /** How much of the echo comes back. */
  delayFeedback: z.number().min(0).max(0.75),

  /** Soft clipping. A little is tape, a lot is distortion. */
  warmth: z.number().min(0).max(0.9),
  /** Filtered noise under everything, as tape hiss and room air. */
  air: z.number().min(0).max(0.3),
  /** Overall level, before the bed gain that sits it under the voice. */
  gain: z.number().min(0.1).max(1.5),
});

export type SynthSettings = z.infer<typeof synthSchema>;

/**
 * The controls, as data an interface can draw and a model can fill in.
 *
 * ONE LIST, AND THIS IS IT. The page does not keep its own copy of the ranges,
 * and neither does the prompt that asks a model for settings: both read this.
 * Two lists of knobs drift within a week, and the failure is silent - a slider
 * that lets you set something the renderer clamps, or a model confidently
 * returning a value that is out of range.
 *
 * `help` is written for whoever is turning the knob, and is also what the model
 * is told. The same sentence has to serve both, which is a useful discipline:
 * anything too vague for a person is too vague for the model.
 */
export interface Control {
  id: keyof SynthSettings;
  label: string;
  group: string;
  kind: 'toggles' | 'choice' | 'slider';
  help: string;
  /** For `toggles` and `choice`. */
  options?: Array<{ value: string; label: string; help?: string }>;
  min?: number;
  max?: number;
  step?: number;
  /** How to show the number. */
  unit?: string;
}

export const CONTROLS: Control[] = [
  {
    id: 'voices',
    label: 'Instruments',
    group: 'What plays',
    kind: 'toggles',
    help: 'Which instruments play. Two or three is usually right; all six is mud.',
    options: VOICE_NAMES.map((v) => ({ value: v, label: v, help: VOICES[v]!.note })),
  },
  {
    id: 'root',
    label: 'Key',
    group: 'What plays',
    kind: 'choice',
    help: 'The root note, always low so it sits under a speaking voice.',
    options: NOTE_NAMES.map((n) => ({ value: n, label: n.toUpperCase() })),
  },
  {
    id: 'mode',
    label: 'Mode',
    group: 'What plays',
    kind: 'choice',
    help: 'The scale, and the single biggest decision about mood.',
    options: Object.keys(MODES).map((m) => ({ value: m, label: m, help: MODE_NOTES[m] })),
  },
  {
    id: 'progression',
    label: 'Chords',
    group: 'What plays',
    kind: 'choice',
    help: 'How the harmony moves across the loop.',
    options: Object.entries(PROGRESSIONS).map(([k, v]) => ({ value: k, label: k, help: v.note })),
  },

  { id: 'tempo', label: 'Tempo', group: 'Time', kind: 'slider', min: 40, max: 120, step: 1, unit: 'bpm', help: 'Slower is calmer and makes a longer loop. Under 60 stops feeling like a pulse.' },
  { id: 'bars', label: 'Bars', group: 'Time', kind: 'slider', min: 2, max: 8, step: 1, unit: 'bars', help: 'Length of one repeat. More bars is less obviously a loop and takes longer to render.' },
  { id: 'density', label: 'Density', group: 'Time', kind: 'slider', min: 0, max: 1, step: 0.05, help: 'How much of each chord is played. Low is roots and space; high is every note every bar.' },
  { id: 'swing', label: 'Swing', group: 'Time', kind: 'slider', min: 0, max: 0.35, step: 0.01, help: 'Pushes offbeat notes late. A little stops it sounding typed in.' },

  { id: 'attack', label: 'Attack', group: 'Shape', kind: 'slider', min: 0.002, max: 3, step: 0.002, unit: 's', help: 'Time to full volume. Near zero is struck; over half a second is a swell.' },
  { id: 'decay', label: 'Decay', group: 'Shape', kind: 'slider', min: 0.15, max: 9, step: 0.05, unit: 's', help: 'How long a note takes to fall away. Long decays overlap into a wash.' },
  { id: 'brightness', label: 'Brightness', group: 'Shape', kind: 'slider', min: 180, max: 9000, step: 20, unit: 'Hz', help: 'Low-pass corner. The main control over dark and distant against present and clear.' },
  { id: 'resonance', label: 'Resonance', group: 'Shape', kind: 'slider', min: 0, max: 14, step: 0.5, unit: 'dB', help: 'Emphasis right at the corner. A little adds character; a lot whistles.' },
  { id: 'detune', label: 'Detune', group: 'Shape', kind: 'slider', min: 0, max: 30, step: 1, unit: 'cents', help: 'Two copies of each voice, slightly apart. Thickness and slow beating.' },
  { id: 'partials', label: 'Harmonics', group: 'Shape', kind: 'slider', min: 1, max: 8, step: 1, help: 'Overtones per note. One is a bare sine and sounds like a test tone.' },

  { id: 'lfoRate', label: 'Movement rate', group: 'Movement', kind: 'slider', min: 0.02, max: 6, step: 0.02, unit: 'Hz', help: 'How fast the volume breathes. Under 0.2 is drift you feel rather than hear.' },
  { id: 'lfoDepth', label: 'Movement depth', group: 'Movement', kind: 'slider', min: 0, max: 0.8, step: 0.02, help: 'How much it breathes. Zero is static, which under speech is often correct.' },
  { id: 'vibrato', label: 'Vibrato', group: 'Movement', kind: 'slider', min: 0, max: 40, step: 1, unit: 'cents', help: 'Pitch wobble. A little is a human player; a lot is seasickness.' },

  { id: 'space', label: 'Room size', group: 'Space', kind: 'slider', min: 0.2, max: 9, step: 0.1, unit: 's', help: 'Reverb tail. Short is a room, long is a cathedral.' },
  { id: 'spaceMix', label: 'Room amount', group: 'Space', kind: 'slider', min: 0, max: 1, step: 0.05, help: 'How much room against dry sound. Dry reads as synthetic before it reads as anything.' },
  { id: 'delay', label: 'Echo', group: 'Space', kind: 'slider', min: 0, max: 1200, step: 10, unit: 'ms', help: 'Repeat time. Zero is off. Set near the beat to blur the rhythm.' },
  { id: 'delayFeedback', label: 'Echo feedback', group: 'Space', kind: 'slider', min: 0, max: 0.75, step: 0.05, help: 'How much of the echo returns. High turns a repeat into a wash.' },

  { id: 'warmth', label: 'Warmth', group: 'Character', kind: 'slider', min: 0, max: 0.9, step: 0.05, help: 'Soft clipping. A little is tape; a lot is distortion.' },
  { id: 'air', label: 'Air', group: 'Character', kind: 'slider', min: 0, max: 0.3, step: 0.01, help: 'Filtered noise under everything, as hiss and room tone. Kills the vacuum.' },
  { id: 'gain', label: 'Level', group: 'Character', kind: 'slider', min: 0.1, max: 1.5, step: 0.05, help: 'Output level, before the bed gain that sits it under the voice.' },
];

/**
 * Sensible middle, and what an empty form starts on.
 *
 * Deliberately a little dull. A default that is already interesting makes every
 * beat somebody builds a variation on one idea, which is the fault this whole
 * file exists to fix.
 */
export const DEFAULTS: SynthSettings = {
  voices: ['pad', 'piano'],
  root: 'a',
  mode: 'aeolian',
  progression: 'return',
  tempo: 66,
  bars: 4,
  density: 0.5,
  swing: 0.08,
  attack: 0.6,
  decay: 3.4,
  brightness: 1800,
  resonance: 2,
  detune: 9,
  partials: 5,
  lfoRate: 0.12,
  lfoDepth: 0.16,
  vibrato: 6,
  space: 3.4,
  spaceMix: 0.6,
  delay: 0,
  delayFeedback: 0,
  warmth: 0.2,
  air: 0.04,
  gain: 1,
};

/**
 * The three old styles, so an existing recipe still renders.
 *
 * A published episode was mixed against one of these. Changing what `piano`
 * means would change what an already-released show sounded like on any
 * re-render, which is not a decision a refactor gets to make.
 */
export const PRESETS: Record<string, Partial<SynthSettings>> = {
  piano: { voices: ['piano'], mode: 'aeolian', progression: 'return', attack: 0.006, decay: 3.2, brightness: 2200, partials: 6, space: 3.2, spaceMix: 0.65, lfoDepth: 0.05, density: 0.45 },
  strings: { voices: ['pad'], mode: 'aeolian', progression: 'return', attack: 1.1, decay: 4.5, brightness: 1500, partials: 5, space: 3.6, spaceMix: 0.7, lfoDepth: 0.2, density: 0.4 },
  epic: { voices: ['pad', 'piano', 'drum'], mode: 'aeolian', progression: 'return', attack: 0.8, decay: 3.6, brightness: 2400, partials: 6, space: 2.6, spaceMix: 0.55, lfoDepth: 0.12, density: 0.6, tempo: 60 },
};

/** A preset filled out into a complete, renderable setting. */
export const fromPreset = (name: string, root = 'a'): SynthSettings =>
  synthSchema.parse({
    ...DEFAULTS,
    root: NOTE_NAMES.includes(root as (typeof NOTE_NAMES)[number]) ? root : 'a',
    ...(PRESETS[name] ?? {}),
  });

/** Seconds in one loop. Four beats to the bar. */
export const loopSeconds = (s: Pick<SynthSettings, 'tempo' | 'bars'>): number =>
  (60 / s.tempo) * 4 * s.bars;

/** The settings in a line, for a listing or a log. */
export const describe = (s: SynthSettings): string =>
  `${s.voices.join(' + ')}, ${s.root.toUpperCase()} ${s.mode}, ${s.progression}, ` +
  `${s.tempo}bpm, ${Math.round(loopSeconds(s))}s loop`;

/**
 * Whichever controls a caller supplied, parsed and typed.
 *
 * DRIVEN BY `CONTROLS`, so a knob added above is a flag on the command line and
 * a field in an API body without either of them being touched. The lookup is
 * passed in rather than the argv, which is what lets the same function serve a
 * command line, a query string and a JSON body.
 *
 * Anything absent is left absent rather than defaulted, because the caller is
 * merging these ON TOP of an existing set: a missing flag means "leave that
 * one alone", and defaulting it here would silently reset every knob the
 * person did not happen to name.
 */
export const settingsFromValues = (
  get: (id: string) => string | undefined
): Partial<SynthSettings> => {
  const out: Record<string, unknown> = {};

  for (const control of CONTROLS) {
    const raw = get(String(control.id));
    if (raw === undefined || raw === '') continue;

    if (control.kind === 'toggles') {
      out[control.id] = raw
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
      continue;
    }

    if (control.kind === 'choice') {
      out[control.id] = raw.trim().toLowerCase();
      continue;
    }

    const n = Number(raw);
    // A flag that is not a number is left out rather than becoming NaN, which
    // would fail the schema with a message about the wrong thing.
    if (Number.isFinite(n)) out[control.id] = n;
  }

  return out as Partial<SynthSettings>;
};
