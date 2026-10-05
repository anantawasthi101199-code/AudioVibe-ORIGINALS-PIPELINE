/**
 * EVERY ROUTE A LAUNCH CHANNEL PUBLISHES THROUGH MUST BE PUBLISHABLE.
 *
 * The fixtures are real runs from 2026-10-05, one per route, trimmed (source
 * text cut to 4,000 characters, audio replaced by a stub). On that morning the
 * single-story and case-file routes were refused at publish twice in a row:
 * "cannot be gated", then "no claims artifact". Nothing had ever asked whether
 * a run from those routes could actually go out. This does, for each of them.
 *
 * A NEW ROUTE GETS A FIXTURE HERE. Copy one finished run into fixtures/<name>/
 * (see the trimming above) and it is covered.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import { publishReadiness } from '../readiness';
import { publishRun } from '../publishRun';

const FIXTURES = path.join(__dirname, 'fixtures');

const fixtureRuns = (): Array<{ name: string; root: string; id: string }> =>
  fs.readdirSync(FIXTURES).map((name) => {
    const root = path.join(FIXTURES, name);
    const channel = fs.readdirSync(root)[0]!;
    const run = fs.readdirSync(path.join(root, channel))[0]!;
    return { name, root, id: `${channel}/${run}` };
  });

describe('publish readiness, every route', () => {
  afterEach(() => {
    delete process.env.FOUNDRY_RUNS_DIR;
  });

  it('has a fixture for every route the launch channels use', () => {
    expect(fixtureRuns().map((f) => f.name).sort()).toEqual([
      'biz-short-story-route',
      'case-short',
      'myth-short',
      'news-roundup',
      'psych',
      'story-single-short',
      'story-single-short-2',
    ]);
  });

  for (const { name, root, id } of fixtureRuns()) {
    it(`${name} can be gated and given its sources`, () => {
      process.env.FOUNDRY_RUNS_DIR = root;
      const readiness = publishReadiness(Run.open(id, { root }));
      expect(readiness.problems).toEqual([]);
      expect(readiness.gatePassed).not.toBeNull();
    });
  }
});

describe('publishing twice', () => {
  it('is refused before anything is sent, whoever asks', async () => {
    const { root, id } = fixtureRuns().find((f) => f.name === 'story-single-short')!;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-once-'));
    fs.cpSync(root, tmp, { recursive: true });
    const run = Run.open(id, { root: tmp });
    run.markComplete('publish');
    const gate = { passed: true, findings: [], needsHumanReview: false, humanReviewReasons: [] } as never;
    await expect(publishRun(run, gate, { confirmed: true })).rejects.toThrow(/already published/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
