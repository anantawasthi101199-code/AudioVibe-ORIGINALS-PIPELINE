/**
 * Joining audio, which this pipeline does at two different levels for two
 * different reasons.
 *
 * TURNS join into a beat, and beats are mp3 because that is what the TTS
 * providers return. BEATS join into the episode, and the episode is WAV because
 * the platform masters and transcodes it, so handing it an uncompressed source
 * makes its single 192k encode the only lossy step.
 *
 * One function does both, so the codec has to follow the container. It used to
 * be hardcoded to PCM, which meant writing raw samples into an .mp3 - refused
 * by ffmpeg with "Invalid audio stream. Exactly one MP3 audio stream is
 * required", a message naming neither the codec nor the caller.
 *
 * These run real ffmpeg against real audio, because the bug was in the
 * arguments and a mock would have been built from the same wrong assumption.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { concatBeats, probeDuration, splitForSynthesis } from '../assemble';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

/** A second of silence, so the tests need no fixture files in the repo. */
const tone = (file: string, seconds: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `anullsrc=r=48000:cl=mono`,
      '-t',
      String(seconds),
      file,
    ]);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
  });

const available = (): Promise<boolean> =>
  new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-version']);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });

describe('concatBeats', () => {
  let dir: string;
  let hasFfmpeg = false;

  beforeAll(async () => {
    hasFfmpeg = await available();
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-concat-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const inputs = async (count: number, ext: string) => {
    const files: string[] = [];
    for (let i = 0; i < count; i++) {
      const file = path.join(dir, `in${i}.${ext}`);
      await tone(file, 1);
      files.push(file);
    }
    return files;
  };

  it('joins mp3 turns into an mp3 beat', async () => {
    // The case that was broken. Turns are mp3 because that is what the TTS
    // providers return, and a beat is one joined exchange.
    if (!hasFfmpeg) return;

    const out = path.join(dir, 'beat.mp3');
    await concatBeats(await inputs(3, 'mp3'), out, 0.2);

    expect(fs.statSync(out).size).toBeGreaterThan(0);
    // Three seconds of audio plus two gaps.
    expect(await probeDuration(out)).toBeGreaterThan(3);
  });

  it('joins beats into a WAV episode', async () => {
    if (!hasFfmpeg) return;

    const out = path.join(dir, 'episode.wav');
    await concatBeats(await inputs(2, 'mp3'), out, 0.5);

    const bytes = fs.readFileSync(out);
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString()).toBe('WAVE');
  });

  it('writes a real mp3, not PCM in an mp3 container', async () => {
    // The actual defect. ffmpeg refuses this outright, so the check is simply
    // that the file exists and plays - but the name says what is being guarded.
    if (!hasFfmpeg) return;

    const out = path.join(dir, 'beat.mp3');
    await concatBeats(await inputs(2, 'mp3'), out, 0.2);

    const bytes = fs.readFileSync(out);
    // An ID3 tag or an MPEG frame sync. Never "RIFF".
    const header = bytes.subarray(0, 3).toString();
    expect(header === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)).toBe(true);
    expect(header).not.toBe('RIF');
  });

  it('puts the gap between each pair, not after the last', async () => {
    if (!hasFfmpeg) return;

    const twoNoGap = path.join(dir, 'a.wav');
    const twoBigGap = path.join(dir, 'b.wav');
    const files = await inputs(2, 'mp3');

    await concatBeats(files, twoNoGap, 0);
    await concatBeats(files, twoBigGap, 2);

    const short = (await probeDuration(twoNoGap))!;
    const long = (await probeDuration(twoBigGap))!;
    // One gap between two files, not two.
    expect(long - short).toBeGreaterThan(1.5);
    expect(long - short).toBeLessThan(2.5);
  });

  it('refuses to join nothing', async () => {
    await expect(concatBeats([], path.join(dir, 'x.wav'))).rejects.toThrow(/nothing to concat/);
  });
});

/**
 * Splitting one beat across several requests.
 *
 * WHAT THIS COST. `groupBeats` stops GROUPING at the engine's limit and never
 * SPLITS - its own comment says "a single over-long beat becomes a group of one
 * and renders exactly as it used to" - which was harmless while no beat
 * exceeded the limit. The single-story lane writes longer beats, and a
 * 9,350-character story beat went to OpenAI as one request:
 *
 *   Input of 2212 tokens is over the maximum input limit of 2000 tokens.
 *
 * after the research, the script and the performance pass had all been paid
 * for. The renderer knew the limit and sent the beat anyway.
 */
describe('splitForSynthesis', () => {
  const sentence = (n: number) => `This is sentence number ${n} and it runs on a little. `;
  const long = Array.from({ length: 200 }, (_, i) => sentence(i)).join('');

  it('leaves anything already under the limit alone', () => {
    expect(splitForSynthesis('Short enough.', 6000)).toEqual(['Short enough.']);
  });

  it('does nothing when the engine declares no limit', () => {
    expect(splitForSynthesis(long, 0)).toEqual([long]);
  });

  it('keeps every piece under the limit', () => {
    const pieces = splitForSynthesis(long, 6000);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(6000);
  });

  it('loses no words', () => {
    const words = (s: string) => s.split(/\s+/).filter(Boolean);
    const pieces = splitForSynthesis(long, 6000);

    expect(words(pieces.join(' '))).toEqual(words(long));
  });

  it('cuts on sentence endings, not mid-sentence', () => {
    // A cut inside a sentence is audible: the voice drops as if the sentence
    // had finished, then starts the rest of it cold. Avoiding that is the
    // whole reason the grouping apparatus exists.
    for (const piece of splitForSynthesis(long, 6000)) {
      expect(piece.trimEnd()).toMatch(/[.!?]$/);
    }
  });

  it('handles the real beat that broke the render', () => {
    // 9,350 characters against a 6,000-character budget.
    const real = Array.from({ length: 100 }, (_, i) =>
      `She reached the ${i}th gate and something was taken from her there. `
    ).join('');
    expect(real.length).toBeGreaterThan(6000);

    const pieces = splitForSynthesis(real, 6000);
    expect(pieces.length).toBe(2);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(6000);
  });

  it('falls back to a word boundary for one unsplittable sentence', () => {
    // Ugly, and still better than a failed render.
    const monster = `${'word '.repeat(3000)}end.`;
    const pieces = splitForSynthesis(monster, 6000);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(6000);
    expect(pieces.join(' ').split(/\s+/).filter(Boolean)).toHaveLength(3001);
  });
})
