/**
 * The prompts, checked with the same instruments the prompts impose.
 *
 * WHY THIS EXISTS. Rendering the assembled writer prompt for the first time
 * showed three faults that had been sent to a model on every beat of every
 * episode, none of them visible in any single source file:
 *
 *   "SAY EACH THING ONCE" appeared twice, in FORWARD_GUIDANCE and again in
 *   NARRATION_GUIDANCE - the instruction against repetition, repeated.
 *
 *   The breath limit appeared twice, in EAR_RULES and in NARRATION_GUIDANCE.
 *
 *   A one-host show was told its host's phrases were ones "the other host never
 *   uses", naming a person who does not exist.
 *
 * All three are composition faults. Each constant was fine on its own, and the
 * prompt is assembled from eight of them at runtime, so the only place the
 * fault existed was in a string nobody had ever looked at. That is exactly the
 * class of bug a test should own rather than a habit of remembering to look.
 */
import { loadFormat } from '../../formats/load';
import { loadAllPersonas, loadPersona } from '../../canon/load';
import { checkRepetition } from '../../script/forward';
import { buildSystem } from '../../script/write';
import { promptRegistry } from '../registry';

const ISO = '2026-09-12';

const solo = loadPersona('crime-files');

describe('the assembled writer prompt', () => {
  it('does not say the same thing twice', () => {
    // The show's own instrument, turned on the show's own instructions. If the
    // writer may not repeat itself, neither may the prompt telling it not to.
    const system = buildSystem(solo, ISO, 'long');
    expect(checkRepetition(system)).toEqual([]);
  });

  it('does not mention another host to a show that has one host', () => {
    expect(solo.hosts).toHaveLength(1);
    expect(buildSystem(solo, ISO, 'long')).not.toMatch(/other host/i);
  });

  it('builds for every shipped show, so no persona is left unrenderable', () => {
    for (const persona of loadAllPersonas()) {
      const format = loadFormat(persona.formats[0]!);
      expect(buildSystem(persona, ISO, format.kind).length).toBeGreaterThan(500);
    }
  });
});

describe('promptRegistry', () => {
  const entries = promptRegistry({
    persona: solo,
    format: loadFormat(solo.formats[0]!),
    isoDate: ISO,
  });

  it('gives every prompt a unique id', () => {
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('renders every entry with real text and a source to go and edit', () => {
    for (const e of entries) {
      expect(e.text.trim().length).toBeGreaterThan(80);
      expect(e.source).toMatch(/^src\//);
      expect(e.note.trim().length).toBeGreaterThan(20);
    }
  });

  /**
   * The registry has to keep up with the code, and the failure mode is silent:
   * a prompt added and not registered simply does not appear, and the dump
   * looks complete. Counting the system-prompt constants in the tree is crude,
   * but it is the thing that actually changes when somebody adds one.
   */
  it('registers every prompt constant in the tree', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execSync } = require('child_process') as typeof import('child_process');
    const found = execSync(
      'git grep -l -E "^export const [A-Z_]*(SYSTEM|INSTRUCTION) = " -- src',
      { encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .filter(Boolean);

    const registered = new Set(entries.map((e) => e.source.replace(/ \(.*\)$/, '')));
    const missing = found.filter((f) => !registered.has(f.replace(/\\/g, '/')));
    expect(missing).toEqual([]);
  });
});
