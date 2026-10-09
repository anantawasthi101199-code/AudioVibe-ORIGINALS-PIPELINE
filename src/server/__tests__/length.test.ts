/**
 * Length: a loud warning past 15 min (episode) / 3 min (short), voicing
 * blocked past 20 / 5 (owner, 2026-10-09).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LENGTH_LIMITS, lengthCheck } from '../../script/length';
import { WORDS_PER_SECOND, scriptSchema } from '../../script/write';
import { Run } from '../../run/store';
import { getRun, regenerateRun, resumeRun } from '../routes';

const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
const scriptOf = (n: number) => ({ beats: [{ turns: [{ text: words(n) }] }] });

describe('how long a script runs', () => {
  it('warns a short past 3 minutes and blocks it past 5', () => {
    const at = (s: number) => Math.round(s * WORDS_PER_SECOND);
    expect(lengthCheck(scriptOf(at(170)), 'short').level).toBe('ok');
    expect(lengthCheck(scriptOf(at(200)), 'short').level).toBe('warn');
    expect(lengthCheck(scriptOf(at(310)), 'short').level).toBe('block');
  });

  it('warns an episode past 15 minutes and blocks it past 20', () => {
    const at = (m: number) => Math.round(m * 60 * WORDS_PER_SECOND);
    expect(lengthCheck(scriptOf(at(14)), 'episode').level).toBe('ok');
    expect(lengthCheck(scriptOf(at(16)), 'episode').level).toBe('warn');
    expect(lengthCheck(scriptOf(at(21)), 'episode').level).toBe('block');
    expect(LENGTH_LIMITS.episode.blockSeconds).toBe(1200);
  });

  it('does not count delivery tags as words', () => {
    expect(lengthCheck({ beats: [{ turns: [{ text: '[warmly] Hello there. [pause] Friend.' }] }] }, 'short').words).toBe(3);
  });
});

describe('voicing a script that is far too long is refused', () => {
  const FIXTURE = path.join(__dirname, '..', '..', 'publish', '__tests__', 'fixtures', 'biz-short-story-route');
  const RUN_ID = 'business-decoded/e001-20261004-did-airbnb-go-from-renting-air';
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'length-'));
    fs.cpSync(FIXTURE, root, { recursive: true });
    process.env.FOUNDRY_RUNS_DIR = root;
    process.env.ELEVENLABS_API_KEY ??= 'test';
    const run = Run.open(RUN_ID, { root });
    run.setReleaseAt(null); // not approved for a day, so only the length can refuse
    const s = run.readArtifact('script', scriptSchema);
    s.beats[0]!.turns[0]!.text += ' ' + words(1200); // well past 5 minutes for a short
    run.writeArtifact('script', s);
  });
  afterEach(() => {
    delete process.env.FOUNDRY_RUNS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('shows the block on the run, and the voice and regenerate routes refuse', () => {
    expect(getRun(RUN_ID).length?.level).toBe('block');
    expect(() => regenerateRun(RUN_ID, null, { confirm: true })).toThrow(/cannot be voiced past 5 minutes/);
    const run = Run.open(RUN_ID, { root });
    run.uncomplete('render');
    expect(() => resumeRun(RUN_ID, null, {})).toThrow(/cannot be voiced past 5 minutes/);
  });
});
