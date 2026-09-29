/**
 * The season plan is the first thing in this repo that checks a story's SHAPE
 * rather than its facts, and every check in it is free. That is the whole
 * argument for the lane: a season that owes its listener an answer costs
 * pennies to catch here and several pounds of generated prose to catch by
 * listening to it.
 *
 * So what is pinned here is the arithmetic, and in particular the failures that
 * would let a broken season through silently: a promise nobody pays, a twist
 * paid before it is planted, a finale that does not land, and a writer being
 * handed either too little of the plan to aim at or so much of it that the
 * planting turns into announcing.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Bible } from '../bible';
import {
  MAX_CARRY_CAST,
  locateEpisode,
  SeasonPlan,
  briefForEpisode,
  checkPlan,
  loadPlan,
  planDrift,
  renderPlan,
  savePlan,
} from '../season';

const card = (n: number, over: Partial<SeasonPlan['episodes'][number]> = {}) => ({
  number: n,
  title: `Episode ${n}`,
  opens: 'Someone is already halfway through saying no.',
  story: 'Things happen, in order, to people who did not want them to.',
  changes: 'Something that cannot be put back.',
  cliffhanger: 'A door that was locked is open.',
  plants: [] as string[],
  paysOff: [] as string[],
  ...over,
});

/** A season that passes everything, so each test can break exactly one thing. */
const plan = (over: Partial<SeasonPlan> = {}): SeasonPlan => ({
  personaId: 'night-shift',
  seasonNumber: 1,
  title: 'The Tuesday Shift',
  premise: 'A charge nurse covers for someone and cannot stop covering.',
  spine: 'Whether Ruth was protecting the patient or herself, settled in the last episode.',
  world: ['The hospital runs on a rota nobody has ever seen written down.'],
  carryCast: [{ name: 'Ruth', who: 'Charge nurse, twenty years of nights.' }],
  promises: [{ id: 'the-lie', text: 'Why did Ruth lie about the Tuesday shift' }],
  episodes: [
    card(1, { plants: ['the-lie'] }),
    card(2),
    card(3),
    card(4),
    card(5, { paysOff: ['the-lie'], cliffhanger: '' }),
  ],
  ...over,
});

const bible = (over: Partial<Bible> = {}): Bible => ({
  personaId: 'night-shift',
  entities: [],
  episodes: [],
  ...over,
});

describe('checkPlan', () => {
  it('passes a season that plants, pays and lands', () => {
    expect(checkPlan(plan())).toEqual([]);
  });

  /**
   * THE CHECK THE FILE EXISTS FOR. Nothing else in the pipeline can see this:
   * every episode passes its own checks, the prose is fine, and the season
   * still never answers the question it spent five episodes asking.
   */
  it('catches a promise that is never paid off', () => {
    const problems = checkPlan(
      plan({
        episodes: [card(1, { plants: ['the-lie'] }), card(2), card(3), card(4), card(5, { cliffhanger: '' })],
      })
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('never paid off');
    expect(problems[0]).toContain('Why did Ruth lie');
  });

  it('catches a promise paid off before it is planted', () => {
    const problems = checkPlan(
      plan({
        episodes: [
          card(1, { paysOff: ['the-lie'] }),
          card(2),
          card(3),
          card(4),
          card(5, { plants: ['the-lie'], cliffhanger: '' }),
        ],
      })
    );

    expect(problems.some((p) => p.includes('at or before'))).toBe(true);
  });

  /**
   * A thread opened and closed inside one episode is a scene. Counting it as a
   * season promise is how a plan comes to look like it has five threads and a
   * season comes to feel like it has none.
   */
  it('rejects a promise opened and closed in the same episode', () => {
    const problems = checkPlan(
      plan({
        episodes: [
          card(1, { plants: ['the-lie'], paysOff: ['the-lie'] }),
          card(2),
          card(3),
          card(4),
          card(5, { cliffhanger: '' }),
        ],
      })
    );

    expect(problems.some((p) => p.includes('scene, not a thread'))).toBe(true);
  });

  it('catches a reference to a promise that does not exist', () => {
    const problems = checkPlan(
      plan({ episodes: [card(1, { plants: ['the-lie', 'invented'] }), card(2), card(3), card(4), card(5, { paysOff: ['the-lie'], cliffhanger: '' })] })
    );

    expect(problems.some((p) => p.includes('"invented"'))).toBe(true);
  });

  it('requires a cliffhanger on every episode but the last', () => {
    const problems = checkPlan(
      plan({
        episodes: [
          card(1, { plants: ['the-lie'] }),
          card(2, { cliffhanger: '   ' }),
          card(3),
          card(4),
          card(5, { paysOff: ['the-lie'], cliffhanger: '' }),
        ],
      })
    );

    expect(problems).toContain(
      'episode 2 has no cliffhanger, so nothing makes the next one necessary'
    );
  });

  /**
   * The inverse, and it matters more than it looks. A finale that opens instead
   * of landing is the thing that makes a season unrecommendable, which is the
   * only way a serial grows.
   */
  it('rejects a finale that ends on a cliffhanger', () => {
    const problems = checkPlan(
      plan({
        episodes: [card(1, { plants: ['the-lie'] }), card(2), card(3), card(4), card(5, { paysOff: ['the-lie'] })],
      })
    );

    expect(problems.some((p) => p.includes('the finale has a cliffhanger'))).toBe(true);
  });

  /**
   * The most expensive error on the list. A host is a bought, registered voice,
   * so a season planned around somebody else cannot be recorded, and the first
   * place anybody would notice is the render, after every episode was paid for.
   */
  it("catches a season that leaves out one of the show's own hosts", () => {
    const problems = checkPlan(plan(), ['Ruth', 'Femi']);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Femi');
    expect(problems[0]).toContain('cannot be recorded');
  });

  it('accepts hosts under any casing', () => {
    expect(checkPlan(plan(), ['ruth'])).toEqual([]);
  });

  it('checks no hosts when none are given', () => {
    expect(checkPlan(plan())).toEqual([]);
  });

  it('caps the cast at what an ear can carry', () => {
    const tooMany = Array.from({ length: MAX_CARRY_CAST + 1 }, (_, i) => ({
      name: `Person ${i}`,
      who: 'Somebody the listener is asked to remember.',
    }));

    expect(checkPlan(plan({ carryCast: tooMany })).some((p) => p.includes('to remember'))).toBe(
      true
    );
  });

  it('catches gapped or reordered episode numbers', () => {
    const problems = checkPlan(
      plan({
        episodes: [card(1, { plants: ['the-lie'] }), card(3), card(4), card(5), card(6, { paysOff: ['the-lie'], cliffhanger: '' })],
      })
    );

    expect(problems.some((p) => p.includes('is numbered 3'))).toBe(true);
  });
});

describe('briefForEpisode', () => {
  /**
   * THE LINE THAT SEPARATES A CLIFFHANGER AIMED AT FROM ONE ARRIVED AT. A
   * writer that cannot see where the next episode starts can only stop
   * somewhere tense.
   */
  it('shows the writer where the next episode picks up', () => {
    const brief = briefForEpisode(plan(), bible(), 1);
    expect(brief).toContain('WHERE THE NEXT EPISODE PICKS UP');
  });

  /**
   * And the other half of the same decision. A writer shown the whole season
   * writes towards the finale from episode two, and planting becomes
   * announcing.
   */
  it('does not show the writer any card beyond the next one', () => {
    const p = plan({
      episodes: [
        card(1, { plants: ['the-lie'] }),
        card(2),
        card(3, { opens: 'THE THIRD EPISODE OPENING' }),
        card(4),
        card(5, { paysOff: ['the-lie'], cliffhanger: '' }),
      ],
    });

    expect(briefForEpisode(p, bible(), 1)).not.toContain('THE THIRD EPISODE OPENING');
  });

  it('tells the finale it is the finale rather than asking for a cliffhanger', () => {
    const brief = briefForEpisode(plan(), bible(), 5);
    expect(brief).toContain('This is the finale');
    expect(brief).not.toContain('WHERE THE NEXT EPISODE PICKS UP');
  });

  /** A scene that ignores a question the listener is holding reads as forgetting. */
  it('lists threads the listener is carrying but that this episode does not answer', () => {
    const brief = briefForEpisode(plan(), bible(), 3);
    expect(brief).toContain('STILL OPEN');
    expect(brief).toContain('Why did Ruth lie');
  });

  it('does not list a thread before it has been planted', () => {
    const p = plan({
      episodes: [
        card(1),
        card(2),
        card(3, { plants: ['the-lie'] }),
        card(4),
        card(5, { paysOff: ['the-lie'], cliffhanger: '' }),
      ],
    });

    expect(briefForEpisode(p, bible(), 1)).not.toContain('STILL OPEN');
  });

  it('refuses an episode number the season does not have', () => {
    expect(() => briefForEpisode(plan(), bible(), 9)).toThrow(/no episode 9/);
  });
});

describe('planDrift', () => {
  it('says nothing before any episode has been written', () => {
    expect(planDrift(plan(), bible())).toEqual([]);
  });

  /**
   * Advisory and never blocking, because when intention and history disagree,
   * the history is what happened.
   */
  it('reports a carry character the episodes never established', () => {
    const written = bible({
      episodes: [
        { id: 'e1', title: 'One', synopsis: 'Something happened.' },
        { id: 'e2', title: 'Two', synopsis: 'Something else happened.' },
      ],
    });

    const notes = planDrift(plan(), written);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Ruth');
  });

  it('does not complain about someone the plan introduces later', () => {
    const written = bible({
      episodes: [{ id: 'e1', title: 'One', synopsis: 'Something happened.' }],
    });

    expect(planDrift(plan(), written)).toEqual([]);
  });
});

describe('renderPlan', () => {
  it('resolves promise ids to the question a listener would hold', () => {
    const out = renderPlan(plan());
    expect(out).toContain('PLANTS      Why did Ruth lie about the Tuesday shift');
    expect(out).not.toContain('PLANTS      the-lie');
  });

  it('names the finale as landing rather than leaving it blank', () => {
    expect(renderPlan(plan())).toContain('the finale, which lands');
  });
});

describe('locateEpisode', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-locate-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('maps an overall episode number onto its season', () => {
    savePlan(plan(), dir);
    savePlan(plan({ seasonNumber: 2, title: 'Second' }), dir);

    expect(locateEpisode('night-shift', 1, dir)?.number).toBe(1);
    expect(locateEpisode('night-shift', 5, dir)?.number).toBe(5);

    // The first episode of season two, which the bible counts as the sixth.
    const sixth = locateEpisode('night-shift', 6, dir);
    expect(sixth?.plan.seasonNumber).toBe(2);
    expect(sixth?.number).toBe(1);
  });

  /** Not an error. It is a show that needs its next season broken. */
  it('returns null past the end of what has been planned', () => {
    savePlan(plan(), dir);
    expect(locateEpisode('night-shift', 6, dir)).toBeNull();
  });

  it('returns null for a show with no plan at all', () => {
    expect(locateEpisode('night-shift', 1, dir)).toBeNull();
  });

  /**
   * A gap is the end. Guessing which card episode six wants when season two was
   * never planned is exactly the guess this module exists to prevent.
   */
  it('treats a missing season as the end rather than skipping it', () => {
    savePlan(plan(), dir);
    savePlan(plan({ seasonNumber: 3, title: 'Third' }), dir);

    expect(locateEpisode('night-shift', 6, dir)).toBeNull();
  });
});

describe('savePlan and loadPlan', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-season-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a plan', () => {
    savePlan(plan(), dir);
    expect(loadPlan('night-shift', 1, dir)).toEqual(plan());
  });

  /** A season that has not been planned is not an error, it is a season to plan. */
  it('returns null for a season that does not exist', () => {
    expect(loadPlan('night-shift', 4, dir)).toBeNull();
  });

  it('keeps seasons of one show apart', () => {
    savePlan(plan(), dir);
    savePlan(plan({ seasonNumber: 2, title: 'The Second One' }), dir);

    expect(loadPlan('night-shift', 1, dir)?.title).toBe('The Tuesday Shift');
    expect(loadPlan('night-shift', 2, dir)?.title).toBe('The Second One');
  });
});
