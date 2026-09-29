/**
 * Synthesised instruments, and the two things that stop them sounding dry.
 *
 * WHY THE FIRST BED WAS UNUSABLE, and the owner's verdict on it: "they are so
 * dry and just so not what I want." Correct, and the cause was not taste. It
 * was three missing pieces of physics.
 *
 * ONE: A SINE WAVE IS NOT AN INSTRUMENT. A struck piano string produces a
 * fundamental plus a harmonic series, each partial at its own amplitude, and a
 * bowed violin produces a different series again. A sine has no partials at
 * all, which is precisely why it sounds like a test tone: it IS a test tone.
 * Everything here is built as a harmonic STACK - a fundamental plus four to six
 * partials at falling amplitudes - which is additive synthesis, the oldest
 * trick there is and still the one that turns an oscillator into a note.
 *
 * TWO: A NOTE HAS A SHAPE. A piano is near-instant at the front and decays for
 * seconds; a violin takes a third of a second to speak and then holds. Playing
 * either at constant amplitude is the difference between a note and a beep, and
 * the envelope is baked into each expression below rather than applied after.
 *
 * THREE, AND THE BIGGEST: THERE WAS NO ROOM. Every sound in the first version
 * was perfectly dry - no reflections, no tail, no space. Nothing in recorded
 * music is ever that dry, so the ear reads it as synthetic before it reads it
 * as anything else. `reverbIR` synthesises an impulse response - pink noise on
 * an exponential decay, band-limited the way a real room is - and `afir`
 * convolves the music with it. That is convolution reverb, the same technique
 * used to put a dry vocal in a cathedral, and it is the single biggest step
 * from "oscillator" to "recording".
 *
 * ALL OF IT IS STILL FREE. ffmpeg's `aevalsrc` evaluates an arbitrary
 * expression per sample, which is a synthesiser; `anoisesrc` and `afir` are the
 * reverb. No soundfont to install, no samples to license, no model to call.
 *
 * WHAT THIS IS NOT. It is not a sampled Steinway and it is not a real string
 * section. A soundfont through fluidsynth would beat it outright and is the
 * obvious upgrade if this is still not good enough - it needs a binary and a
 * ~140MB SF2 file, which is why it is not the first attempt rather than why it
 * is wrong.
 */

/** Equal temperament: `n` semitones above `root`. */
export const step = (root: number, n: number): number => root * Math.pow(2, n / 12);

const fixed = (n: number): string => n.toFixed(4);

/**
 * A struck-string note: fast attack, long decay, stretched harmonics.
 *
 * The inharmonicity term is real piano behaviour rather than decoration - a
 * stiff string's partials run progressively sharp of exact multiples, and it is
 * a large part of why a piano sounds like a piano and an organ does not.
 */
export const pianoNote = (hz: number, seconds: number): string => {
  const partials = [0.55, 0.3, 0.16, 0.09, 0.05, 0.028];
  const stack = partials
    .map((amp, i) => {
      const n = i + 1;
      const f = hz * n * (1 + 0.0004 * n * n);
      return `${fixed(amp)}*sin(2*PI*${fixed(f)}*t)`;
    })
    .join('+');

  // 6 ms attack, then a decay that runs longer for the lower partials. One
  // exponential is a good enough approximation at this level in a mix.
  return `aevalsrc=exprs=(1-exp(-170*t))*exp(-2.1*t)*(${stack}):d=${seconds}:s=48000`;
};

/**
 * A bowed-string note: slow speech, sustain, vibrato, near-sawtooth spectrum.
 *
 * The vibrato is a frequency modulation inside the sine argument rather than an
 * amplitude wobble on top, because that is what a player's hand actually does
 * and the two do not sound alike.
 */
export const stringNote = (hz: number, seconds: number): string => {
  const partials = [0.5, 0.26, 0.17, 0.12, 0.09, 0.07, 0.05];
  const stack = partials
    .map((amp, i) => {
      const f = hz * (i + 1);
      return `${fixed(amp)}*sin(2*PI*${fixed(f)}*t+0.010*sin(2*PI*5.1*t))`;
    })
    .join('+');

  // 380 ms to speak, a slow swell under it, and a release at the end so the
  // note does not stop square.
  return (
    `aevalsrc=exprs=(1-exp(-2.6*t))*(1-exp(-3.0*(${fixed(seconds)}-t)))*` +
    `(0.86+0.14*sin(2*PI*0.23*t))*(${stack}):d=${seconds}:s=48000`
  );
};

/** A soft low drum: no pitch to speak of, felt rather than heard. */
export const drumNote = (hz: number, seconds: number): string =>
  `aevalsrc=exprs=exp(-5.5*t)*(0.8*sin(2*PI*${fixed(hz)}*t)+0.3*sin(2*PI*${fixed(hz * 1.6)}*t)):` +
  `d=${seconds}:s=48000`;

/**
 * A synthesised room, as an impulse response for `afir`.
 *
 * PINK NOISE ON AN EXPONENTIAL DECAY is the standard way to fake one: pink
 * rather than white because a real room absorbs high frequencies faster, and
 * the band limits stand in for walls that are neither perfectly reflective nor
 * infinitely large.
 *
 * `seconds` is roughly the RT60 - how long the tail runs. A concert hall is
 * around two seconds; a cathedral is four or more. Longer tails cost more to
 * convolve and blur anything rhythmic, so a bed with a pulse in it wants less.
 */
export const reverbIR = (seconds: number): string[] => [
  '-f',
  'lavfi',
  '-i',
  `anoisesrc=d=${seconds}:c=pink:a=0.5:r=48000`,
];

export const reverbShape = (seconds: number): string =>
  `volume=volume='exp(-${fixed(4.6 / seconds)}*t)':eval=frame,` +
  `lowpass=f=5200,highpass=f=130`;
