/**
 * A persona file is content, edited by hand, so the tests that matter are the
 * ones about a BAD file: it must fail loudly at load rather than half-parse.
 * A half-parsed persona produces an episode that is subtly not the show, which
 * is far harder to notice than a crash.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { canonAsOf, canonOfKind, Persona } from '../schema';
import { loadAllPersonas, loadPersona, parsePersona, PersonaLoadError } from '../load';

const MINIMAL = `
id: test-show
handle: testshow
name: Test Show
category: Educational
thesis: A show for testing.
audience: Tests.
register: Plain.
voice:
  provider: elevenlabs
  voiceId: voice-123
styleCard:
  sentenceWordsMean: 15
  sentenceWordsStdDevMin: 5
  questionsPer100Words: 1
  secondPersonPer100Words: 1
  hedgesPer100WordsMax: 2
  metaphorDomains: [engineering]
formats: [case-study-teardown]
episodeSeconds: [300, 400]
allowedRiskTiers: [general]
`;

describe('parsePersona', () => {
  it('parses a minimal valid show and applies defaults', () => {
    const p = parsePersona(MINIMAL);
    expect(p.id).toBe('test-show');
    expect(p.voice.provider).toBe('elevenlabs');
    // Defaults exist so a show bible does not have to state every knob.
    expect(p.canon).toEqual([]);
    expect(p.styleCard.forbiddenPhrases).toEqual([]);
    expect(p.styleCard.catchphraseBudget).toBe(2);
    expect(p.voice.settings).toEqual({});
  });

  it('rejects invalid YAML with the file named', () => {
    expect(() => parsePersona('id: [unclosed', 'bad.yaml')).toThrow(PersonaLoadError);
  });

  it('names every problem at once, not just the first', () => {
    // Someone hand-editing a file should get the whole list in one pass rather
    // than fixing one field, re-running, and finding the next.
    try {
      parsePersona('id: "Not Valid"\nhandle: x\n', 'bad.yaml');
      throw new Error('should have thrown');
    } catch (err) {
      const problems = (err as PersonaLoadError).problems;
      expect(problems.length).toBeGreaterThan(1);
      expect(problems.join('\n')).toContain('id:');
    }
  });

  it('rejects an id that is not a safe slug', () => {
    // The id becomes a filename and a persona_ref sent to the platform.
    expect(() => parsePersona(MINIMAL.replace('test-show', 'Test Show'))).toThrow(
      PersonaLoadError
    );
  });

  it('requires at least one format', () => {
    expect(() => parsePersona(MINIMAL.replace('formats: [case-study-teardown]', 'formats: []'))).toThrow(
      PersonaLoadError
    );
  });

  it('requires a voice id, since a show without one cannot be rendered', () => {
    expect(() => parsePersona(MINIMAL.replace('voiceId: voice-123', 'voiceId: ""'))).toThrow(
      PersonaLoadError
    );
  });

  it('requires a sentence-length spread, so uniform prose cannot pass', () => {
    // The mean alone is satisfiable by a draft with no variance at all, which
    // is the clearest tell of generated writing.
    const p = parsePersona(MINIMAL);
    expect(p.styleCard.sentenceWordsStdDevMin).toBeGreaterThan(0);
  });
});

describe('canon dating', () => {
  const withCanon = (): Persona =>
    parsePersona(`${MINIMAL}
canon:
  - kind: belief
    text: Held from the start.
  - kind: belief
    text: Adopted later.
    since: '2026-06-01'
  - kind: taboo
    text: Retired.
    until: '2026-06-01'
`);

  it('returns only what was in force on the date', () => {
    // A show has to evolve without retconning: a callback to episode 3 must
    // still refer to what the show thought then.
    const early = canonAsOf(withCanon(), '2026-01-01').map((e) => e.text);
    expect(early).toEqual(['Held from the start.', 'Retired.']);
  });

  it('includes an entry from its start date onward', () => {
    const later = canonAsOf(withCanon(), '2026-09-01').map((e) => e.text);
    expect(later).toEqual(['Held from the start.', 'Adopted later.']);
  });

  it('treats `until` as exclusive on the day it ends', () => {
    const onTheDay = canonAsOf(withCanon(), '2026-06-01').map((e) => e.text);
    expect(onTheDay).not.toContain('Retired.');
  });

  it('filters by kind', () => {
    expect(canonOfKind(withCanon(), 'taboo', '2026-01-01')).toHaveLength(1);
    expect(canonOfKind(withCanon(), 'recurring_segment', '2026-01-01')).toHaveLength(0);
  });
});

describe('loadPersona', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-personas-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads a show by id', () => {
    fs.writeFileSync(path.join(dir, 'test-show.yaml'), MINIMAL);
    expect(loadPersona('test-show', dir).name).toBe('Test Show');
  });

  it('refuses when the id and the filename disagree', () => {
    // Otherwise run artifacts get filed under a show that does not exist.
    fs.writeFileSync(path.join(dir, 'other-name.yaml'), MINIMAL);
    expect(() => loadPersona('other-name', dir)).toThrow(/is named/);
  });

  it('explains a missing file rather than throwing ENOENT', () => {
    expect(() => loadPersona('absent', dir)).toThrow(PersonaLoadError);
  });

  it('returns an empty list when there are no personas at all', () => {
    expect(loadAllPersonas(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('the shipped personas', () => {
  // The real files are validated here so a typo in a show bible fails the unit
  // gate rather than an episode run.
  const shipped = loadAllPersonas();

  it('all parse', () => {
    expect(shipped.length).toBeGreaterThan(0);
  });

  it.each(shipped.map((p) => [p.id, p] as const))('%s is coherent', (_id, persona) => {
    const [min, max] = persona.episodeSeconds;
    expect(max).toBeGreaterThan(min);
    expect(persona.styleCard.metaphorDomains.length).toBeGreaterThan(0);
    // A show that lists a format it is not allowed to use would fail at
    // generation time, which is much later than here.
    expect(persona.formats.length).toBeGreaterThan(0);
  });
});
