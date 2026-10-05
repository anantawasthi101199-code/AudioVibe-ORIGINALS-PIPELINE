import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import { rescheduleRelease } from '../operate';

describe('moving a scheduled run', () => {
  const NOW = new Date('2026-10-05T10:00:00Z');
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'resched-'));
    process.env.FOUNDRY_RUNS_DIR = root;
  });
  afterEach(() => {
    delete process.env.FOUNDRY_RUNS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const scheduled = () => {
    const run = Run.create({ personaId: 'eureka-tales', formatId: 'science-short', topic: 'Velcro' }, { root });
    run.setReleaseAt(new Date('2026-10-09T16:00:00Z'), NOW);
    return Run.open(run.id, { root });
  };

  it('reads the time on the London clock and keeps the approval', () => {
    const run = scheduled();
    // 18:00 in October is British Summer Time, so 17:00 UTC.
    const out = rescheduleRelease(run.id, { wall: '2026-10-08T18:00' }, NOW);
    expect(out.releaseAt).toBe('2026-10-08T17:00:00.000Z');
    expect(Run.open(run.id, { root }).manifest.releaseApprovedAt).toBeDefined();
  });

  it('refuses a time already gone and a run that is not scheduled', () => {
    const run = scheduled();
    expect(() => rescheduleRelease(run.id, { wall: '2026-10-01T09:00' }, NOW)).toThrow(/already passed/);
    run.setReleaseAt(null);
    expect(() => rescheduleRelease(run.id, { wall: '2026-10-08T18:00' }, NOW)).toThrow(/not scheduled/);
  });
});
