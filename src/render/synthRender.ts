/**
 * Turning a parameter set into audio.
 *
 * A SEQUENCER AND A SYNTHESISER, both in ffmpeg. The sequencer decides which
 * notes happen and when; the synthesiser is one `aevalsrc` per note evaluating
 * a harmonic stack with an envelope, placed in time with `adelay`. That is more
 * inputs than one long expression would need and it is much cheaper, because
 * ffmpeg evaluates each source only for its own duration rather than evaluating
 * a thirty-second expression that is silent most of the time.
 *
 * NO COMMA MAY APPEAR IN ANY EXPRESSION HERE, and it is not a style rule. A
 * comma separates filters in a filtergraph, including the one passed to
 * `-f lavfi -i`, so `min(t/a,1)` does not parse as a clamp - it parses as the
 * end of `aevalsrc` and the start of a filter called `1`, and ffmpeg reports it
 * as being unable to open the input, which points nowhere near the cause.
 * The attack is therefore `1-exp(-k*t)` rather than a clamp, which is also what
 * a real instrument does: nothing reaches full volume on a straight line.
 *
 * THE CAP IS REAL. `MAX_NOTES` exists because every note is an input, ffmpeg
 * has a limit, and a command line does too. Eight bars of six voices at full
 * density would pass both. Notes are dropped from the least audible end rather
 * than the render failing, because a slightly sparser bed is a far better
 * outcome than no bed.
 */
import {
  SynthSettings,
  MODES,
  PROGRESSIONS,
  VOICES,
  hzFor,
  loopSeconds,
  midiFor,
} from './synth';
import { reverbIR, reverbShape } from './instruments';
import fs from 'fs';
import { runProcess } from './assemble';

/**
 * A first, generous cap on note count.
 *
 * NOT THE REAL LIMIT. The binding constraint is the length of the command line,
 * because every note is an `-i` input carrying a several-hundred-character
 * expression, and Windows refuses a command over 32,767 characters with
 * ENAMETOOLONG. Six voices at full density over eight bars hit that and the
 * render failed outright. This is only here to stop the sequencer building
 * thousands of events before the length budget below trims them.
 */
export const MAX_NOTES = 160;

/**
 * How many characters of command line the notes may use.
 *
 * MEASURED AGAINST THE REAL FAILURE. Windows caps a command at 32,767
 * characters; the filter graph, the reverb impulse and the output path take
 * a couple of thousand, so the notes get 26,000 and the whole thing lands
 * comfortably under. Trimming to a character budget rather than a note count is
 * the only version of this that holds, because one note is anywhere from 120 to
 * 900 characters depending on partials and detune.
 */
export const MAX_NOTE_CHARS = 26_000;

/**
 * The loudness every beat is normalised to, in LUFS.
 *
 * -20 sits one below the platform's -19 LUFS programme target, so a bed starts
 * just under the voice before `BED_GAIN` and the ducking put it where it
 * belongs. The number that matters is not this one but the fact that it is the
 * same for every beat.
 */
export const LOOP_LUFS = -20;

export interface NoteEvent {
  /** Seconds from the start of the loop. */
  at: number;
  hz: number;
  /** How long the source runs, including its tail. */
  seconds: number;
  voice: string;
  /** Relative level, before the voice's own gain. */
  level: number;
}

const fixed = (n: number, places = 4): string => n.toFixed(places);

/** The chord on a scale degree: root, third and fifth within the mode. */
export const chordFor = (mode: string, degree: number): number[] => {
  const scale = MODES[mode] ?? MODES.aeolian!;
  return [0, 2, 4].map((step) => {
    const i = degree + step;
    // Wrapping past the seventh degree means the next octave up, which is what
    // keeps a chord a chord rather than collapsing it into one octave.
    return scale[i % 7]! + 12 * Math.floor(i / 7);
  });
};

/**
 * Every note in one loop, in time order.
 *
 * WHAT EACH VOICE DOES IS PART OF WHAT THE VOICE IS. A pad holds the whole
 * chord for the bar; a bass holds only the root; a pluck plays on beats. Making
 * that a per-voice rule rather than a parameter is deliberate - a pad that
 * plays on beats is not a pad with an unusual setting, it is a different
 * instrument, and the controls that matter are the ones a listener can hear.
 */
export const sequence = (s: SynthSettings): NoteEvent[] => {
  const beatS = 60 / s.tempo;
  const barS = beatS * 4;
  const rootMidi = midiFor(s.root);
  const degrees = (PROGRESSIONS[s.progression] ?? PROGRESSIONS.return!).degrees;

  const events: NoteEvent[] = [];

  for (let bar = 0; bar < s.bars; bar += 1) {
    const chord = chordFor(s.mode, degrees[bar % degrees.length]!);
    const barAt = bar * barS;

    for (const voice of s.voices) {
      const v = VOICES[voice];
      if (!v) continue;

      const pitch = (semitone: number) => hzFor(rootMidi + semitone + 12 * v.octave);
      // The source has to outlive the note, or the decay is cut off mid-tail.
      const tail = s.decay + 0.4;

      if (voice === 'pad') {
        // The whole chord, held. Density thins it from the top, so a low
        // density is root and fifth rather than a quieter triad.
        const keep = Math.max(1, Math.round(1 + s.density * (chord.length - 1)));
        for (const semitone of chord.slice(0, keep)) {
          events.push({ at: barAt, hz: pitch(semitone), seconds: barS + tail, voice, level: 1 / keep });
        }
        continue;
      }

      if (voice === 'bass') {
        events.push({ at: barAt, hz: pitch(chord[0]! - 12), seconds: barS + tail, voice, level: 1 });
        continue;
      }

      if (voice === 'drum') {
        events.push({ at: barAt, hz: hzFor(rootMidi - 12), seconds: 1.2, voice, level: 1 });
        // A second pulse only once there is enough going on to hide it.
        if (s.density > 0.6) {
          events.push({ at: barAt + barS / 2, hz: hzFor(rootMidi - 12), seconds: 1.2, voice, level: 0.6 });
        }
        continue;
      }

      // piano, bell, pluck: struck notes on beats.
      const hits = 1 + Math.round(s.density * 3);
      for (let i = 0; i < hits; i += 1) {
        const beat = Math.round((i * 4) / hits);
        // Swing pushes the offbeats late, which is what stops a grid sounding
        // like a grid. Downbeats never move.
        const swung = beat % 2 === 1 ? s.swing * beatS * 0.5 : 0;
        events.push({
          at: barAt + beat * beatS + swung,
          hz: pitch(chord[i % chord.length]!),
          seconds: Math.min(barS * 2, s.decay + 0.4),
          voice,
          // Later notes in the bar sit back, so a figure has a shape.
          level: i === 0 ? 1 : 0.7,
        });
      }
    }
  }

  events.sort((a, b) => a.at - b.at);

  // Over the cap, drop the quietest first: it is the least audible change, and
  // it keeps every downbeat, which is what carries the harmony.
  if (events.length > MAX_NOTES) {
    const keep = [...events].sort((a, b) => b.level - a.level).slice(0, MAX_NOTES);
    const keepSet = new Set(keep);
    return events.filter((e) => keepSet.has(e));
  }

  return events;
};

/**
 * One note, as an expression ffmpeg can evaluate per sample.
 *
 * A harmonic stack under an envelope, twice, a few cents apart. The second copy
 * is what `detune` buys: two nearly-identical tones beat slowly against each
 * other, and that slow beating is most of what makes a synthesised pad sound
 * like more than one thing playing.
 */
export const noteExpr = (note: NoteEvent, s: SynthSettings): string => {
  const v = VOICES[note.voice]!;
  const attack = Math.max(0.002, Math.min(s.attack, note.seconds / 2));
  const decay = Math.max(0.05, s.decay * (v.decayS / 3.4));
  const sustain = v.sustain;

  const stack = (hz: number): string => {
    const terms: string[] = [];
    let total = 0;
    for (let k = 1; k <= s.partials; k += 1) {
      const amp = 1 / Math.pow(k, v.rolloff);
      total += amp;
      // Stiff strings and struck metal run progressively sharp of exact
      // multiples. That is why a piano is not an organ and a bell is neither.
      const f = hz * k * (1 + v.stretch * k * k);
      if (f > 18000) break;
      terms.push(`${fixed(amp)}*sin(2*PI*${fixed(f, 3)}*t)`);
    }
    return `(${terms.join('+')})/${fixed(Math.max(total, 0.001))}`;
  };

  const detuned = note.hz * Math.pow(2, s.detune / 1200);
  const tone = s.detune > 0 ? `0.5*${stack(note.hz)}+0.5*${stack(detuned)}` : stack(note.hz);

  // An exponential attack, not a clamp: no comma (see the header), and it is
  // closer to a real instrument anyway. 3/attack reaches about 95 per cent at
  // the requested attack time.
  const k = 3 / attack;
  const env =
    `(1-exp(-${fixed(k, 3)}*t))*` +
    `(${fixed(sustain)}+${fixed(1 - sustain)}*exp(-t/${fixed(decay)}))`;
  const level = fixed(note.level * v.gain * 0.9);

  return `aevalsrc=exprs=${level}*${env}*(${tone}):s=48000:d=${fixed(note.seconds, 3)}`;
};

export interface Graph {
  inputs: string[];
  filter: string;
  seconds: number;
  /** Notes that survived the length budget, which is what was actually played. */
  notes: number;
}

/**
 * The whole loop as an ffmpeg graph: every note, mixed, shaped and put in a room.
 *
 * THE ORDER OF THE CHAIN IS NOT ARBITRARY. Filter before movement, because a
 * tremolo on an already-dark sound is a different thing from darkening a sound
 * that is already moving. Saturation before reverb, because tape saturates the
 * signal and not the room. Reverb last but for the limiter, because the room is
 * the last thing that happens to a sound before it reaches anybody.
 */
export const buildGraph = (s: SynthSettings): Graph => {
  const seconds = loopSeconds(s);
  const inputs: string[] = [];
  const parts: string[] = [];
  const labels: string[] = [];

  // THE LENGTH BUDGET, AND IT IS THE REASON THIS IS NOT JUST `sequence()`.
  // Expressions are built first and measured, then the quietest are dropped
  // until they fit. Quietest first keeps every downbeat, which is what carries
  // the harmony; a listener notices a missing chord change and does not notice
  // one fewer voice in a triad.
  const built = sequence(s)
    .map((note) => ({ note, expr: noteExpr(note, s) }))
    .sort((a, b) => b.note.level - a.note.level);

  const keep: typeof built = [];
  let chars = 0;
  for (const item of built) {
    if (chars + item.expr.length > MAX_NOTE_CHARS) continue;
    chars += item.expr.length;
    keep.push(item);
  }

  const notes = keep.sort((a, b) => a.note.at - b.note.at);

  notes.forEach(({ note, expr }, i) => {
    inputs.push('-f', 'lavfi', '-i', expr);
    const ms = Math.round(note.at * 1000);
    parts.push(`[${i}:a]adelay=${ms}:all=1[n${i}]`);
    labels.push(`[n${i}]`);
  });

  let index = notes.length;

  // Air: filtered noise under everything. A perfectly silent floor is the
  // loudest tell that something was synthesised rather than recorded.
  if (s.air > 0) {
    inputs.push('-f', 'lavfi', '-i', `anoisesrc=c=pink:r=48000:a=${fixed(s.air)}:d=${fixed(seconds + 2, 2)}`);
    parts.push(`[${index}:a]lowpass=f=6000[air]`);
    labels.push('[air]');
    index += 1;
  }

  parts.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0[mixed]`);

  // Tone. Resonance is a bell boost right at the corner, which is what a
  // resonant filter does and what `lowpass` alone will not give.
  const chain: string[] = [`lowpass=f=${Math.round(s.brightness)}`];
  if (s.resonance > 0.2) {
    chain.push(`equalizer=f=${Math.round(s.brightness)}:width_type=q:w=1.2:g=${fixed(s.resonance, 2)}`);
  }

  // Movement.
  if (s.vibrato > 0.5) {
    chain.push(`vibrato=f=${fixed(Math.max(0.1, s.lfoRate * 3), 2)}:d=${fixed(Math.min(0.9, s.vibrato / 50), 3)}`);
  }
  if (s.lfoDepth > 0.01) {
    chain.push(`tremolo=f=${fixed(Math.max(0.1, s.lfoRate), 2)}:d=${fixed(s.lfoDepth, 3)}`);
  }

  // Echo, before the room, so the repeats are in the room rather than beside it.
  if (s.delay > 0) {
    const fb = Math.max(0.05, s.delayFeedback);
    chain.push(`aecho=0.8:0.9:${Math.round(s.delay)}:${fixed(fb, 2)}`);
  }

  // Warmth. tanh is a soft clipper: it rounds peaks rather than cutting them,
  // which is the difference between tape and distortion. No commas, so it is
  // safe inside the graph.
  if (s.warmth > 0.02) {
    const drive = 1 + s.warmth * 6;
    chain.push(`aeval=tanh(${fixed(drive, 2)}*val(0))/${fixed(Math.tanh(drive), 4)}`);
  }

  parts.push(`[mixed]${chain.join(',')}[shaped]`);

  // The room.
  const tail = Math.max(0.2, s.space);
  inputs.push(...reverbIR(tail));
  parts.push(`[${index}:a]${reverbShape(tail)},aformat=channel_layouts=mono[ir]`);

  const wet = Math.round(s.spaceMix * 10);
  const dry = Math.round((1 - s.spaceMix) * 10) + 1;

  parts.push(
    `[shaped][ir]afir=dry=${dry}:wet=${wet},` +
      // Trimmed back to exactly one loop so the reverb tail wraps into the
      // repeat instead of leaving a hole at the seam.
      `atrim=0:${fixed(seconds, 3)},asetpts=PTS-STARTPTS,` +
      // LEVELLING HAPPENS IN A SECOND PASS, not here. See renderSynth.
      `volume=${fixed(s.gain, 3)}[out]`
  );

  return { inputs, filter: parts.join(';'), seconds, notes: notes.length };
};

export interface SynthDeps {
  run?: typeof runProcess;
  ffmpeg?: string;
}

/**
 * Render one loop to a file.
 *
 * FAILS SOFT AND SAYS WHY. Music is decoration on a thing whose value is the
 * words, so nothing here throws: a missing ffmpeg, a filter this build does not
 * carry, an expression it will not parse, all come back as a reason. The one
 * thing that must never happen is a render that reports success and wrote
 * nothing, so the size is checked rather than the exit code alone.
 */
export const renderSynth = async (
  settings: SynthSettings,
  out: string,
  deps: SynthDeps = {}
): Promise<{ ok: boolean; seconds: number; notes: number; reason?: string }> => {
  const run = deps.run ?? runProcess;
  const bin = deps.ffmpeg ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
  const graph = buildGraph(settings);
  const notes = graph.notes;

  const fail = (res: { code: number; stderr: string }) => ({
    ok: false as const,
    seconds: 0,
    notes,
    reason:
      res.stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300) ||
      `ffmpeg exited ${res.code}`,
  });

  // PASS ONE: synthesise, unlevelled, to a lossless intermediate.
  const raw = `${out}.raw.wav`;

  const first = await run(bin, [
    '-y',
    '-loglevel',
    'error',
    ...graph.inputs,
    '-filter_complex',
    graph.filter,
    '-map',
    '[out]',
    raw,
  ]);

  if (first.code !== 0) {
    fs.rmSync(raw, { force: true });
    return fail(first);
  }

  // PASS TWO: measure the finished loop, then apply one computed gain.
  //
  // WHY NOT `loudnorm`, WHICH DOES THIS IN ONE FILTER. Because single-pass
  // loudnorm decides its gain from a running window, and on a fourteen-second
  // loop that opens with a slow attack it read the quiet beginning as the whole
  // piece and boosted accordingly: a default bed came back at -0.9 dB mean,
  // limiter-crushed, and louder than the voice it was supposed to sit under.
  // Measuring the whole loop and applying one flat offset cannot do that.
  const measured = await measureLufs(bin, raw, run);
  const offset = measured === null ? 0 : LOOP_LUFS - measured;

  const second = await run(bin, [
    '-y',
    '-loglevel',
    'error',
    '-i',
    raw,
    '-af',
    `volume=${offset.toFixed(2)}dB,alimiter=level_in=1:level_out=0.9:limit=0.9`,
    '-ar',
    '48000',
    '-codec:a',
    'libmp3lame',
    '-q:a',
    '2',
    out,
  ]);

  fs.rmSync(raw, { force: true });

  if (second.code !== 0) return fail(second);
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
    return { ok: false, seconds: 0, notes, reason: 'ffmpeg reported success and wrote nothing' };
  }

  return { ok: true, seconds: graph.seconds, notes };
};

/**
 * Integrated loudness of a finished file, in LUFS, or null if it cannot be read.
 *
 * NULL MEANS "LEAVE THE LEVEL ALONE", not "assume something". A beat at the
 * wrong loudness is a nuisance; a beat at a GUESSED loudness can come out far
 * louder than the speech it sits under, and the person who finds that out is a
 * listener.
 */
export const measureLufs = async (
  bin: string,
  file: string,
  run: typeof runProcess
): Promise<number | null> => {
  const res = await run(bin, ['-hide_banner', '-i', file, '-af', 'ebur128', '-f', 'null', '-']);

  // ebur128 prints its summary to stderr; the last reading is the integrated one.
  const matches = [...res.stderr.matchAll(/I:\s*(-?\d+(?:[.]\d+)?)\s*LUFS/g)];
  const last = matches[matches.length - 1];
  if (!last) return null;

  const value = Number(last[1]);
  // Silence reads as -inf. Boosting by eighty decibels to reach target would
  // turn a silent bed into pure noise.
  return Number.isFinite(value) && value > -70 ? value : null;
};
