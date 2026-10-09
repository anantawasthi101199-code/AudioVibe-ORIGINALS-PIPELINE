/**
 * The outro: optional, one of the channel's three, attached to the end of the
 * saved script and voiced with it (owner, 2026-10-09).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import YAML from 'yaml';
import { Run } from '../../run/store';
import { scriptSchema } from '../../script/write';
import { getRun, saveScript, setRunOutro } from '../routes';

const FIXTURE = path.join(__dirname, '..', '..', 'publish', '__tests__', 'fixtures', 'biz-short-story-route');
const RUN_ID = 'business-decoded/e001-20261004-did-airbnb-go-from-renting-air';

describe('the outro', () => {
  let root: string;
  let run: Run;
  const script = () => Run.open(RUN_ID, { root }).readArtifact('script', scriptSchema);
  const lastTurns = () => script().beats.at(-1)!.turns;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'outro-'));
    fs.cpSync(FIXTURE, root, { recursive: true });
    process.env.FOUNDRY_RUNS_DIR = root;
    run = Run.open(RUN_ID, { root });
    run.uncomplete('publish');
  });
  afterEach(() => {
    delete process.env.FOUNDRY_RUNS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("offers exactly the channel's three outros for this kind", () => {
    const { outro } = getRun(RUN_ID);
    expect(outro.kind).toBe('short');
    expect(outro.options).toHaveLength(3);
    expect(outro.options.every((o) => o.includes('Adrian'))).toBe(true);
    expect(outro.current).toBeNull(); // this script was written without one
  });

  it('ticked: the chosen outro is the fixed last turn of the saved script; untick removes it', () => {
    const { outro } = getRun(RUN_ID);
    setRunOutro(RUN_ID, { enabled: true, index: 1 }, 'anant');
    expect(lastTurns().at(-1)).toMatchObject({ text: outro.options[1], fixed: true });
    expect(getRun(RUN_ID).outro.index).toBe(1);

    setRunOutro(RUN_ID, { enabled: true, index: 2 });
    expect(lastTurns().filter((t) => t.fixed).map((t) => t.text)).toEqual([outro.options[2]]); // replaced, never two

    setRunOutro(RUN_ID, { enabled: false });
    expect(lastTurns().some((t) => t.fixed)).toBe(false);
    expect(getRun(RUN_ID).outro.current).toBeNull();
  });

  it('a voiced run has to be voiced again when the outro changes', () => {
    expect(run.isComplete('render')).toBe(true);
    const r = setRunOutro(RUN_ID, { enabled: true, index: 0 });
    expect(r.audioStale).toBe(true);
    expect(Run.open(RUN_ID, { root }).isComplete('render')).toBe(false);
  });

  it('editing the script, by part or whole, never drops or doubles the outro', () => {
    setRunOutro(RUN_ID, { enabled: true, index: 0 });
    const s = script();
    // The editors send the parts WITHOUT the outro...
    const bare = s.beats.map((b) => ({ ...b, turns: b.turns.filter((t) => !t.fixed) }));
    bare[0]!.turns[0]!.text += ' An edit.';
    saveScript(RUN_ID, { title: s.title, description: s.description, beats: bare });
    expect(lastTurns().filter((t) => t.fixed)).toHaveLength(1);
    expect(script().beats[0]!.turns[0]!.text.endsWith(' An edit.')).toBe(true);
    // ...and an older page that sends it along does not make two.
    saveScript(RUN_ID, { title: s.title, description: s.description, beats: script().beats });
    expect(lastTurns().filter((t) => t.fixed)).toHaveLength(1);
  });

  it('is refused for a published run, and for a number that is not one of the three', () => {
    expect(() => setRunOutro(RUN_ID, { enabled: true, index: 7 })).toThrow(/choose one/);
    run.markComplete('publish');
    expect(() => setRunOutro(RUN_ID, { enabled: true, index: 0 })).toThrow(/published/);
  });

  it('every channel has exactly three outros for shorts and three for episodes', () => {
    const vm = YAML.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'voice-master.yaml'), 'utf8'));
    for (const [id, c] of Object.entries(vm.channels as Record<string, { outros: { episode: string[]; short: string[] } }>)) {
      expect([id, c.outros.episode.length, c.outros.short.length]).toEqual([id, 3, 3]);
    }
  });

  it('an older script ending on one of the outros, typed out, shows it as attached', () => {
    const { outro } = getRun(RUN_ID);
    const s = script();
    s.beats.at(-1)!.turns.push({ speaker: s.beats.at(-1)!.turns[0]!.speaker, text: outro.options[2]! });
    Run.open(RUN_ID, { root }).writeArtifact('script', s);
    const after = getRun(RUN_ID).outro;
    expect(after.index).toBe(2);
    expect(lastTurns().at(-1)!.fixed).toBe(true);
  });

  it('warns when the script already says goodbye in its own words, so ticking would say it twice', () => {
    const s = script();
    s.beats.at(-1)!.turns.at(-1)!.text += ' Follow for more stories like this, and I will see you next time.';
    Run.open(RUN_ID, { root }).writeArtifact('script', s);
    expect(getRun(RUN_ID).outro.signoffInText).toMatch(/see you next time/);
    setRunOutro(RUN_ID, { enabled: true, index: 0 });
    expect(getRun(RUN_ID).outro.signoffInText).toBeNull();
  });
});
