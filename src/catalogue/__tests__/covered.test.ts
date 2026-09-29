/**
 * The duplicate check is the cheapest money the studio saves, and it only works
 * if it fires on the shapes a duplicate actually takes. Those are not exact
 * repeats - nobody types the same topic twice by accident. They are the same
 * subject at a different length, with a possessive, or with the words in
 * another order, which is why each of those has a test here.
 *
 * The other half is what it must NOT do. A check that blocks two genuinely
 * different episodes is a check somebody turns off, and then it protects
 * nothing at all.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BLOCK_AT,
  Catalogue,
  blocking,
  findCovered,
  loadCatalogue,
  overlap,
  recordMade,
  refusal,
  saveCatalogue,
  subjectKey,
} from '../covered';

const entry = (showId: string, topic: string, runId: string) => ({
  showId,
  topic,
  runId,
  madeAt: '2026-09-25T10:00:00.000Z',
});

const catalogue = (over: Partial<Catalogue> = {}): Catalogue => ({
  entries: [
    entry('myths-of-the-world', 'The Descent of Inanna to the Underworld', 'myths/e008'),
    entry('myths-of-the-world', 'Amaterasu and the cave', 'myths/e012'),
    entry('honest-health', 'Does a bad night of sleep make you ill', 'health/e001'),
  ],
  ...over,
});

describe('subjectKey', () => {
  it('drops the words that never identify a subject', () => {
    expect(subjectKey('The Descent of Inanna to the Underworld')).toEqual([
      'descent',
      'inanna',
      'underworld',
    ]);
  });

  it('folds a possessive onto the bare name', () => {
    expect(subjectKey("Anansi's stories")).toEqual(subjectKey('Anansi stories'));
  });

  it('is order independent', () => {
    expect(subjectKey('Inanna descent')).toEqual(subjectKey('descent Inanna'));
  });

  it('brings a plural close to its singular', () => {
    expect(subjectKey('the sky stories')).toEqual(subjectKey('a sky story'));
    expect(subjectKey('ten suns')).toEqual(subjectKey('the ten sun'));
  });

  /**
   * Without the ss guard, "goddess" stems to "goddes" and "goddesses" to
   * "goddesse", so the two words this is meant to unify end up further apart.
   */
  it('does not mangle a word that simply ends in ss', () => {
    expect(subjectKey('a guilty goddess')).toEqual(['goddess', 'guilty']);
    expect(subjectKey('goddesses')).toEqual(['goddess']);
  });

  /**
   * The stopword list is deliberately small. These are ordinary words AND they
   * are what episodes are about, so removing them would make two unrelated
   * episodes look alike.
   */
  it('keeps ordinary words that can be the subject', () => {
    expect(subjectKey('war and death')).toEqual(['death', 'war']);
  });
});

describe('overlap', () => {
  /**
   * The shape a duplicate really takes: the same subject typed at two
   * different lengths. Jaccard scores this low purely because one is longer,
   * which is why this divides by the shorter of the two instead.
   */
  it('scores a short topic fully contained in a longer one', () => {
    expect(overlap(subjectKey('Inanna descent'), subjectKey('The Descent of Inanna to the Underworld'))).toBe(1);
  });

  it('scores unrelated subjects at zero', () => {
    expect(overlap(subjectKey('Anansi and the sky god'), subjectKey('Amaterasu and the cave'))).toBe(0);
  });

  it('is symmetric', () => {
    const a = subjectKey('Inanna descent');
    const b = subjectKey('The Descent of Inanna to the Underworld');
    expect(overlap(a, b)).toBe(overlap(b, a));
  });

  it('is zero against nothing', () => {
    expect(overlap([], subjectKey('anything'))).toBe(0);
  });
});

describe('findCovered', () => {
  it('finds the same subject typed differently', () => {
    const matches = findCovered(catalogue(), 'myths-of-the-world', "Inanna's descent");

    expect(matches[0]?.entry.runId).toBe('myths/e008');
    expect(matches[0]?.score).toBeGreaterThanOrEqual(BLOCK_AT);
    expect(matches[0]?.sameShow).toBe(true);
  });

  it('says nothing about a genuinely new subject', () => {
    expect(findCovered(catalogue(), 'myths-of-the-world', 'Houyi shoots the ten suns')).toEqual([]);
  });

  /**
   * Two shows reaching the same subject from different angles is the catalogue
   * working, not repeating itself. So a cross-show match is reported and never
   * blocks.
   */
  it('marks a match from another show as a different show', () => {
    const matches = findCovered(catalogue(), 'night-shift', "Inanna's descent");

    expect(matches[0]?.sameShow).toBe(false);
    expect(blocking(matches)).toEqual([]);
  });

  it('sorts the closest match first', () => {
    const many = catalogue({
      entries: [
        entry('myths-of-the-world', 'Inanna and the huluppu tree', 'myths/e020'),
        entry('myths-of-the-world', 'The Descent of Inanna to the Underworld', 'myths/e008'),
      ],
    });

    const matches = findCovered(many, 'myths-of-the-world', 'The descent of Inanna');
    expect(matches[0]?.entry.runId).toBe('myths/e008');
  });
});

describe('blocking', () => {
  it('blocks a close match from the same show', () => {
    const matches = findCovered(catalogue(), 'myths-of-the-world', 'Descent of Inanna');
    expect(blocking(matches)).toHaveLength(1);
  });

  /**
   * A distant match is worth mentioning and must not stop anything. Blocking
   * here is how a useful check becomes one somebody switches off.
   */
  it('does not block a distant match', () => {
    const near = catalogue({
      entries: [entry('myths-of-the-world', 'Inanna, Dumuzi and the shepherd', 'myths/e030')],
    });

    const matches = findCovered(near, 'myths-of-the-world', 'The cave of Amaterasu and the sun');
    expect(blocking(matches)).toEqual([]);
  });
});

describe('refusal', () => {
  it('names the earlier run, its date, and the override', () => {
    const matches = findCovered(catalogue(), 'myths-of-the-world', 'Descent of Inanna');
    const text = refusal('myths-of-the-world', 'Descent of Inanna', matches);

    expect(text).toContain('myths/e008');
    expect(text).toContain('2026-09-25');
    expect(text).toContain('--again');
    expect(text).toContain('Nothing has been spent');
  });
});

describe('recordMade', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-cat-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts from nothing when no catalogue exists', () => {
    expect(loadCatalogue(dir)).toEqual({ entries: [] });
  });

  it('records a subject and finds it again', () => {
    recordMade('myths-of-the-world', 'Houyi shoots the ten suns', 'myths/e015', new Date(), dir);

    const found = findCovered(loadCatalogue(dir), 'myths-of-the-world', 'Houyi and the ten suns');
    expect(found).toHaveLength(1);
  });

  /**
   * A resumed run must not appear twice. Identity is the run id, not the
   * subject, because once somebody passes --again that second run IS a real
   * second thing and both belong in the ledger.
   */
  it('is idempotent for one run, and keeps a deliberate remake', () => {
    recordMade('myths-of-the-world', 'Orpheus', 'myths/e014', new Date(), dir);
    recordMade('myths-of-the-world', 'Orpheus', 'myths/e014', new Date(), dir);
    expect(loadCatalogue(dir).entries).toHaveLength(1);

    recordMade('myths-of-the-world', 'Orpheus', 'myths/e021', new Date(), dir);
    expect(loadCatalogue(dir).entries).toHaveLength(2);
  });

  it('round-trips through the file', () => {
    saveCatalogue(catalogue(), dir);
    expect(loadCatalogue(dir)).toEqual(catalogue());
  });
});
