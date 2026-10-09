/**
 * The channel overview, the cost of suggestions, and the whole-script box
 * (owner, 2026-10-09).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { recordStudioSpend, studioSpendFor } from '../studioSpend';
import { getChannel } from '../routes';
import { fromWhole, toWhole } from '../../../web/src/scriptText';

describe('money spent outside any run', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-spend-'));
    process.env.FOUNDRY_RUNS_DIR = root;
  });
  afterEach(() => {
    delete process.env.FOUNDRY_RUNS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('records each suggestion against its channel and sums it back', () => {
    recordStudioSpend({ channelId: 'business-decoded', what: 'suggest topics', pence: 1.2, who: 'anant' });
    recordStudioSpend({ channelId: 'business-decoded', what: 'suggest topics', pence: 0.9, who: 'devesh' });
    recordStudioSpend({ channelId: 'eureka-tales', what: 'suggest topics', pence: 5, who: null });
    expect(studioSpendFor('business-decoded')).toEqual({ totalPence: 2.1, last30Pence: 2.1, calls: 2 });
    expect(studioSpendFor('eureka-tales').calls).toBe(1);
  });

  it('shows on the channel, with an overview of what the channel makes', () => {
    recordStudioSpend({ channelId: 'business-decoded', what: 'suggest topics', pence: 1.5, who: null });
    const c = getChannel('business-decoded');
    expect(c.studioSpend.totalPence).toBe(1.5);
    expect(c.overview.thesis.length).toBeGreaterThan(10);
    expect(c.overview.audience.length).toBeGreaterThan(5);
    expect(c.overview.host?.name).toBe('Adrian');
  });
});

describe('the whole script in one box', () => {
  const beats = [
    { beatId: 'story', beatType: 'escalation', turns: [{ speaker: 'host', text: 'A'.repeat(600) }, { speaker: 'host', text: 'B'.repeat(600) }], claimIds: ['c1'], revisions: 0 },
    { beatId: 'rise', beatType: 'payoff', turns: [{ speaker: 'host', text: 'C'.repeat(300) }], claimIds: [], revisions: 0 },
    { beatId: 'close', beatType: 'outro', turns: [{ speaker: 'host', text: 'Short close.' }, { speaker: 'host', text: "That's the story, decoded.", fixed: true }], claimIds: [], revisions: 0 },
  ];

  it('round-trips exactly, keeping facts and the fixed outro', () => {
    const back = fromWhole(toWhole(beats), beats);
    expect(back).toEqual({ ok: true, beats });
  });

  it('takes an edit under a part header', () => {
    const text = toWhole(beats).replace('C'.repeat(300), 'A new middle.\n\nAnd a second paragraph.');
    const r = fromWhole(text, beats);
    expect(r.ok && r.beats[1]!.turns.map((t) => t.text)).toEqual(['A new middle.', 'And a second paragraph.']);
  });

  it('shares plain pasted paragraphs over the parts in order, outro still fixed', () => {
    const plain = ['One. '.repeat(120), 'Two. '.repeat(120), 'Three. '.repeat(60), 'Four.', "That's the story, decoded."].join('\n\n');
    const r = fromWhole(plain, beats);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.beats.every((b) => b.turns.length > 0)).toBe(true);
    expect(r.beats.flatMap((b) => b.turns).map((t) => t.text).join('|')).toBe(plain.split('\n\n').map((p) => p.trim()).join('|'));
    expect(r.beats[2]!.turns.at(-1)!.fixed).toBe(true);
  });

  it('says what is wrong instead of guessing', () => {
    expect(fromWhole('## nope\n\nx', beats)).toMatchObject({ ok: false, error: expect.stringMatching(/unknown part/) });
    expect(fromWhole('## story\n\nx\n\n## rise\n\n## close\n\ny', beats)).toMatchObject({ ok: false, error: expect.stringMatching(/"rise" has no text/) });
    expect(fromWhole('one paragraph', beats)).toMatchObject({ ok: false, error: expect.stringMatching(/1 paragraph for 3 parts/) });
    expect(fromWhole('loose\n\n## story\n\nx', beats)).toMatchObject({ ok: false, error: expect.stringMatching(/before the first/) });
  });
});
