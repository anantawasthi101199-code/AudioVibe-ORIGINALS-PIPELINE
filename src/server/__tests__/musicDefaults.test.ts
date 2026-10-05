import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import { defaultFor, musicDefaults, setMusicDefault } from '../music';

describe("a channel's default music for shorts", () => {
  let dir: string;
  let root: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-'));
    process.env.FOUNDRY_MUSIC_DIR = dir;
    // A track in the library, as an upload would leave it.
    fs.writeFileSync(path.join(dir, 'patterns-of-discovery.mp3'), Buffer.from('ID3'));
  });
  afterEach(() => {
    delete process.env.FOUNDRY_MUSIC_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  const settings = { track: 'patterns-of-discovery', volume: 5, duck: false, loop: { start: 0.6, end: 6.6, speed: 0.8 } };

  it('is saved per channel and offered on that channel\'s shorts only', () => {
    setMusicDefault('eureka-tales', settings);
    expect(musicDefaults()['eureka-tales']?.short?.track).toBe('patterns-of-discovery');

    const short = Run.create({ personaId: 'eureka-tales', formatId: 'science-short', topic: 'Velcro' }, { root });
    expect(defaultFor(short)).toMatchObject(settings);

    const other = Run.create({ personaId: 'root-health', formatId: 'health-short', topic: 'Sleep' }, { root });
    expect(defaultFor(other)).toBeNull();
  });

  it('refuses a track that is not in the library', async () => {
    await expect(setMusicDefault('eureka-tales', { ...settings, track: 'nope' })).rejects.toThrow(/no track called/);
  });
});
