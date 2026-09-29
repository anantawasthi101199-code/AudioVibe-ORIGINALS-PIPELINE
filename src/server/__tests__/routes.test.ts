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
      'myths-of-the-world',
      'The Descent of Inanna to the Underworld, and the seven gates',
      'myths-of-the-world/e008-20260925-descent-of-inanna',
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
    channelId: 'myths-of-the-world',
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
