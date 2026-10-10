import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import { PlatformAccounts } from '../account';
import { prepareRevoice, replacedAudio, retireReplaced } from '../revoice';

describe('re-voicing a published run', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'revoice-'));
    process.env.FOUNDRY_RUNS_DIR = root;
    const accounts = path.join(root, 'accounts.json');
    fs.writeFileSync(
      accounts,
      JSON.stringify({
        'eureka-tales': {
          username: 'eurekatales', email: 'e@x', password: 'p', userId: 'u', createdAt: '2026-10-01T00:00:00Z', isAi: true,
        },
      })
    );
    process.env.FOUNDRY_ACCOUNTS_FILE = accounts;
  });
  afterEach(() => {
    delete process.env.FOUNDRY_RUNS_DIR;
    delete process.env.FOUNDRY_ACCOUNTS_FILE;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const published = () => {
    const run = Run.create({ personaId: 'eureka-tales', formatId: 'science-short', topic: 'Velcro' }, { root });
    run.writeArtifact('script', { title: 'The Burdock Burrs', beats: [] });
    run.writeArtifact('publish', { audioId: 'old-audio', publishedAt: '2026-10-05T19:06:19Z' });
    run.markComplete('render');
    run.markComplete('publish');
    fs.writeFileSync(run.mediaPath('01-story.mp3'), 'gpt beat');
    fs.writeFileSync(run.mediaPath('cover.supplied.png'), 'picture');
    fs.writeFileSync(path.join(run.dir, 'archive.json'), JSON.stringify({ files: { 'media/episode.wav': 1 } }));
    return Run.open(run.id, { root });
  };

  it('retires the old archive record, so the studio plays the new voice and not the archived one', () => {
    const run = published();
    prepareRevoice(run, { tag: 'revoiced-eleven' });
    expect(fs.existsSync(path.join(run.dir, 'archive.json'))).toBe(false);
    expect(fs.existsSync(path.join(run.dir, 'archive.previous.json'))).toBe(true);
  });

  it('prepares without touching the live audio, keeping script and picture, tagged, on ElevenLabs', () => {
    const run = published();
    prepareRevoice(run, { tag: 'revoiced-eleven' });
    const again = Run.open(run.id, { root });

    expect(replacedAudio(again)?.audioId).toBe('old-audio');
    expect(again.isComplete('publish')).toBe(false);
    expect(again.isComplete('render')).toBe(false);
    expect(again.manifest.voiceEngine).toBe('elevenlabs');
    expect(again.manifest.tag).toBe('revoiced-eleven');
    expect(again.hasArtifact('script')).toBe(true);
    expect(fs.readdirSync(path.join(again.dir, 'media'))).toEqual(['cover.supplied.png']);
    expect(() => prepareRevoice(again, { tag: 'x' })).toThrow(/already waiting/);
  });

  it('retires the old audio as the channel, and keeps a record of what it replaced', async () => {
    const run = published();
    prepareRevoice(run, { tag: 'revoiced-eleven' });
    const deleted: string[] = [];
    const accounts = {
      signInAsChannel: async () => 'token',
      deleteAudio: async (id: string) => void deleted.push(id),
    } as unknown as PlatformAccounts;

    const out = await retireReplaced(Run.open(run.id, { root }), { accounts });
    expect(out).toEqual({ audioId: 'old-audio', removed: true });
    expect(deleted).toEqual(['old-audio']);
    expect(replacedAudio(Run.open(run.id, { root }))).toBeNull();
    expect(fs.existsSync(path.join(run.dir, 'replaced.json'))).toBe(true);
  });
});
