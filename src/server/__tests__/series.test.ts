import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import { setRunSeries } from '../operate';

describe('every episode belongs to a series', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'series-'));
    process.env.FOUNDRY_RUNS_DIR = root;
    process.env.FOUNDRY_CATALOGUE_FILE = path.join(root, 'catalogue.json');
  });
  afterEach(() => {
    delete process.env.FOUNDRY_RUNS_DIR;
    delete process.env.FOUNDRY_CATALOGUE_FILE;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses to start an episode with no series, and never asks a short for one', async () => {
    // Loaded here so it reads this test's runs folder.
    const { startRun } = await import('../routes');
    expect(() =>
      startRun({ channelId: 'mythic-archives', formatId: 'myth-story', topic: 'Perseus and Medusa', blank: true })
    ).toThrow(/needs a series/);

    const ep = startRun({
      channelId: 'mythic-archives',
      formatId: 'myth-story',
      topic: 'Perseus and Medusa',
      blank: true,
      seriesTitle: 'Greek Mythology',
    });
    expect(Run.open(ep.runId).manifest.seriesTitle).toBe('Greek Mythology');

    const short = startRun({ channelId: 'mythic-archives', formatId: 'myth-short', topic: 'Maui snares the sun', blank: true });
    expect(Run.open(short.runId).manifest.seriesTitle).toBeUndefined();
  });

  it('can be moved to another series until it is published', () => {
    const run = Run.create({ personaId: 'mythic-archives', formatId: 'myth-story', topic: 'Hero Twins' }, { root });
    setRunSeries(run.id, { seriesTitle: 'Maya Mythology' });
    expect(Run.open(run.id, { root }).manifest.seriesTitle).toBe('Maya Mythology');

    run.markComplete('publish');
    expect(() => setRunSeries(run.id, { seriesTitle: 'Other' })).toThrow(/already published/);
  });
});
