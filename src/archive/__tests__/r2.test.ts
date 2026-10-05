import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import { finalAudioFor } from '../../render/backing';
import { ArchiveStore, archiveRun, runKey, sweepArchive } from '../r2';
import { archivedOwner, readArchive } from '../record';

const FIXTURE = path.join(__dirname, '..', '..', 'publish', '__tests__', 'fixtures', 'story-single-short');
const RUN_ID = 'root-health/e001-20261005-sleep-loss-makes-unhealthy-food-look';

/** R2 in memory. `lose` makes it report a key as missing, as a failed upload would. */
const memoryStore = (lose: string[] = []): ArchiveStore & { objects: Map<string, Buffer> } => {
  const objects = new Map<string, Buffer>();
  return {
    bucket: 'test-archive',
    objects,
    put: async (key, body) => void objects.set(key, body),
    size: async (key) => (lose.some((l) => key.endsWith(l)) ? null : objects.get(key)?.length ?? null),
    url: async (key) => `https://r2.example/${key}`,
  };
};

describe('the rolling archive to R2', () => {
  let root: string;
  let run: Run;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-'));
    fs.cpSync(FIXTURE, root, { recursive: true });
    process.env.FOUNDRY_RUNS_DIR = root;
    run = Run.open(RUN_ID, { root });
    fs.writeFileSync(path.join(run.dir, 'publish.json'), JSON.stringify({ audioId: 'a-1', publishedAt: '2026-10-05T11:33:08Z' }));
    run.markComplete('publish');
  });
  afterEach(() => {
    delete process.env.FOUNDRY_RUNS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('uploads every file, writes the history entry, then removes only the audio', async () => {
    const store = memoryStore();
    const record = await archiveRun(run, { store });

    expect(store.objects.has(runKey(RUN_ID, 'script.json'))).toBe(true);
    expect(store.objects.has(runKey(RUN_ID, 'media/episode.wav'))).toBe(true);
    const index = JSON.parse(store.objects.get(`index/${RUN_ID}.json`)!.toString());
    expect(index).toMatchObject({ channel: 'root-health', audioId: 'a-1' });

    expect(record!.removed).toEqual(['media/episode.wav']);
    expect(fs.existsSync(path.join(run.dir, 'media/episode.wav'))).toBe(false);
    // The text stays, so pages and history work.
    expect(fs.existsSync(path.join(run.dir, 'script.json'))).toBe(true);
    expect(readArchive(run.dir)?.bucket).toBe('test-archive');
  });

  it('still knows where the audio is once it is gone', async () => {
    await archiveRun(run, { store: memoryStore() });
    const reopened = Run.open(RUN_ID, { root });
    expect(reopened.audioFile()).toBe(path.join(reopened.dir, 'media', 'episode.wav'));
    expect(finalAudioFor(reopened)?.file).toBe(path.join(reopened.dir, 'media', 'episode.wav'));
    // The file server maps the missing file to its R2 key.
    expect(archivedOwner(path.join(reopened.dir, 'media', 'episode.wav'))?.rel).toBe('media/episode.wav');
  });

  it('removes nothing when R2 does not confirm a file', async () => {
    await expect(archiveRun(run, { store: memoryStore(['episode.wav']) })).rejects.toThrow(/nothing was removed/);
    expect(fs.existsSync(path.join(run.dir, 'media/episode.wav'))).toBe(true);
    expect(readArchive(run.dir)).toBeNull();
  });

  it('leaves an unpublished run alone, and archives each run once', async () => {
    const store = memoryStore();
    run.uncomplete('publish');
    expect(await archiveRun(run, { store })).toBeNull();
    expect(store.objects.size).toBe(0);

    run.markComplete('publish');
    expect((await sweepArchive({ store })).archived).toEqual([RUN_ID]);
    expect((await sweepArchive({ store })).archived).toEqual([]);
  });
});
