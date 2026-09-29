/**
 * The synthesiser, and the two things that decide whether it is usable.
 *
 * ONE: EVERY EXPRESSION MUST BE COMMA-FREE. A comma separates filters in a
 * filtergraph, including the string passed to `-f lavfi -i`, so an envelope
 * written as `min(t/a,1)` does not parse as a clamp. It parses as the end of
 * `aevalsrc` and the start of a filter called `1`, and ffmpeg reports it as
 * being unable to open the input, which points nowhere near the cause. It cost
 * a while to find, and nothing but a test will stop it coming back.
 *
 * TWO: THE COMMAND LINE HAS A LENGTH LIMIT. Every note is an input carrying a
 * several-hundred-character expression, and Windows refuses a command over
 * 32,767 characters. Six voices at full density over eight bars went past it
 * and the render failed outright rather than degrading.
 *
 * Nothing here runs ffmpeg. These are properties of the strings that get built,
 * which is exactly the layer the failures were in.
 */
import {
  CONTROLS,
  DEFAULTS,
  MODES,
  NOTE_NAMES,
  PROGRESSIONS,
  SynthSettings,
  VOICES,
  fromPreset,
  hzFor,
  loopSeconds,
  midiFor,
  settingsFromValues,
  synthSchema,
} from '../synth';
import { MAX_NOTE_CHARS, buildGraph, chordFor, noteExpr, sequence } from '../synthRender';

const at = (over: Partial<SynthSettings> = {}): SynthSettings =>
  synthSchema.parse({ ...DEFAULTS, ...over });

describe('notes and modes', () => {
  it('keeps every root low enough to sit under a voice', () => {
    // Speech runs roughly 85 to 255 Hz. A bed rooted in that range competes
    // with the thing it exists to support, and ducking does not fix a
    // collision in the same octave.
    for (const n of NOTE_NAMES) expect(hzFor(midiFor(n))).toBeLessThan(130);
  });

  it('gives every mode seven degrees', () => {
    for (const [name, steps] of Object.entries(MODES)) {
      expect(steps).toHaveLength(7);
      expect(steps[0]).toBe(0);
      expect(name).toBeTruthy();
    }
  });

  it('builds a triad that rises', () => {
    const chord = chordFor('aeolian', 0);
    expect(chord).toEqual([0, 3, 7]);
  });

  /** Wrapping past the seventh degree is the next octave, not a fold back down. */
  it('takes a chord above the octave when the degree wraps', () => {
    const chord = chordFor('aeolian', 6);
    expect(chord[1]).toBeGreaterThan(chord[0]!);
    expect(chord[2]).toBeGreaterThan(chord[1]!);
  });

  it('gives every progression four chords', () => {
    for (const p of Object.values(PROGRESSIONS)) expect(p.degrees).toHaveLength(4);
  });
});

describe('note expressions', () => {
  /** THE ONE THAT COST TIME. See the header. */
  it('never contains a comma', () => {
    for (const voice of Object.keys(VOICES)) {
      const s = at({ voices: [voice as 'pad'], partials: 8, detune: 30 });
      for (const note of sequence(s)) {
        expect(noteExpr(note, s)).not.toContain(',');
      }
    }
  });

  it('names the source and its length', () => {
    const s = at();
    const expr = noteExpr(sequence(s)[0]!, s);
    expect(expr).toContain('aevalsrc=exprs=');
    expect(expr).toContain('s=48000');
    expect(expr).toContain(':d=');
  });

  /** A bare sine is a test tone, which is what the first bed sounded like. */
  it('stacks harmonics rather than emitting one sine', () => {
    const s = at({ partials: 6, detune: 0 });
    const expr = noteExpr(sequence(s)[0]!, s);
    expect(expr.match(/sin\(/g)?.length).toBeGreaterThan(3);
  });

  it('emits two detuned copies when detune is on, and one when it is not', () => {
    const on = at({ partials: 2, detune: 20 });
    const off = at({ partials: 2, detune: 0 });
    const count = (s: SynthSettings) => noteExpr(sequence(s)[0]!, s).match(/sin\(/g)?.length ?? 0;
    expect(count(on)).toBe(count(off) * 2);
  });

  it('uses an exponential attack rather than a clamp', () => {
    const expr = noteExpr(sequence(at())[0]!, at());
    expect(expr).toContain('1-exp(-');
    expect(expr).not.toContain('min(');
  });
});

describe('sequencing', () => {
  it('plays something for every setting in range', () => {
    for (const voice of Object.keys(VOICES)) {
      expect(sequence(at({ voices: [voice as 'pad'] })).length).toBeGreaterThan(0);
    }
  });

  it('puts notes in time order', () => {
    const notes = sequence(at({ voices: ['pad', 'piano', 'drum'] }));
    for (let i = 1; i < notes.length; i += 1) {
      expect(notes[i]!.at).toBeGreaterThanOrEqual(notes[i - 1]!.at);
    }
  });

  it('keeps every note inside the loop', () => {
    const s = at({ bars: 8, density: 1 });
    const end = loopSeconds(s);
    for (const note of sequence(s)) expect(note.at).toBeLessThan(end);
  });

  it('plays more with more density', () => {
    const sparse = sequence(at({ voices: ['piano'], density: 0 })).length;
    const dense = sequence(at({ voices: ['piano'], density: 1 })).length;
    expect(dense).toBeGreaterThan(sparse);
  });

  /** A drone is one chord for the whole loop, not four identical changes. */
  it('holds one chord on a drone', () => {
    const notes = sequence(at({ voices: ['bass'], progression: 'drone' }));
    expect(new Set(notes.map((n) => n.hz)).size).toBe(1);
  });

  it('leaves downbeats on the grid when swinging', () => {
    const beatS = 60 / 66;
    const notes = sequence(at({ voices: ['pluck'], swing: 0.35, density: 1 }));
    const first = notes.find((n) => n.at < beatS / 2);
    expect(first?.at).toBe(0);
  });
});

describe('the command length budget', () => {
  /**
   * THE SECOND FAILURE. Six voices, full density, eight bars produced a command
   * line over the Windows limit and the render failed with ENAMETOOLONG rather
   * than degrading.
   */
  it('stays inside the budget at the most extreme settings', () => {
    const s = at({
      voices: ['pad', 'piano', 'bell', 'pluck', 'bass', 'drum'],
      density: 1,
      bars: 8,
      tempo: 120,
      partials: 8,
      detune: 30,
    });

    const graph = buildGraph(s);
    const chars = graph.inputs.reduce((n, a) => n + a.length, 0);

    expect(chars).toBeLessThan(MAX_NOTE_CHARS + 2000);
    expect(graph.notes).toBeGreaterThan(20);
  });

  it('drops nothing when everything fits', () => {
    const s = at({ voices: ['bass'], progression: 'drone', bars: 2 });
    expect(buildGraph(s).notes).toBe(sequence(s).length);
  });

  it('ends the graph on the label the render maps', () => {
    expect(buildGraph(at()).filter).toContain('[out]');
  });

  it('trims the loop so the reverb tail wraps into the repeat', () => {
    const s = at();
    expect(buildGraph(s).filter).toContain(`atrim=0:${loopSeconds(s).toFixed(3)}`);
  });
});

describe('controls', () => {
  /**
   * The controls and the schema are two views of one thing, and the moment they
   * disagree a slider offers a value the renderer refuses.
   */
  it('has a control for every setting', () => {
    const controlled = new Set(CONTROLS.map((c) => String(c.id)));
    for (const key of Object.keys(DEFAULTS)) expect(controlled.has(key)).toBe(true);
  });

  it('gives every slider a range and every choice its options', () => {
    for (const c of CONTROLS) {
      expect(c.help.length).toBeGreaterThan(10);
      if (c.kind === 'slider') {
        expect(typeof c.min).toBe('number');
        expect(c.max).toBeGreaterThan(c.min!);
      } else {
        expect(c.options?.length).toBeGreaterThan(0);
      }
    }
  });

  it('accepts the defaults', () => {
    expect(() => synthSchema.parse(DEFAULTS)).not.toThrow();
  });

  it('keeps every default inside its own control range', () => {
    for (const c of CONTROLS) {
      if (c.kind !== 'slider') continue;
      const v = DEFAULTS[c.id] as number;
      expect(v).toBeGreaterThanOrEqual(c.min!);
      expect(v).toBeLessThanOrEqual(c.max!);
    }
  });
});

describe('settingsFromValues', () => {
  it('reads a toggle list, a choice and a number', () => {
    const out = settingsFromValues((id) =>
      ({ voices: 'pad,bell', mode: 'lydian', brightness: '3000' })[id]
    );
    expect(out).toEqual({ voices: ['pad', 'bell'], mode: 'lydian', brightness: 3000 });
  });

  /**
   * Absent means "leave that one alone", because these are merged on top of an
   * existing set. Defaulting here would reset every knob the person did not
   * happen to name.
   */
  it('leaves out what was not given', () => {
    expect(settingsFromValues(() => undefined)).toEqual({});
  });

  it('ignores a value that is not a number rather than passing NaN on', () => {
    expect(settingsFromValues((id) => (id === 'tempo' ? 'quickly' : undefined))).toEqual({});
  });
});

describe('presets', () => {
  /**
   * A published episode was mixed against one of the three old styles. Changing
   * what they mean would change what an already-released show sounds like on
   * any re-render.
   */
  it('still fills out the three old styles', () => {
    for (const name of ['piano', 'strings', 'epic']) {
      const s = fromPreset(name, 'd');
      expect(() => synthSchema.parse(s)).not.toThrow();
      expect(s.root).toBe('d');
      expect(sequence(s).length).toBeGreaterThan(0);
    }
  });

  it('falls back to a valid key rather than failing on a bad one', () => {
    expect(fromPreset('piano', 'not-a-note').root).toBe('a');
  });
});
