import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import { scriptSchema } from '../../script/write';
import { BLANK_MARK, handwrittenGate, startHandwritten } from '../handwritten';

describe('a hand-written script', () => {
  const make = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-'));
    const run = Run.create(
      {
        personaId: 'crime-files',
        formatId: 'case-short',
        topic: 'Dennis Nilsen',
        holdForApproval: true,
        handwritten: true,
      },
      { root },
    );
    return { run, script: startHandwritten(run) };
  };

  it('starts as one blank box per part of the format, costing nothing', () => {
    const { run, script } = make();
    expect(script.beats.length).toBeGreaterThan(0);
    expect(script.beats.every((b) => b.turns[0]!.text.startsWith(BLANK_MARK))).toBe(true);
    expect(run.manifest.spentPence).toBe(0);
    expect(run.isComplete('script')).toBe(true);
  });

  it('is blocked while any box is blank and passes once written', () => {
    const { run, script } = make();
    expect(handwrittenGate(run, script).passed).toBe(false);

    const words = Array.from({ length: 220 }, () => 'word').join(' ');
    const written = scriptSchema.parse({
      ...script,
      beats: script.beats.map((b) => ({
        ...b,
        turns: [{ ...b.turns[0]!, text: `${words}.` }],
      })),
    });
    const gate = handwrittenGate(run, written);
    expect(gate.passed).toBe(true);
    expect(gate.needsHumanReview).toBe(true);
  });
});
