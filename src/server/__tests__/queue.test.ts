import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import { getQueue } from '../queue';

const FIXTURE = path.join(__dirname, '..', '..', 'publish', '__tests__', 'fixtures', 'story-single-short');
const RUN_ID = 'root-health/e001-20261005-sleep-loss-makes-unhealthy-food-look';

describe('the main page sorts a finished run the way the publishing page does', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-'));
    fs.cpSync(FIXTURE, root, { recursive: true });
    process.env.FOUNDRY_RUNS_DIR = root;
  });
  afterEach(() => {
    delete process.env.FOUNDRY_RUNS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const where = (q: ReturnType<typeof getQueue>) =>
    (['ready', 'dueToPublish', 'scheduled'] as const).filter((k) => q[k].some((r) => r.id === RUN_ID));

  it('is "to decide" until approved, "lined up" when approved for later, "due" when its time comes', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    // The fixture was taken after it had been approved: start from undecided.
    const run = Run.open(RUN_ID, { root });
    run.setReleaseAt(null);
    expect(where(getQueue(now))).toEqual(['ready']);

    run.setReleaseAt(new Date('2026-10-08T07:00:00Z'), now);
    expect(where(getQueue(now))).toEqual(['scheduled']);

    expect(where(getQueue(new Date('2026-10-09T07:00:00Z')))).toEqual(['dueToPublish']);
  });
});
