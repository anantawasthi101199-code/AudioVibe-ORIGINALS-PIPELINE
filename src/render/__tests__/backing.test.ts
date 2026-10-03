import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import {
  clearMix,
  looksLikeMp3,
  mixRun,
  mixState,
  mixedAudioFor,
  saveTrack,
  trackSlug,
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

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'backing-'));
    process.env.FOUNDRY_MUSIC_DIR = path.join(root, 'music');
    run = Run.create({ personaId: 'business-decoded', formatId: 'biz-short', topic: 'Zara' }, { root });
    fs.writeFileSync(run.mediaPath('episode.wav'), 'voice');
    graphs = [];
  });
  afterAll(() => delete process.env.FOUNDRY_MUSIC_DIR);

  it('takes only an actual mp3, whatever the file is called', () => {
    expect(looksLikeMp3(MP3)).toBe(true);
    expect(looksLikeMp3(Buffer.from('%PDF-1.7'))).toBe(false);
    expect(() => saveTrack('song.mp3', Buffer.from('not audio'))).toThrow(/not an mp3/);
    expect(trackSlug('Calm Piano (Loop).mp3')).toBe('calm-piano-loop');
  });

  it('mixes at the chosen level, ducked under speech unless asked not to', async () => {
    saveTrack('Calm Piano', MP3);
    await mixRun(run, { track: 'calm-piano', volume: 25, duck: true }, deps);
    expect(graphs[0]).toContain('volume=0.250');
    expect(graphs[0]).toContain('sidechaincompress');

    await mixRun(run, { track: 'calm-piano', volume: 10, duck: false }, deps);
    expect(graphs[1]).toContain('volume=0.100');
    expect(graphs[1]).not.toContain('sidechaincompress');
    expect(mixState(run).mix).toMatchObject({ track: 'calm-piano', volume: 10, duck: false });
  });

  it('publishes the mix only while it matches the voice it was made from', async () => {
    saveTrack('calm-piano', MP3);
    await mixRun(run, { track: 'calm-piano', volume: 15, duck: true }, deps);
    expect(mixedAudioFor(run)).toBe(run.mediaPath('episode.mixed.wav'));

    // Re-voiced: the old mix is stale and the voice goes out instead.
    fs.writeFileSync(run.mediaPath('episode.wav'), 'a new, longer voice track');
    expect(mixState(run).stale).toBe(true);
    expect(mixedAudioFor(run)).toBeNull();

    clearMix(run);
    expect(mixState(run)).toEqual({ mix: null, stale: false });
  });

  it('refuses a run with no audio, and a track that is not in the library', async () => {
    fs.rmSync(run.mediaPath('episode.wav'));
    await expect(mixRun(run, { track: 'x', volume: 10, duck: true }, deps)).rejects.toThrow(/no audio yet/);
    fs.writeFileSync(run.mediaPath('episode.wav'), 'voice');
    await expect(mixRun(run, { track: 'missing', volume: 10, duck: true }, deps)).rejects.toThrow(/no track/);
  });
});
