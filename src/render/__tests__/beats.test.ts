/**
 * The beat library turns a bed from "whatever the topic string seeded" into a
 * thing somebody chose and can hear before committing an episode to it.
 *
 * Two behaviours carry that and are pinned here. The cache has to be reused
 * when it is there, because the whole cost argument is that a three-part
 * episode stops synthesising the same phrase three times; and it has to be
 * rebuilt when forced, because the cache is keyed by the file existing rather
 * than by the recipe, which makes an edited recipe the one stale result this
 * design can produce.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BeatRecipe,
  KEYS,
  audioPath,
  buildBeat,
  isKey,
  listBeats,
  loadBeat,
  recipePath,
  saveBeat,
  settingsFor,
} from '../beats';
import { DEFAULTS, SynthSettings, synthSchema } from '../synth';

const settings = (over: Partial<SynthSettings> = {}): SynthSettings =>
  synthSchema.parse({ ...DEFAULTS, ...over });

const recipe = (over: Partial<BeatRecipe> = {}): BeatRecipe => ({
  name: 'night-piano',
  note: 'Low and slow.',
  madeAt: '2026-09-29T17:00:00.000Z',
  settings: settings({ voices: ['piano'], root: 'a' }),
  ...over,
});

/**
 * A stand-in for ffmpeg.
 *
 * IT MUST NOT WRITE FOR THE MEASURE PASS. `renderSynth` runs three commands:
 * synthesise, measure loudness, apply the gain. The measure call ends in `-`,
 * ffmpeg's name for no output at all, and an earlier version of this fake wrote
 * to whatever the last argument was. That left a file literally called `-` in
 * the repository root, and it was committed before anybody noticed.
 */
const fakeFfmpeg = (calls: string[][] = []) => ({
  run: async (bin: string, args: string[]) => {
    calls.push(args);
    const out = args[args.length - 1]!;

    // The loudness pass. Answer with something ebur128-shaped so the levelling
    // is actually exercised rather than silently skipped.
    if (out === '-') {
      return { code: 0, stdout: '', stderr: '  I:         -26.3 LUFS' };
    }

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'not really audio');
    return { code: 0, stdout: '', stderr: '' };
  },
  calls,
});

describe('keys', () => {
  it('accepts the eight roots a bed may sit on', () => {
    expect(Object.keys(KEYS)).toHaveLength(8);
    expect(isKey('a')).toBe(true);
    expect(isKey('C#')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isKey('f')).toBe(false);
    expect(isKey('')).toBe(false);
  });

  /** Low, because this sits under a speaking voice. */
  it('keeps every root beneath the voice', () => {
    for (const hz of Object.values(KEYS)) expect(hz).toBeLessThan(90);
  });
});

describe('saveBeat and loadBeat', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-beats-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a recipe', () => {
    saveBeat(recipe(), dir);
    expect(loadBeat('night-piano', dir)).toEqual(recipe());
  });

  it('returns null for a beat that does not exist', () => {
    expect(loadBeat('nothing', dir)).toBeNull();
  });

  it('lists beats by name', () => {
    saveBeat(recipe({ name: 'zither' }), dir);
    saveBeat(recipe({ name: 'anvil' }), dir);

    expect(listBeats(dir).map((b) => b.name)).toEqual(['anvil', 'zither']);
  });

  /**
   * A hand-edited recipe that no longer parses must not take the listing down
   * with it. Recipes are meant to be edited by hand, so this will happen.
   */
  it('skips a recipe that will not parse rather than failing the listing', () => {
    saveBeat(recipe({ name: 'good' }), dir);
    fs.writeFileSync(recipePath('broken', dir), '{ not json', 'utf8');

    expect(listBeats(dir).map((b) => b.name)).toEqual(['good']);
  });

  it('is empty for a library that does not exist yet', () => {
    expect(listBeats(path.join(dir, 'nope'))).toEqual([]);
  });

  it('refuses a name that would not be a safe filename', () => {
    expect(() => saveBeat(recipe({ name: '../escape' }), dir)).toThrow();
    expect(() => saveBeat(recipe({ name: 'Has Spaces' }), dir)).toThrow();
  });
});

describe('buildBeat', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-beats-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('renders a beat that has no audio yet', async () => {
    const ff = fakeFfmpeg();
    const built = await buildBeat(recipe(), { dir }, ff);

    expect(built.ok).toBe(true);
    expect(built.rendered).toBe(true);
    expect(fs.existsSync(audioPath('night-piano', dir))).toBe(true);
  });

  /** The whole cost argument: three parts must not mean three syntheses. */
  it('reuses the cached audio rather than rendering again', async () => {
    const ff = fakeFfmpeg();
    await buildBeat(recipe(), { dir }, ff);
    const after = ff.calls.length;

    const second = await buildBeat(recipe(), { dir }, ff);

    expect(second.rendered).toBe(false);
    expect(second.ok).toBe(true);
    expect(ff.calls).toHaveLength(after);
  });

  /**
   * The cache is keyed by the file existing, not by the recipe's contents, so
   * changing the key and reusing the old audio is the one stale result this
   * can produce. --force is how the command avoids it.
   */
  it('rebuilds when forced', async () => {
    const ff = fakeFfmpeg();
    await buildBeat(recipe(), { dir }, ff);
    const after = ff.calls.length;

    const again = await buildBeat(recipe({ key: 'e' }), { force: true, dir }, ff);

    expect(again.rendered).toBe(true);
    expect(ff.calls.length).toBeGreaterThan(after);
  });

  it('treats an empty cached file as no cache at all', async () => {
    const ff = fakeFfmpeg();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(audioPath('night-piano', dir), '');

    expect((await buildBeat(recipe(), { dir }, ff)).rendered).toBe(true);
  });

  /**
   * The old three-style form had a `none` that made no sound, and this test
   * used to check it was refused. There is no such style now: an instrument
   * list is the control, and the schema requires at least one. The refusal
   * moved from the renderer to the type, which is where it belongs.
   */
  it('refuses a recipe with no instruments at all', () => {
    expect(() => saveBeat(recipe({ settings: { ...settings(), voices: [] } }), dir)).toThrow();
  });

  /**
   * A recipe written before the synthesiser existed carries a style and a key
   * and nothing else. A published episode was mixed against one of those, so
   * they have to keep rendering.
   */
  it('renders an old style-and-key recipe through its preset', async () => {
    const ff = fakeFfmpeg();
    const old = { name: 'legacy', note: '', madeAt: '2026-09-01T00:00:00.000Z', style: 'piano', key: 'd' };

    const built = await buildBeat(old, { dir }, ff);

    expect(built.ok).toBe(true);
    expect(settingsFor(old).voices).toEqual(['piano']);
    expect(settingsFor(old).root).toBe('d');
  });

  it('reports an ffmpeg failure instead of claiming a beat exists', async () => {
    const built = await buildBeat(
      recipe(),
      { dir },
      { run: async () => ({ code: 1, stdout: '', stderr: 'no such filter' }) }
    );

    expect(built.ok).toBe(false);
    expect(built.reason).toContain('no such filter');
  });
});
