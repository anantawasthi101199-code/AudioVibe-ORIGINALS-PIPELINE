/**
 * A map item can carry a script already written. A blank made from it opens
 * filled in, and the shipped scripts have to fit their format exactly.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadPersona } from '../../canon/load';
import { loadFormat } from '../../formats/load';
import { Run } from '../../run/store';
import { loadMaps, preparedScriptFor } from '../../server/maps';
import { BLANK_MARK, blankScript, fillBlank, handwrittenGate, startHandwritten } from '../handwritten';

const root = path.join(__dirname, '..', '..', '..');
const persona = loadPersona('mythic-archives');
const blank = () => blankScript(persona, loadFormat('myth-story'), 'a topic');
const meta = { title: 'T', description: 'D' };

describe('a prepared script', () => {
  it('fills every part, one turn per paragraph, with its own title', () => {
    const s = fillBlank(blank(), '## opening\n\nOne.\n\nTwo\nlines.\n\n## story\n\nThree.\n\n## close\n\nFour.', meta);
    expect(s.title).toBe('T');
    expect(s.beats.map((b) => b.turns.map((t) => t.text))).toEqual([['One.', 'Two lines.'], ['Three.'], ['Four.']]);
  });

  it('refuses a missing part, an unknown part, or text before the first part', () => {
    expect(() => fillBlank(blank(), '## opening\n\nA.\n\n## story\n\nB.', meta)).toThrow(/close/);
    expect(() => fillBlank(blank(), '## opening\n\nA.\n\n## story\n\nB.\n\n## close\n\nC.\n\n## coda\n\nD.', meta)).toThrow(/coda/);
    expect(() => fillBlank(blank(), 'Hello.\n\n## opening\n\nA.', meta)).toThrow(/before the first/);
  });

  it('EVERY SCRIPT ON A SHIPPED MAP fits its format and passes the hand-written gate', () => {
    const maps = loadMaps('mythic-archives', path.join(root, 'maps'));
    const keys = maps.flatMap((m) => m.series.flatMap((s) => s.episodes.filter((e) => e.script).map((e) => `${m.id}/${e.number}`)));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const prepared = preparedScriptFor('mythic-archives', key, root)!;
      const run = Run.create(
        { personaId: 'mythic-archives', formatId: 'myth-story', topic: key, holdForApproval: false, handwritten: true },
        { root: fs.mkdtempSync(path.join(os.tmpdir(), 'prep-')) },
      );
      const script = startHandwritten(run, prepared);
      expect(script.title).toBe(prepared.title);
      expect(script.beats.some((b) => b.turns.some((t) => t.text.includes(BLANK_MARK)))).toBe(false);
      const gate = handwrittenGate(run, script);
      expect(gate.passed).toBe(true);
      expect(gate.findings).toEqual([]);
      expect(gate.measurement.bannedFound).toEqual([]);
    }
  });
});
