/**
 * A music bed under the narration, synthesised on the machine for nothing.
 *
 * WHAT WAS ASKED FOR: "something professional, like a background music for
 * narration, epic theme, or maybe piano, or maybe violin and mix of
 * instruments, creating a soothing but context relevant tune."
 *
 * TWO EARLIER ATTEMPTS FAILED, AND THE REASONS ARE WORTH KEEPING.
 *
 * The first was three sine waves held at a fixed pitch for sixteen minutes.
 * The verdict was "not a tune, just a random constant noise", and it was right:
 * every argument in that version's favour was about what it would NOT do, and
 * none about what it would. A bed that only avoids faults is a test tone.
 *
 * The second added movement - chord changes, arpeggios, a pulse - and was still
 * "so dry". Also right, and this time the cause was physics rather than
 * composition: sine waves have no harmonics, no attack, and there was no room
 * around them. See instruments.ts, which fixes all three.
 *
 * WHAT MAKES THIS ONE DIFFERENT, in the order the ear notices:
 *
 *   ROOM. Convolution reverb through `afir`, against an impulse response
 *   synthesised from decaying pink noise. Nothing in recorded music is as dry
 *   as the first two attempts were, so the ear read them as synthetic before it
 *   read them as anything else.
 *
 *   INSTRUMENTS. Harmonic stacks with real envelopes - a struck piano string
 *   with stretched partials and a long decay, a bowed string that takes a third
 *   of a second to speak and has vibrato in the frequency rather than the
 *   amplitude.
 *
 *   ENSEMBLE. String parts are three voices detuned by a few cents against each
 *   other, which is what a section is and why one violin and six violins are
 *   different instruments.
 *
 *   DUCKING. The bed is sidechained to the narration, so it drops several
 *   decibels while a sentence is being spoken and comes back up in the gaps.
 *   This is how every documentary does it, and it dissolves the compromise the
 *   earlier versions were stuck in: a fixed level is either loud enough to hear
 *   or quiet enough not to mask, never both.
 *
 * ONE BED PER PART. Mixed into each beat's file before the beats are
 * concatenated, so it fades up as a part begins and away as it ends.
 *
 * WHAT VARIES PER EPISODE is the key, taken deterministically from the subject.
 *
 * THE NEXT STEP IF THIS IS STILL NOT ENOUGH is a soundfont through fluidsynth -
 * real sampled piano and strings, rendered from MIDI. It needs a binary and a
 * ~140MB SF2, which is the only reason it is not here yet.
 */
import fs from 'fs';
import { runProcess } from './assemble';
import { drumNote, pianoNote, reverbIR, reverbShape, step, stringNote } from './instruments';

/**
 * The bed's level before ducking, as a linear gain.
 *
 * LOWERED FROM 0.3, WHICH WAS TOO LOUD AND WAS SAID SO PLAINLY: "the background
 * noise is loud, reduce". At 0.3 the bed sat 7.8 dB under the narration, which
 * is nearer a film score than a bed - and well outside the accessibility
 * guidance that non-speech should run at least 20 dB below foreground speech.
 *
 * Measured against sixty seconds of real narration at -25.5 dB mean:
 *
 *   gain 0.30, sc 6   -33.3 dB    7.8 dB under - what was rejected
 *   gain 0.20, sc 9   -39.6 dB   14.1 dB under
 *   gain 0.14, sc 9   -42.7 dB   17.2 dB under  <- here
 *   gain 0.10, sc 9   -45.6 dB   20.1 dB under - at the edge of audible
 *
 * The gain is the lever that moves the QUIET parts too, which is why it moved
 * rather than the ducking alone: turning the sidechain up further would have
 * left the bed just as loud between sentences.
 */
export const BED_GAIN = 0.14;

/**
 * How hard the narration pushes the music down, and how fast it recovers.
 *
 * FROM THE PRODUCTION PRACTICE RATHER THAN INVENTED: 3-8 dB of reduction keeps
 * dialogue clear while preserving the music, a ratio around 3:1 to 6:1 is the
 * usual range, and the release wants to be slow so the music swells back
 * between phrases instead of pumping on every pause for breath.
 *
 * `level_sc` TUNED BY MEASUREMENT, over sixty seconds of real narration whose
 * mean is -25.5 dB. The bed unducked sits at -18.9 dB, which is louder than the
 * voice and obviously wrong:
 *
 *   level_sc=1    -22.4 dB   ducked  3.5 dB - still above the narration
 *   level_sc=4    -30.5 dB   ducked 11.6 dB - 5 dB under
 *   level_sc=6    -33    dB  ducked 14   dB - about 8 dB under
 *   level_sc=9    -36.1 dB   ducked 17   dB - about 11 dB under
 *   level_sc=12   -38.1 dB   ducked 19   dB - 13 dB under
 *
 * Nine, alongside a lower base gain. Six was tried first and was too present:
 * the bed has to get out of the way of a sentence, not merely stand behind it.
 */
export const DUCK = 'threshold=0.03:ratio=5:attack=25:release=900:makeup=1:level_sc=9';

/** Seconds of fade at each end of a part. Long, so neither edge is an event. */
export const BED_FADE_IN_S = 4;
export const BED_FADE_OUT_S = 5;

/**
 * The roots the bed may be built on, in Hz.
 *
 * A LOW OCTAVE, WITH THE PARTS BUILT UPWARD FROM IT. The instruments place
 * themselves relative to this - the piano two octaves up, the strings one - so
 * the root is a key rather than a pitch anything actually plays.
 */
const ROOTS = [55.0, 58.27, 61.74, 65.41, 69.3, 73.42, 77.78, 82.41];

/** A stable, uninteresting hash. Same subject, same key, every re-render. */
export const keyFor = (seed: string): number => {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return ROOTS[h % ROOTS.length]!;
};

export const BED_STYLES = ['piano', 'strings', 'epic', 'none'] as const;
export type BedStyle = (typeof BED_STYLES)[number];

export const isBedStyle = (s: string): s is BedStyle =>
  (BED_STYLES as readonly string[]).includes(s);

export const STYLE_NOTES: Record<BedStyle, string> = {
  piano: 'solo piano, a slow falling figure in a large room. Sparse and unhurried.',
  strings: 'a string section holding a four-chord progression. Warm, long, no rhythm.',
  epic: 'strings and low piano over a soft heartbeat drum. The closest to a score.',
  none: 'no music at all.',
};

/** Per-style gain, relative to BED_GAIN, because attacks read louder than tone. */
const STYLE_GAIN: Record<BedStyle, number> = {
  piano: 0.8,
  strings: 1,
  epic: 0.85,
  none: 0,
};

/** Reverb tail per style. Anything with rhythm in it wants less. */
const STYLE_TAIL: Record<BedStyle, number> = {
  piano: 3.2,
  strings: 3.6,
  epic: 2.6,
  none: 0,
};

/** How long one repeat runs. Long enough not to read as a loop. */
const PHRASE_SECONDS: Record<BedStyle, number> = {
  piano: 24,
  strings: 24,
  epic: 24,
  none: 0,
};

/**
 * A minor progression that resolves to where it began: i, VI, III, VII.
 *
 * The last chord leads back into the first, so the loop seam falls on a
 * harmonic return rather than in the middle of a phrase.
 */
const PROGRESSION = [0, 8, 3, 10];

interface Graph {
  inputs: string[];
  /** Filter chain ending on [mix], before reverb and level. */
  filter: string;
}

const lavfi = (src: string): string[] => ['-f', 'lavfi', '-i', src];

/**
 * Build the note events for a style.
 *
 * Every style is four bars of six seconds. Notes are generated as separate
 * sources and placed with `adelay`, which is how a sequencer works and is far
 * cheaper than evaluating one expression for the whole phrase.
 */
const phraseGraph = (style: BedStyle, root: number): Graph => {
  const inputs: string[] = [];
  const parts: string[] = [];
  const labels: string[] = [];
  const bar = 6;

  const place = (src: string, atSeconds: number, gain = 1): void => {
    // FOUR ARGV ELEMENTS PER INPUT, not three: -f lavfi -i <src>. Dividing by
    // three produced fractional stream indices like [1.333:a] and ffmpeg
    // rejected the whole graph with "Invalid file index".
    const i = inputs.length / 4;
    inputs.push(...lavfi(src));
    const ms = Math.round(atSeconds * 1000);
    const label = `v${i}`;
    parts.push(
      `[${i}:a]volume=${gain.toFixed(3)}` +
        (ms > 0 ? `,adelay=${ms}|${ms}` : '') +
        `[${label}]`
    );
    labels.push(`[${label}]`);
  };

  if (style === 'piano' || style === 'epic') {
    // A FALLING FIGURE, not a scale. Four notes a bar, the chord tone on the
    // beat and the fifth and octave answering it - the shape a pianist plays
    // absent-mindedly, which is what a bed should sound like.
    const figure = [0, 12, 7, 15];
    PROGRESSION.forEach((chord, b) => {
      figure.forEach((offset, n) => {
        const hz = step(root * 4, chord + offset);
        // The downbeat carries; the answering notes sit back.
        place(pianoNote(hz, 4.2), b * bar + n * 1.4, n === 0 ? 1 : 0.62);
      });
      // A low root under each chord, to give the piano a floor to stand on.
      place(pianoNote(step(root, chord), 6), b * bar, 0.5);
    });
  }

  if (style === 'strings' || style === 'epic') {
    // THREE VOICES PER NOTE, DETUNED. A section is not one violin louder; it is
    // many players never quite in tune with each other, and those few cents of
    // spread are the whole difference.
    const cents = [0.997, 1, 1.003];
    PROGRESSION.forEach((chord, b) => {
      const voicing = style === 'epic' ? [0, 7] : [0, 7, 12];
      voicing.forEach((offset) => {
        cents.forEach((detune) => {
          const hz = step(root * 2, chord + offset) * detune;
          place(stringNote(hz, bar + 1.2), b * bar, style === 'epic' ? 0.5 : 0.62);
        });
      });
    });
  }

  if (style === 'epic') {
    // A HEARTBEAT, NOT A METRONOME. Two beats a bar, the second softer, then
    // the bar breathes. Low enough to be felt rather than counted.
    PROGRESSION.forEach((_, b) => {
      place(drumNote(root * 0.75, 2.4), b * bar, 0.85);
      place(drumNote(root * 0.75, 2.4), b * bar + 0.44, 0.45);
      place(drumNote(root * 0.75, 2.4), b * bar + 3, 0.6);
    });
  }

  parts.push(
    `${labels.join('')}amix=inputs=${labels.length}:normalize=0,` +
      // Keeps the stack off the top end, where it would meet consonants.
      `lowpass=f=3400,` +
      // MONO, LIKE THE REST OF THE PIPELINE. renderScript hands the platform
      // 48kHz mono on purpose, and upmixing the bed forced the narration
      // through a mono-to-stereo conversion that applies -3 dB per channel to
      // preserve total power - so the finished mix came out QUIETER than the
      // dry voice it was supposed to sit on top of. Stereo width is not worth
      // attenuating the words for.
      `aformat=channel_layouts=mono[mix]`
  );

  return { inputs, filter: parts.join(';') };
};

export interface BedDeps {
  run?: typeof runProcess;
  ffmpeg?: string;
}

/** Build one loopable phrase of a style, with its room, to `out`. */
export const renderPhrase = async (
  style: BedStyle,
  root: number,
  out: string,
  deps: BedDeps = {}
): Promise<{ ok: boolean; seconds: number; reason?: string }> => {
  if (style === 'none') return { ok: false, seconds: 0, reason: 'music is off' };

  const run = deps.run ?? runProcess;
  const bin = deps.ffmpeg ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
  const { inputs, filter } = phraseGraph(style, root);
  const tail = STYLE_TAIL[style];
  const irIndex = inputs.length / 4;

  const res = await run(bin, [
    '-y',
    '-loglevel',
    'error',
    ...inputs,
    ...reverbIR(tail),
    '-filter_complex',
    `${filter};` +
      `[${irIndex}:a]${reverbShape(tail)},aformat=channel_layouts=mono[ir];` +
      // dry under wet: the room is most of the sound at this level.
      `[mix][ir]afir=dry=6:wet=9,` +
      // Trimmed back to the bar count so the reverb tail wraps into the repeat
      // rather than leaving a hole at the loop point.
      `atrim=0:${PHRASE_SECONDS[style]},asetpts=PTS-STARTPTS,` +
      `alimiter=level_in=1:level_out=0.9:limit=0.9[ph]`,
    '-map',
    '[ph]',
    '-codec:a',
    'libmp3lame',
    '-q:a',
    '2',
    out,
  ]);

  return res.code === 0
    ? { ok: true, seconds: PHRASE_SECONDS[style] }
    : { ok: false, seconds: 0, reason: res.stderr.slice(0, 250) || `ffmpeg exited ${res.code}` };
};

/**
 * Mix a bed under one rendered part, in place.
 *
 * FAILS SOFT, ALWAYS. Music is decoration on a thing whose value is the words,
 * so every failure - no ffmpeg, a filter this build does not carry, a bad
 * expression - leaves the original file exactly as it was and reports why.
 */
export const mixBed = async (
  input: {
    /** The rendered part. Overwritten on success, untouched on failure. */
    file: string;
    durationS: number;
    /** Decides the key. The episode subject, so it is stable per show-topic. */
    seed: string;
    style?: BedStyle;
    /**
     * A loop already on disk, from the beat library, used instead of
     * synthesising one.
     *
     * THE REASON THIS OPTION EXISTS IS NOT SPEED, though it is faster. Without
     * it the phrase is built per PART, so a three-part episode makes the same
     * twenty-four second phrase three times, and a show's music is whatever the
     * topic string happened to seed rather than something anybody chose. A
     * named beat is a show having a sound.
     *
     * Not deleted afterwards, unlike a synthesised phrase: it belongs to the
     * library rather than to this call.
     */
    phraseFile?: string;
  },
  deps: BedDeps = {}
): Promise<{ applied: boolean; reason?: string }> => {
  const run = deps.run ?? runProcess;
  const bin = deps.ffmpeg ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
  const style = input.style ?? 'strings';

  if (style === 'none') return { applied: false, reason: 'music is off' };

  const minimum = BED_FADE_IN_S + BED_FADE_OUT_S + 2;
  if (!(typeof input.durationS === 'number' && input.durationS > minimum)) {
    return { applied: false, reason: `duration ${input.durationS}s is too short or unreadable` };
  }

  // NOTHING ON DISK, NOTHING TO MIX - and this keeps the unit suite hermetic,
  // exactly as the same check does in `trailingSilence`. A test driving
  // renderScript with an injected `writeFile` never puts bytes anywhere, and
  // without this every one of those tests spawned ffmpeg to synthesise a
  // twenty-four second orchestral phrase for a file that does not exist. Five
  // suites went from four seconds to fifty and timed out in parallel.
  if (!fs.existsSync(input.file)) {
    return { applied: false, reason: 'no audio on disk to mix under' };
  }
  const root = keyFor(input.seed);
  const d = input.durationS;
  const fadeOutAt = Math.max(0, d - BED_FADE_OUT_S);
  const phrase = `${input.file}.phrase.mp3`;
  const tmp = `${input.file}.bed.mp3`;

  const supplied = input.phraseFile && fs.existsSync(input.phraseFile);
  const loop = supplied ? input.phraseFile! : phrase;

  if (!supplied) {
    const built = await renderPhrase(style, root, phrase, deps);
    if (!built.ok) return { applied: false, reason: built.reason };
  }

  // LOOPED RATHER THAN GENERATED AT FULL LENGTH. A sixteen-minute graph with
  // three hundred note sources would be slow and would hit ffmpeg's input
  // limits; one phrase looped is the same sound for a fraction of the work.
  const res = await run(bin, [
    '-y',
    '-loglevel',
    'error',
    '-stream_loop',
    '-1',
    '-i',
    loop,
    '-i',
    input.file,
    '-filter_complex',
    // The voice, split: one copy to hear, one to drive the ducking.
    `[1:a]asplit=2[voice][key];` +
      `[0:a]atrim=0:${d.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=${BED_FADE_IN_S},` +
      `afade=t=out:st=${fadeOutAt.toFixed(3)}:d=${BED_FADE_OUT_S},` +
      `volume=${(BED_GAIN * STYLE_GAIN[style]).toFixed(4)}[bed];` +
      // The bed gets pushed down while a sentence runs and swells back between.
      `[bed][key]sidechaincompress=${DUCK}[ducked];` +
      `[voice][ducked]amix=inputs=2:duration=first:normalize=0[out]`,
    '-map',
    '[out]',
    '-codec:a',
    'libmp3lame',
    '-q:a',
    '4',
    tmp,
  ]);

  // Only a phrase this call synthesised. A library beat is not ours to delete.
  if (!supplied) fs.rmSync(phrase, { force: true });

  if (res.code !== 0) {
    return { applied: false, reason: res.stderr.slice(0, 250) || `ffmpeg exited ${res.code}` };
  }
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
    return { applied: false, reason: 'ffmpeg reported success and wrote nothing' };
  }

  fs.renameSync(tmp, input.file);
  return { applied: true };
};
