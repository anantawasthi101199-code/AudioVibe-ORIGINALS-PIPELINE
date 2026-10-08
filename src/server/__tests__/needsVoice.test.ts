/**
 * Approved, written, and NOT voiced (2026-10-08).
 *
 * A Business Decoded short was approved on ElevenLabs, which discarded its GPT
 * voice; the new voicing then stopped at the budget. The report written before
 * the render was still on disk and passed, so the run sat in To decide with no
 * audio, no Approve and no Resume. These pin the fix: such a run is
 * `needs-voice`, it is never offered for publishing, and it cannot be approved
 * for a day or published.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import { runSummary } from '../catalog';
import { getQueue } from '../queue';
import { approveForRelease, publishRunJob } from '../operate';

const FIXTURE = path.join(__dirname, '..', '..', 'publish', '__tests__', 'fixtures', 'story-single-short');
const RUN_ID = 'root-health/e001-20261005-sleep-loss-makes-unhealthy-food-look';

describe('a run whose voice is not made yet', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'needs-voice-'));
    fs.cpSync(FIXTURE, root, { recursive: true });
    process.env.FOUNDRY_RUNS_DIR = root;
  });
  afterEach(() => {
    delete process.env.FOUNDRY_RUNS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** What switching engine, or editing the words, does to a voiced run. */
  const unvoice = (): Run => {
    const run = Run.open(RUN_ID, { root });
    run.setReleaseAt(null);
    fs.rmSync(path.join(run.dir, 'render.json'), { force: true });
    run.uncomplete('render');
    run.uncomplete('qa');
    return run;
  };

  it('is ready while voiced and gated, and needs a voice once the voice is gone', () => {
    const run = Run.open(RUN_ID, { root });
    run.setReleaseAt(null);
    expect(runSummary(run).state).toBe('ready');

    expect(runSummary(unvoice()).state).toBe('needs-voice');
  });

  it('keeps it out of To decide, even though a passing report is still on disk', () => {
    const run = unvoice();
    expect(run.hasArtifact('qa')).toBe(true);
    const q = getQueue(new Date('2026-10-08T12:00:00Z'));
    expect(q.ready.map((r) => r.id)).not.toContain(RUN_ID);
    expect(q.unfinished.map((r) => r.id)).toContain(RUN_ID);
  });

  it('cannot be approved for a day or published', () => {
    unvoice();
    expect(() => approveForRelease('root-health', { runIds: [RUN_ID] })).toThrow(/not voiced yet/);
    expect(() => publishRunJob(RUN_ID, { confirmed: true })).toThrow(/not been voiced/);
  });

  it('a finished run, once approved, gets the next free day from tomorrow', () => {
    const run = Run.open(RUN_ID, { root });
    run.setReleaseAt(null);
    const before = new Date();
    const result = approveForRelease('root-health', { runIds: [RUN_ID] });
    expect(result.unscheduled).toEqual([]);
    const at = new Date(result.approved[0]!.releaseAt);
    const days = (Date.parse(at.toISOString().slice(0, 10)) - Date.parse(before.toISOString().slice(0, 10))) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(1);
    expect(days).toBeLessThanOrEqual(2); // tomorrow, in London
  });

  it('remembers why its last attempt failed, until the next one starts', () => {
    const run = unvoice();
    run.noteFailure('over the 15p ceiling', 'render');
    expect(runSummary(Run.open(RUN_ID, { root })).lastFailure).toMatchObject({
      message: 'over the 15p ceiling',
      stage: 'render',
    });
    run.clearFailure();
    expect(runSummary(Run.open(RUN_ID, { root })).lastFailure).toBeNull();
  });
});

describe('the budget: a target that warns and a ceiling that stops', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'));
    fs.cpSync(FIXTURE, root, { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('carries on past the target, journals it once, and stops only past the ceiling', () => {
    const run = Run.open(RUN_ID, { root });
    const start = run.manifest.spentPence;
    const target = start + 15;
    const ceiling = start + 25;

    run.spend(14, ceiling, target);
    run.spend(4, ceiling, target); // over the target: carries on
    run.spend(2, ceiling, target);
    const warnings = run.readJournal().filter((e) => e.stage === 'budget');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.event).toMatch(/carrying on/);

    expect(() => run.spend(10, ceiling, target)).toThrow(/ceiling/);
  });

  it('defaults to 15p/50p for a short and 120p/200p for an episode', async () => {
    const config = await import('../../config');
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (/^FOUNDRY_(SHORT|EPISODE)_(BUDGET|TARGET)_PENCE$/.test(k)) delete process.env[k];
    try {
      expect([config.shortTargetPence(), config.shortBudgetPence()]).toEqual([15, 50]);
      expect([config.episodeTargetPence(), config.episodeBudgetPence()]).toEqual([120, 200]);
    } finally {
      process.env = saved;
    }
  });
});
