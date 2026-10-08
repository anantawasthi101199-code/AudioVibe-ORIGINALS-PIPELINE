/**
 * Regenerating keeps every take, and a person chooses which one publishes
 * (owner, 2026-10-08).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import { budgetFor, targetFor } from '../../pipeline/budget';
import { chooseTake, readTakes, syncTakes, takesView } from '../takes';
import { regenerateRun } from '../../server/routes';

const FIXTURE = path.join(__dirname, '..', '..', 'publish', '__tests__', 'fixtures', 'story-single-short');
const RUN_ID = 'root-health/e001-20261005-sleep-loss-makes-unhealthy-food-look';

describe('takes', () => {
  let root: string;
  let run: Run;
  const wav = () => path.join(run.dir, 'media', 'episode.wav');
  /** A new voicing landing in place, as the renderer writes it. */
  const voiceAgain = (bytes: string) => {
    fs.writeFileSync(wav(), bytes);
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(wav(), later, later);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'takes-'));
    fs.cpSync(FIXTURE, root, { recursive: true });
    process.env.FOUNDRY_RUNS_DIR = root;
    run = Run.open(RUN_ID, { root });
    run.setReleaseAt(null); // not approved for a day, so the choice is open
  });
  afterEach(() => {
    delete process.env.FOUNDRY_RUNS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('records the first voicing as take 1, chosen', () => {
    const record = syncTakes(run, 'anant');
    expect(record.takes.map((t) => t.id)).toEqual([1]);
    expect(record.chosen).toBe(1);
    expect(syncTakes(run).takes).toHaveLength(1); // the same voice is not recorded twice
  });

  it('a regenerated take does NOT replace the chosen one: it waits as a draft', () => {
    syncTakes(run);
    const first = fs.readFileSync(wav());
    voiceAgain('a second performance');
    const record = syncTakes(run, 'devesh');

    expect(record.takes.map((t) => t.id)).toEqual([1, 2]);
    expect(record.chosen).toBe(1);
    expect(fs.readFileSync(wav()).equals(first)).toBe(true); // take 1 put back in place
    expect(fs.readFileSync(path.join(run.dir, record.takes[1]!.file), 'utf8')).toBe('a second performance');
  });

  it('choosing a take puts it where publishing reads, and records who', () => {
    syncTakes(run);
    voiceAgain('take two');
    syncTakes(run);

    chooseTake(run, 2, 'anant');
    expect(fs.readFileSync(wav(), 'utf8')).toBe('take two');
    expect(readTakes(run).chosen).toBe(2);
    expect(run.isComplete('render') && run.isComplete('qa')).toBe(true);
    expect(run.readJournal().some((e) => /take 2 chosen to publish by anant/.test(e.event))).toBe(true);

    chooseTake(run, 1);
    expect(fs.readFileSync(wav(), 'utf8')).not.toBe('take two');
  });

  it('is fixed once approved for a day or published; the rest stay drafts', () => {
    syncTakes(run);
    voiceAgain('take two');
    syncTakes(run);

    run.setReleaseAt(new Date(Date.now() + 86_400_000), new Date());
    expect(() => chooseTake(run, 2)).toThrow(/approved for release/);

    run.setReleaseAt(null);
    run.markComplete('publish');
    expect(() => chooseTake(run, 2)).toThrow(/already published/);
    expect(takesView(run).takes).toHaveLength(2);
  });

  it('a take of earlier words is kept to listen to but cannot be chosen, and the new voicing is chosen', () => {
    syncTakes(run);
    const scriptFile = path.join(run.dir, 'script.json');
    const script = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
    script.beats[0].turns[0].text += ' An edited sentence.';
    fs.writeFileSync(scriptFile, JSON.stringify(script));

    voiceAgain('the edited script, voiced');
    const record = syncTakes(run);
    expect(record.chosen).toBe(2);

    const view = takesView(run);
    expect(view.takes.find((t) => t.id === 1)!.earlierScript).toBe(true);
    expect(() => chooseTake(run, 1)).toThrow(/earlier version of the script/);
  });

  it('every regeneration of a short adds 15p to its target and its ceiling', () => {
    const [ceiling, target] = [budgetFor(run), targetFor(run)];
    run.noteRegeneration();
    run.noteRegeneration();
    expect(budgetFor(run) - ceiling).toBe(30);
    expect(targetFor(run) - target).toBe(30);
  });

  it('regenerating is refused without the confirmation, and before there is a voice', () => {
    expect(() => regenerateRun(RUN_ID, null, {})).toThrow();
    run.uncomplete('render');
    expect(() => regenerateRun(RUN_ID, null, { confirm: true })).toThrow(/voice it first/);
  });
});
