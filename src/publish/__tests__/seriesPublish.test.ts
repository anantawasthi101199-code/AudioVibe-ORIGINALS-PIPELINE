/**
 * AN EPISODE PUBLISHES INTO ITS SERIES. The first episode of a series creates
 * it on AudioVibe and goes into it; the next one in the same series joins the
 * same shelf rather than starting another.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const registry = new Map<string, { seriesId: string; title: string; apiUrl: string; createdAt: string }>();
jest.mock('../seriesRegistry', () => {
  const actual = jest.requireActual('../seriesRegistry');
  return {
    ...actual,
    findSeries: (key: string) => registry.get(key) ?? null,
    recordSeries: (key: string, record: never) => void registry.set(key, record),
  };
});
jest.mock('../account', () => ({ publishTokenFor: () => 'test-token' }));
jest.mock('../../art/cover', () => {
  const actual = jest.requireActual('../../art/cover');
  return { ...actual, renderCover: (_spec: unknown, out: string) => out };
});

const createSeries = jest.fn(async (input: { title: string }) => ({ seriesId: 'series-42', title: input.title }));
const publish = jest.fn(async (_input: { seriesId?: string; title: string }) => ({ audioId: `audio-${publish.mock.calls.length}`, status: 'processing' }));
const coverOf = jest.fn(async (_id: string): Promise<string | null | undefined> => 'https://cdn.example.com/c.webp');
const deleteAudio = jest.fn(async () => undefined);
jest.mock('../account', () => ({
  ...jest.requireActual('../account'),
  loadAccounts: () => ({ 'root-health': { email: 'e', password: 'p' } }),
  PlatformAccounts: jest.fn().mockImplementation(() => ({ signInAsChannel: jest.fn(async () => undefined), deleteAudio })),
}));
jest.mock('../ingest', () => {
  const actual = jest.requireActual('../ingest');
  return {
    ...actual,
    AudioVibeClient: jest.fn().mockImplementation(() => ({ createSeries, publish, coverOf })),
  };
});

import { Run } from '../../run/store';
import { publishRun } from '../publishRun';

const FIXTURE = path.join(__dirname, 'fixtures', 'story-single-short');
const SOURCE = 'root-health/e001-20261005-sleep-loss-makes-unhealthy-food-look';

describe('publishing an episode into its series', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'series-pub-'));
    process.env.FOUNDRY_RUNS_DIR = root;
    process.env.AUDIOVIBE_API_URL = 'https://staging.example.com';
    registry.clear();
    createSeries.mockClear();
    publish.mockClear();
    coverOf.mockClear();
    deleteAudio.mockClear();
  });
  afterEach(() => {
    delete process.env.FOUNDRY_RUNS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A copy of a real run, made into an episode of the named series. */
  const episode = (folder: string) => {
    const dir = path.join(root, 'root-health', folder);
    fs.cpSync(path.join(FIXTURE, SOURCE), dir, { recursive: true });
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    Object.assign(m, { id: `root-health/${folder}`, formatId: 'what-we-know', seriesTitle: "Let's Explore the Brain" });
    m.completed = (m.completed as string[]).filter((s) => s !== 'publish');
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(m));
    return Run.open(`root-health/${folder}`, { root });
  };
  const gate = { passed: true, findings: [], needsHumanReview: false, humanReviewReasons: [] } as never;

  it('creates the series once, and both episodes go into it', async () => {
    const first = await publishRun(episode('e001-20261005-dreams'), gate, { confirmed: true });
    const second = await publishRun(episode('e002-20261006-sleep-and-memory'), gate, { confirmed: true });

    expect(createSeries).toHaveBeenCalledTimes(1);
    expect(createSeries.mock.calls[0]![0]).toMatchObject({ title: "Let's Explore the Brain" });
    expect(publish.mock.calls.map((c) => c[0].seriesId)).toEqual(['series-42', 'series-42']);
    expect([first.seriesId, second.seriesId]).toEqual(['series-42', 'series-42']);
  });

  it('takes the audio down and stays unpublished when the platform lost the cover', async () => {
    coverOf.mockResolvedValueOnce(null);
    const run = episode('e003-20261007-no-picture');
    await expect(publishRun(run, gate, { confirmed: true })).rejects.toThrow(/lost the cover/);
    expect(deleteAudio).toHaveBeenCalledWith('audio-1');
    expect(fs.existsSync(path.join(run.dir, 'publish.json'))).toBe(false);
  });

  it('waits out a queued upload, then publishes', async () => {
    process.env.FOUNDRY_COVER_CHECK_MS = '1';
    coverOf.mockResolvedValueOnce(undefined);
    await expect(publishRun(episode('e004-20261008-queued'), gate, { confirmed: true })).resolves.toBeTruthy();
    expect(coverOf).toHaveBeenCalledTimes(2);
  });
});
