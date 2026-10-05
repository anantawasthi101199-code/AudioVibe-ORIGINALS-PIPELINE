import fs from 'fs';
import os from 'os';
import path from 'path';

const registry = new Map<string, unknown>();
jest.mock('../../publish/seriesRegistry', () => {
  const actual = jest.requireActual('../../publish/seriesRegistry');
  return { ...actual, findSeries: (key: string) => registry.get(key) ?? null };
});

import { Run } from '../../run/store';
import { renameSeries } from '../operate';
import { saveScript } from '../routes';

const FIXTURE = path.join(__dirname, '..', '..', 'publish', '__tests__', 'fixtures', 'story-single-short');
const RUN_ID = 'root-health/e001-20261005-sleep-loss-makes-unhealthy-food-look';

describe('editing what listeners see', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'title-'));
    fs.cpSync(FIXTURE, root, { recursive: true });
    process.env.FOUNDRY_RUNS_DIR = root;
    process.env.AUDIOVIBE_API_URL = 'https://staging.example.com';
    registry.clear();
  });
  afterEach(() => {
    delete process.env.FOUNDRY_RUNS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('changes the title without discarding the voiced audio, and not after publishing', () => {
    const run = Run.open(RUN_ID, { root });
    run.uncomplete('publish');
    const script = JSON.parse(fs.readFileSync(path.join(run.dir, 'script.json'), 'utf8'));
    const out = saveScript(RUN_ID, { title: 'A Better Title', description: script.description, beats: script.beats });
    expect(out.audioStale).toBe(false);
    expect(Run.open(RUN_ID, { root }).hasArtifact('render')).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(run.dir, 'script.json'), 'utf8')).title).toBe('A Better Title');

    Run.open(RUN_ID, { root }).markComplete('publish');
    expect(() => saveScript(RUN_ID, { title: 'Too late', description: 'x', beats: script.beats })).toThrow(/already published/);
  });

  it('renames a series on its episodes, and refuses once it is on AudioVibe', () => {
    const ep = Run.create({ personaId: 'mythic-archives', formatId: 'myth-story', topic: 'Hero Twins', seriesTitle: 'Maya Myths' }, { root });
    expect(renameSeries('mythic-archives', { from: 'Maya Myths', to: 'Maya Mythology' }).renamed).toBe(1);
    expect(Run.open(ep.id, { root }).manifest.seriesTitle).toBe('Maya Mythology');

    registry.set('mythic-archives#maya-mythology', { seriesId: 's-1' });
    expect(() => renameSeries('mythic-archives', { from: 'Maya Mythology', to: 'Other' })).toThrow(/already on AudioVibe/);
  });
});
