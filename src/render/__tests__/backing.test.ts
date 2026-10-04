import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import {
  checkLoop,
  chooseMix,
  clearMix,
  finalAudioFor,
  saveTrackLoop,
  looksLikeMp3,
  mixRun,
  mixState,
  mixedAudioFor,
  saveTrack,
  trackSlug,
  unchooseMix,
} from '../backing';

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);

describe('your own background music', () => {
  let root: string;
  let run: Run;
  let graphs: string[];

  // A stand-in ffmpeg: records the filter graph and writes the output file.
  const fakeFfmpeg = async (_bin: string, args: string[]) => {
    graphs.push(args[args.indexOf('-filter_complex') + 1]!);
    fs.writeFileSync(args[args.length - 1]!, 'mixed');
    return { code: 0, stdout: '', stderr: '' };
  };
  const deps = { run: fakeFfmpeg, probe: async () => 120 };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'backing-'));
    process.env.FOUNDRY_MUSIC_DIR = path.join(root, 'music');
    run = Run.create({ personaId: 'business-decoded', formatId: 'biz-short', topic: 'Zara' }, { root });
    fs.writeFileSync(run.mediaPath('episode.wav'), 'voice');
    graphs = [];
    saveTrack('Calm Piano', MP3);
  });
  afterAll(() => delete process.env.FOUNDRY_MUSIC_DIR);

  it('takes only an actual mp3, whatever the file is called', () => {
    expect(looksLikeMp3(MP3)).toBe(true);
    expect(looksLikeMp3(Buffer.from('%PDF-1.7'))).toBe(false);
    expect(() => saveTrack('song.mp3', Buffer.from('not audio'))).toThrow(/not an mp3/);
    expect(trackSlug('Calm Piano (Loop).mp3')).toBe('calm-piano-loop');
  });

  it('mixes at the chosen level, ducked under speech unless asked not to', async () => {
    await mixRun(run, { track: 'calm-piano', volume: 25, duck: true }, deps);
    expect(graphs[0]).toContain('volume=0.250');
    expect(graphs[0]).toContain('sidechaincompress');

    await mixRun(run, { track: 'calm-piano', volume: 10, duck: false }, deps);
    expect(graphs[1]).toContain('volume=0.100');
    expect(graphs[1]).not.toContain('sidechaincompress');
    expect(mixState(run).preview).toMatchObject({ track: 'calm-piano', volume: 10, duck: false });
  });

  it('NEVER changes what publishes just by mixing: only "use this version" does', async () => {
    await mixRun(run, { track: 'calm-piano', volume: 15, duck: true }, deps);
    expect(mixedAudioFor(run)).toBeNull();

    const used = chooseMix(run);
    expect(mixedAudioFor(run)).toBe(run.mediaPath(used.file));

    // Trying another level replaces the preview and leaves the choice alone.
    await tick();
    await mixRun(run, { track: 'calm-piano', volume: 40, duck: true }, deps);
    expect(mixState(run).chosen?.volume).toBe(15);
    expect(mixState(run).preview?.volume).toBe(40);
    expect(mixedAudioFor(run)).toBe(run.mediaPath(used.file));
    expect(fs.existsSync(run.mediaPath(used.file))).toBe(true);

    unchooseMix(run);
    expect(mixedAudioFor(run)).toBeNull();
  });

  it('publishes the chosen mix only while it matches the voice it was made from', async () => {
    await mixRun(run, { track: 'calm-piano', volume: 15, duck: true }, deps);
    chooseMix(run);
    // Re-voiced: the choice is stale and the voice goes out instead.
    fs.writeFileSync(run.mediaPath('episode.wav'), 'a new, longer voice track');
    expect(mixState(run).chosenStale).toBe(true);
    expect(mixedAudioFor(run)).toBeNull();
    expect(() => chooseMix(run)).toThrow(/voiced again/);

    clearMix(run);
    expect(mixState(run)).toEqual({ preview: null, chosen: null, previewStale: false, chosenStale: false });
  });

  it('reads a mix from before choosing existed as a preview, not as a choice', () => {
    fs.writeFileSync(run.mediaPath('episode.mixed.wav'), 'mixed');
    fs.writeFileSync(
      run.mediaPath('mix.json'),
      JSON.stringify({ track: 'calm-piano', volume: 15, duck: true, voiceBytes: 5, voiceMtimeMs: 0, mixedAt: 'x' })
    );
    expect(mixState(run).preview?.file).toBe('episode.mixed.wav');
    expect(mixedAudioFor(run)).toBeNull();
  });

  it('gives every page one final audio: the chosen mix, else the voice', async () => {
    expect(finalAudioFor(run)).toMatchObject({ file: run.mediaPath('episode.wav'), music: null });
    await mixRun(run, { track: 'calm-piano', volume: 20, duck: true }, deps);
    // A preview is not final.
    expect(finalAudioFor(run)?.music).toBeNull();
    const before = finalAudioFor(run)!.key;
    const used = chooseMix(run);
    const after = finalAudioFor(run)!;
    expect(after).toMatchObject({ file: run.mediaPath(used.file), music: { track: 'calm-piano', volume: 20 } });
    // The key changes, so every player on every page reloads it.
    expect(after.key).not.toBe(before);
  });

  it('LOCKS the music once approved for release or published', async () => {
    await mixRun(run, { track: 'calm-piano', volume: 20, duck: true }, deps);
    chooseMix(run);
    run.setReleaseAt(new Date('2026-10-10T10:00:00Z'), new Date());
    expect(() => unchooseMix(run)).toThrow(/approved for release/);
    expect(() => chooseMix(run)).toThrow(/approved for release/);
    expect(() => clearMix(run)).toThrow(/approved for release/);
    expect(mixedAudioFor(run)).not.toBeNull();

    // Back to To decide: changeable again.
    run.setReleaseAt(null);
    unchooseMix(run);
    expect(mixedAudioFor(run)).toBeNull();

    run.markComplete('publish');
    expect(() => chooseMix(run)).toThrow(/already published/);
  });

  it('repeats only the chosen section: this episode first, else the saved loop of the track', async () => {
    const probe = async () => 60;
    await saveTrackLoop('calm-piano', { start: 10, end: 20 }, probe);

    await mixRun(run, { track: 'calm-piano', volume: 20, duck: true }, deps);
    expect(mixState(run).preview?.loop).toEqual({ start: 10, end: 20 });
    // The loop unit is cut first (one ffmpeg call), then mixed under the voice.
    expect(graphs.some((g) => g.includes('atrim=start=10.000:end=20.000'))).toBe(true);

    await mixRun(run, { track: 'calm-piano', volume: 20, duck: true, loop: { start: 30, end: 42 } }, deps);
    expect(mixState(run).preview?.loop).toEqual({ start: 30, end: 42 });

    await mixRun(run, { track: 'calm-piano', volume: 20, duck: true, loop: null }, deps);
    expect(mixState(run).preview?.loop).toBeUndefined();
  });

  it('changes the speed of the section without changing its pitch', async () => {
    await mixRun(run, { track: 'calm-piano', volume: 20, duck: true, loop: { start: 10, end: 20, speed: 1.5 } }, deps);
    expect(graphs.some((g) => g.includes('atempo=1.500'))).toBe(true);
    expect(mixState(run).preview?.loop).toEqual({ start: 10, end: 20, speed: 1.5 });
    expect(() => checkLoop({ start: 0, end: 10, speed: 3 })).toThrow(/between 0.5x and 2x/);
    // Long enough once sped up, not before.
    expect(() => checkLoop({ start: 0, end: 3, speed: 2 })).toThrow(/play for at least 2 seconds/);
  });

  it('refuses a loop too short to blend, or past the end of the track', async () => {
    expect(() => checkLoop({ start: 5, end: 6 })).toThrow(/at least 2 seconds/);
    expect(() => checkLoop({ start: 9, end: 5 })).toThrow(/end after it starts/);
    await expect(saveTrackLoop('calm-piano', { start: 50, end: 70 }, async () => 60)).rejects.toThrow(/after the track does/);
  });

  it('refuses a run with no audio, a track not in the library, and choosing nothing', async () => {
    expect(() => chooseMix(run)).toThrow(/no mix to use/);
    await expect(mixRun(run, { track: 'missing', volume: 10, duck: true }, deps)).rejects.toThrow(/no track/);
    fs.rmSync(run.mediaPath('episode.wav'));
    await expect(mixRun(run, { track: 'calm-piano', volume: 10, duck: true }, deps)).rejects.toThrow(/no audio yet/);
  });
});
