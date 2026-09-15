/**
 * What is allowed to publish without being asked.
 *
 * THE ONLY UNATTENDED WRITE IN THIS STUDIO, so what is pinned here is what it
 * REFUSES rather than what it does. Every one of these is a way an episode
 * could go out that nobody meant: no approval, approval that was withdrawn,
 * a date that has not come, a script edited into failing since it was approved.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import { dueForRelease } from '../release';

const ROOT = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'release-'));

describe('approving and withdrawing', () => {
  let root: string;
  beforeEach(() => {
    root = ROOT();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const make = () =>
    Run.create({ personaId: 'honest-health', formatId: 'what-we-know', topic: 'x' }, { root });

  it('records the decision separately from the date', () => {
    // A date is a plan; the approval is somebody saying yes. Something that
    // publishes on its own must be able to say who allowed it and when, and
    // "it had a date on it" is not that.
    const run = make();
    const at = new Date('2026-09-20T07:00:00Z');
    const approved = new Date('2026-09-16T12:00:00Z');

    run.setReleaseAt(at, approved);

    const reopened = Run.open(run.id, { root });
    expect(reopened.manifest.releaseAt).toBe(at.toISOString());
    expect(reopened.manifest.releaseApprovedAt).toBe(approved.toISOString());
  });

  it('gives a date without approving, when nobody said yes', () => {
    const run = make();
    run.setReleaseAt(new Date('2026-09-20T07:00:00Z'));

    expect(Run.open(run.id, { root }).manifest.releaseAt).toBeDefined();
    expect(Run.open(run.id, { root }).manifest.releaseApprovedAt).toBeUndefined();
  });

  it('WITHDRAWS THE APPROVAL when the date is cleared', () => {
    // Otherwise an approval outlives the plan it was given for, and a run
    // somebody took off the schedule goes out the next time it is put back on
    // without being asked again.
    const run = make();
    run.setReleaseAt(new Date('2026-09-20T07:00:00Z'), new Date());
    run.setReleaseAt(null);

    const reopened = Run.open(run.id, { root });
    expect(reopened.manifest.releaseAt).toBeUndefined();
    expect(reopened.manifest.releaseApprovedAt).toBeUndefined();
  });
});

describe('dueForRelease', () => {
  /**
   * Run against a runs directory of its own, so this never sees the real
   * catalogue and can never publish any of it. `runsDir()` reads the variable
   * on every call, so setting it here is enough - the module does not capture
   * it at import.
   */
  const withRuns = <T>(fn: (root: string) => T): T => {
    const root = ROOT();
    const before = process.env.FOUNDRY_RUNS_DIR;
    process.env.FOUNDRY_RUNS_DIR = root;
    try {
      return fn(root);
    } finally {
      if (before === undefined) delete process.env.FOUNDRY_RUNS_DIR;
      else process.env.FOUNDRY_RUNS_DIR = before;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  it('ignores a run nobody approved, however old its date', () => {
    withRuns((root) => {
      const run = Run.create(
        { personaId: 'honest-health', formatId: 'what-we-know', topic: 'x' },
        { root }
      );
      run.setReleaseAt(new Date('2020-01-01T00:00:00Z'));

      const plan = dueForRelease(new Date('2026-09-16T12:00:00Z'));
      expect(plan.due).toEqual([]);
      // Not "held" either: most runs are in this state and listing them would
      // bury the ones that are actually stuck.
      expect(plan.held).toEqual([]);
    });
  });

  it('ignores an approved run whose time has not come', () => {
    withRuns((root) => {
      const run = Run.create(
        { personaId: 'honest-health', formatId: 'what-we-know', topic: 'x' },
        { root }
      );
      run.setReleaseAt(new Date('2026-09-20T07:00:00Z'), new Date());

      expect(dueForRelease(new Date('2026-09-16T12:00:00Z')).due).toEqual([]);
    });
  });

  it('holds an approved run that has no script, and says so', () => {
    withRuns((root) => {
      const run = Run.create(
        { personaId: 'honest-health', formatId: 'what-we-know', topic: 'x' },
        { root }
      );
      run.setReleaseAt(new Date('2020-01-01T00:00:00Z'), new Date());

      const plan = dueForRelease(new Date('2026-09-16T12:00:00Z'));
      expect(plan.due).toEqual([]);
      expect(plan.held).toHaveLength(1);
      expect(plan.held[0]!.reason).toMatch(/no script/);
    });
  });
});
