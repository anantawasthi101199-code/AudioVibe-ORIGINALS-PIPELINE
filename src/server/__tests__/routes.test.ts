/**
 * The interface and the command line must refuse the same things.
 *
 * THIS IS THE FAILURE THE FILE EXISTS FOR. A rule enforced in `cli.ts` and not
 * in `routes.ts` is a rule half the studio does not have, and the half without
 * it is the half with a button. The duplicate check was written on the command
 * line first, and for a while the interface would warn about a repeat on screen
 * and then cheerfully make it, which is worse than not warning at all.
 *
 * ONLY THE REFUSALS ARE TESTED HERE, AND THAT IS NOT LAZINESS. `startRun`
 * throws before `Run.create`, so a refused call touches nothing. A call that is
 * ALLOWED creates a run and starts a real job, and `config/index.ts` runs
 * `dotenv.config()` at import, so the suite has the live API keys: an allowed
 * call from a unit test genuinely researches and writes an episode. The first
 * version of this file did exactly that three times, and wrote three invented
 * subjects into the committed ledger on the way past.
 *
 * So: the happy path belongs to catalogue/covered.test.ts, which is arithmetic
 * over a fixture and spends nothing.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { recordMade, saveCatalogue } from '../../catalogue/covered';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-routes-'));

describe('startRun refuses a duplicate', () => {
  let startRun: typeof import('../routes').startRun;
  let HttpError: typeof import('../routes').HttpError;

  beforeAll(() => {
    // EVERY PATH REDIRECTED, INCLUDING THE LEDGER. Missing this one is how the
    // first version of this file polluted the committed catalogue.json.
    process.env.FOUNDRY_CATALOGUE_FILE = path.join(root, 'catalogue.json');
    process.env.FOUNDRY_RUNS_DIR = path.join(root, 'runs');
    process.env.FOUNDRY_VOICES_FILE = path.join(root, 'voices.json');
    process.env.FOUNDRY_BIBLES_DIR = path.join(root, 'bibles');

    saveCatalogue({ entries: [] }, root);
    recordMade(
      'mythic-archives',
      'The Descent of Inanna to the Underworld, and the seven gates',
      'mythic-archives/e008-20260925-descent-of-inanna',
      new Date('2026-09-25T10:00:00.000Z'),
      root
    );
  });

  beforeEach(async () => {
    jest.resetModules();
    const routes = await import('../routes');
    startRun = routes.startRun;
    HttpError = routes.HttpError;
  });

  afterAll(() => {
    delete process.env.FOUNDRY_CATALOGUE_FILE;
    delete process.env.FOUNDRY_RUNS_DIR;
    delete process.env.FOUNDRY_VOICES_FILE;
    delete process.env.FOUNDRY_BIBLES_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const body = (over: Record<string, unknown> = {}) => ({
    channelId: 'mythic-archives',
    formatId: 'myth-short',
    // Shorter than the recorded topic and contained in it, which is the shape
    // a real duplicate takes.
    topic: "Inanna's descent",
    ...over,
  });

  it('refuses a subject the channel has already covered', () => {
    expect(() => startRun(body())).toThrow(/already covered/i);
  });

  it('refuses with a 409 rather than a generic failure', () => {
    try {
      startRun(body());
      throw new Error('it should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as InstanceType<typeof HttpError>).status).toBe(409);
    }
  });

  it('names the earlier run, so it can be listened to before deciding', () => {
    expect(() => startRun(body())).toThrow(/e008-20260925-descent-of-inanna/);
  });

  it('says that nothing was spent', () => {
    expect(() => startRun(body())).toThrow(/Nothing has been spent/);
  });

  /**
   * The refusal happens before Run.create, which is the only reason a refused
   * call is free. If this ever fails, the check has moved below the creation
   * and a refused duplicate is leaving run directories behind.
   */
  it('creates no run when it refuses', () => {
    const runs = path.join(root, 'runs');
    const before = fs.existsSync(runs) ? fs.readdirSync(runs).length : 0;

    expect(() => startRun(body())).toThrow();

    const after = fs.existsSync(runs) ? fs.readdirSync(runs).length : 0;
    expect(after).toBe(before);
  });

  it('checks the format against the show before anything else', () => {
    expect(() => startRun(body({ formatId: 'news-short' }))).toThrow(/does not make/);
  });
});

/**
 * Route guards, read straight out of index.ts.
 *
 * WHY A SOURCE-READING TEST RATHER THAN AN HTTP ONE. The failure is not in any
 * handler, it is in the ORDER they are tried. Routes are matched top to bottom,
 * so an unguarded read above a write for the same path answers the write with
 * the read's body and a 200, the write never runs, and the page sees success.
 *
 * That was live on three routes at once: starting a run, deleting a run, and
 * making a beat. Nothing failed, nothing logged, and the only symptom was that
 * pressing the button did nothing at all.
 *
 * Driving real HTTP would need a listening server and the pipeline behind it;
 * the ordering is a property of the file and is checked as one.
 */
describe('route method guards', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'index.ts'),
    'utf8'
  );

  interface Guard {
    at: number;
    path: string;
    method: string | null;
  }

  const guards: Guard[] = [
    ...source.matchAll(/pathname === '(\/api\/[^']*)'(?:\s*&&\s*req\.method === '(\w+)')?/g),
  ].map((m) => ({ at: m.index ?? 0, path: m[1]!, method: m[2] ?? null }));

  it('finds the routes at all, so a rewrite does not make this pass vacuously', () => {
    expect(guards.length).toBeGreaterThan(20);
    expect(guards.some((g) => g.path === '/api/beats')).toBe(true);
  });

  it('never puts an unguarded read above a write for the same path', () => {
    const byPath = new Map<string, Guard[]>();
    for (const g of guards) {
      byPath.set(g.path, [...(byPath.get(g.path) ?? []), g]);
    }

    const swallowed: string[] = [];
    for (const [routePath, list] of byPath) {
      if (list.length < 2) continue;
      const ordered = [...list].sort((a, b) => a.at - b.at);
      const first = ordered[0]!;
      if (first.method === null && ordered.slice(1).some((g) => g.method !== null)) {
        swallowed.push(
          `${routePath}: an unguarded handler comes first, so ` +
            `${ordered
              .slice(1)
              .map((g) => g.method)
              .filter(Boolean)
              .join(', ')} never runs`
        );
      }
    }

    expect(swallowed).toEqual([]);
  });

  // THE SAME PATH AND METHOD TWICE: only the first ever runs. The publishing
  // page's Hold button posted to /api/run/hold, which the presence heartbeat
  // above answered, so nothing was ever parked (2026-10-08).
  it('never handles the same path and method twice', () => {
    const seen = new Map<string, number>();
    for (const g of guards.filter((x) => x.method)) {
      const key = `${g.method} ${g.path}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)).toEqual([]);
  });
});
