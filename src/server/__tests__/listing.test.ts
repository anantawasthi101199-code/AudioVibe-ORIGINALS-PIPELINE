import fs from 'fs';
import os from 'os';
import path from 'path';

const updateListing = jest.fn(async (_id: string, _l: { title: string; description: string }) => undefined);
jest.mock('../../publish/ingest', () => {
  const actual = jest.requireActual('../../publish/ingest');
  return { ...actual, AudioVibeClient: jest.fn().mockImplementation(() => ({ updateListing })) };
});
jest.mock('../../publish/account', () => ({ publishTokenFor: () => 'test-token' }));

import { Run } from '../../run/store';
import { setListing } from '../operate';

const FIXTURE = path.join(__dirname, '..', '..', 'publish', '__tests__', 'fixtures', 'story-single-short');
const RUN_ID = 'root-health/e001-20261005-sleep-loss-makes-unhealthy-food-look';

describe('what listeners see', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-'));
    fs.cpSync(FIXTURE, root, { recursive: true });
    process.env.FOUNDRY_RUNS_DIR = root;
    process.env.AUDIOVIBE_API_URL = 'https://staging.example.com';
    updateListing.mockReset();
  });
  afterEach(() => {
    delete process.env.FOUNDRY_RUNS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const title = () => JSON.parse(fs.readFileSync(path.join(root, RUN_ID, 'script.json'), 'utf8')).title;

  it('keeps the description short', async () => {
    const long = Array.from({ length: 51 }, () => 'word').join(' ');
    await expect(setListing(RUN_ID, { title: 'T', description: long })).rejects.toThrow(/51 words; keep it to 50/);
  });

  it('saves here before publishing, without asking AudioVibe', async () => {
    Run.open(RUN_ID, { root }).uncomplete('publish');
    await setListing(RUN_ID, { title: 'New title', description: 'Short.' });
    expect(updateListing).not.toHaveBeenCalled();
    expect(title()).toBe('New title');
  });

  it('after publishing, changes it on AudioVibe first, and saves nothing if that fails', async () => {
    const run = Run.open(RUN_ID, { root });
    run.markComplete('publish');
    fs.writeFileSync(path.join(run.dir, 'publish.json'), JSON.stringify({ audioId: 'audio-9', status: 'ok', publishedAt: 'x', url: 'y' }));

    await setListing(RUN_ID, { title: 'On the app', description: 'Short.' });
    expect(updateListing).toHaveBeenCalledWith('audio-9', { title: 'On the app', description: 'Short.' });
    expect(title()).toBe('On the app');

    updateListing.mockRejectedValueOnce(new Error('404 Not found'));
    await expect(setListing(RUN_ID, { title: 'Refused', description: 'Short.' })).rejects.toThrow(/nothing was saved/);
    expect(title()).toBe('On the app');
  });
});
