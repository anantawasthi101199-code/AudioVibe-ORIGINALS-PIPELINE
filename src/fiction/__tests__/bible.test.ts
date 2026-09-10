/**
 * The series bible is the fiction lane's evidence ledger, and it is the one
 * artifact in the repo that is deliberately mutated. What is pinned here is
 * everything that would let it drift silently: reading it wrong, writing over
 * a series that already had history, and handing the writer the twist it was
 * supposed to be building towards.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  Bible,
  BibleError,
  allFacts,
  castBrief,
  loadBible,
  saveBible,
  storySoFar,
} from '../bible';

const bible = (over: Partial<Bible> = {}): Bible => ({
  personaId: 'night-shift',
  entities: [
    {
      id: 'ruth',
      kind: 'character',
      name: 'Ruth',
      summary: 'Charge nurse, twenty years of nights.',
      introducedIn: 'ep1',
      facts: [
        { text: 'Ruth has worked nights for twenty years.', episodeId: 'ep1', revisable: false },
        { text: 'Ruth believes her brother left the city.', episodeId: 'ep2', revisable: true },
      ],
    },
    {
      id: 'femi',
      kind: 'character',
      name: 'Femi',
      summary: 'Two years in, narrates his own thinking.',
      introducedIn: 'ep1',
      facts: [],
    },
  ],
  episodes: [
    { id: 'ep1', title: 'Handover', synopsis: 'A quiet night that was not.' },
    { id: 'ep2', title: 'The Call', synopsis: 'Ruth took a call she did not explain.' },
  ],
  ...over,
});

describe('loadBible', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-bible-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gives a show with no bible an empty one', () => {
    // An absent bible is a first episode, not an error. Requiring one to exist
    // before anything could run would mean inventing a cast in a JSON file,
    // which is the worst possible place to invent a cast.
    const fresh = loadBible('brand-new', dir);
    expect(fresh).toEqual({ personaId: 'brand-new', entities: [], episodes: [] });
  });

  it('round-trips through disk', () => {
    saveBible(bible(), dir);
    expect(loadBible('night-shift', dir)).toEqual(bible());
  });

  it('THROWS on an unreadable bible rather than starting a fresh one', () => {
    // The alternative is starting an empty bible over the top of one that had
    // thirty episodes of history in it, and then checking every future episode
    // against nothing.
    fs.writeFileSync(path.join(dir, 'night-shift.json'), '{ this is not json');
    expect(() => loadBible('night-shift', dir)).toThrow(BibleError);
  });

  it('THROWS on a bible whose shape has drifted', () => {
    fs.writeFileSync(path.join(dir, 'night-shift.json'), '{"personaId": 42}');
    expect(() => loadBible('night-shift', dir)).toThrow(BibleError);
  });
});

describe('castBrief', () => {
  it('gives the writer the cast and their fixed facts', () => {
    const brief = castBrief(bible());
    expect(brief).toContain('Ruth (character)');
    expect(brief).toContain('worked nights for twenty years');
  });

  it('HIDES revisable facts from the writer', () => {
    // Handing the writer "she believes her brother left" alongside the fixed
    // facts invites it to treat the belief as settled background rather than
    // as the thing the series is going to turn over.
    expect(castBrief(bible())).not.toContain('brother');
  });

  it('says plainly when nothing has been established', () => {
    expect(castBrief({ personaId: 'x', entities: [], episodes: [] })).toContain('first episode');
  });
});

describe('storySoFar', () => {
  it('lists episodes in the order a listener heard them', () => {
    const text = storySoFar(bible());
    expect(text.indexOf('Handover')).toBeLessThan(text.indexOf('The Call'));
  });

  it('truncates a long series rather than dumping all of it', () => {
    // A twenty-episode synopsis is context rot: the writer reads a wall of
    // text and remembers the start and the end.
    const long = bible({
      episodes: Array.from({ length: 20 }, (_, i) => ({
        id: `ep${i}`,
        title: `Episode ${i}`,
        synopsis: 'Things happened.',
      })),
    });

    const text = storySoFar(long, 4);
    expect(text).toContain('16 earlier episode(s) omitted');
    expect(text).toContain('Episode 19');
    expect(text).not.toContain('Episode 3:');
  });

  it('says plainly when this is the first episode', () => {
    expect(storySoFar({ personaId: 'x', entities: [], episodes: [] })).toContain('first episode');
  });
});

describe('allFacts', () => {
  it('flattens facts with the entity they belong to', () => {
    const flat = allFacts(bible());
    expect(flat).toHaveLength(2);
    expect(flat[0]!.entity.name).toBe('Ruth');
  });
});
