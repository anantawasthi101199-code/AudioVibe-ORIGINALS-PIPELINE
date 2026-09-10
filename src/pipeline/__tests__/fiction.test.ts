/**
 * The fiction lane, end to end.
 *
 * The behaviour this test exists for is the ordering at the end of the
 * pipeline: the bible is written ONLY on a pass. An episode that failed the
 * gate entering the series would mean every later episode gets checked against
 * something nobody ever heard, and marked as contradicting the series for
 * disagreeing with an episode that does not exist. That failure is invisible
 * for weeks and then poisons everything after it.
 *
 * Also pinned: it never searches, fetches or verifies a claim, because there is
 * nothing to verify - and that is most of what makes it cheap.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LlmClient, LlmRequest, LlmResponse } from '../../models/client';
import { SearchProvider } from '../../evidence/search';
import { TtsProvider } from '../../render/tts';
import * as assemble from '../../render/assemble';
import { Run } from '../../run/store';
import { loadBible } from '../../fiction/bible';
import { PipelineDeps } from '../episode';
import { runFiction } from '../fiction';

const PERSONA_ID = 'night-shift';
const FORMAT_ID = 'serial-episode';

// Seven distinct beats, because the gate scores the WHOLE script and one
// paragraph repeated seven times fails opener diversity and repeated phrases -
// correctly. A fixture that trips a working check tests the fixture, so these
// vary in length, opener and vocabulary the way the real writer is asked to.
const PROSE: Array<[string, string]> = [
  [
    'The board said four and there were six. Nobody had written the other two up, which happens, except that the times on them were an hour apart and both entries said the same thing in the same handwriting, which does not. Not tonight.',
    'Wait.',
  ],
  [
    'Handover took nine minutes. Whoever had been on before them left without telling anyone they were going, and the kettle in the staff room was still warm enough that she stood there looking at it for longer than she would have admitted to.',
    'Okay so nobody signed off, nobody said anything, and we are meant to just pick it up from a board that is already wrong? Am I wrong about that? Because it feels like I might be missing a normal explanation here.',
  ],
  [
    'By two the corridor had gone quiet in the particular way it does when something is about to stop being quiet. She checked bay three. Then she checked it again.',
    'Why twice?',
  ],
  [
    'They found it wedged behind the printer, which nobody has used since the referral system changed, underneath a stack of forms belonging to something decommissioned four years ago. Somebody put it there on purpose. That was the part that took a while to say out loud.',
    'The thing is you would have to know that printer was dead. You would have to work here. That narrows it down to about eleven people and I can name nine of them right now.',
  ],
  [
    'Everything about the timings fell apart once you laid them next to each other. An hour apart. Both signed, both in a hand belonging to somebody who had finished at eleven and gone home to a flat on the other side of the river.',
    'Say that again.',
  ],
  [
    'What it came down to was smaller than either of them had been imagining, and it had happened for a reason anybody who has ever covered a shift would recognise immediately. Someone had been holding a colleague up, badly, for about six weeks, and had finally run out of ways to keep doing it without anybody noticing.',
    'Six weeks. God.',
  ],
  [
    'Ruth put the folder into her own bag rather than back behind the printer where she had found it. Femi watched her do it. He said nothing at all, and neither of them mentioned it again before the end of the shift.',
    'Right.',
  ],
];

const fakeWriter = (
  over: { established?: string } = {}
): LlmClient & { calls: number; prompts: string[] } => {
  const client = {
    name: 'fake-writer',
    model: 'writer-1',
    calls: 0,
    beatCalls: 0,
    prompts: [] as string[],
    async complete(req: LlmRequest): Promise<LlmResponse> {
      client.calls++;
      client.prompts.push(req.prompt);
      let text: string;
      if (req.system.includes('title and description')) {
        text = JSON.stringify({ title: 'Six Admissions', description: 'One. Two.' });
      } else if (req.system.includes('what it ESTABLISHED')) {
        text =
          over.established ??
          JSON.stringify({
            newEntities: [
              { id: 'ward', kind: 'place', name: 'Ward', summary: 'The overnight ward.' },
            ],
            facts: [{ entityId: 'ward', text: 'The ward has 6 beds.', revisable: false }],
            synopsis: 'Two admissions nobody wrote up.',
          });
      } else {
        // A different paragraph per beat, cycling if the pipeline asks for more
        // (a revision re-asks for the same beat, which is fine - a repair
        // reading like the draft is the point of a repair).
        // Keyed to the BEAT, not to the call. writeBeat revises up to twice, so
        // advancing per call would cycle this list three times over and put the
        // same paragraph in three different beats - which then fails repeated
        // phrases, correctly, for a reason that has nothing to do with the
        // pipeline. A revision returning what the draft returned is also the
        // honest fake: a repair that reads like the draft is a repair.
        const isRevision = req.prompt.includes('YOUR PREVIOUS DRAFT');
        if (!isRevision) client.beatCalls++;
        const [senior, junior] = PROSE[(client.beatCalls - 1) % PROSE.length]!;
        text = JSON.stringify({
          turns: [
            { speaker: 'senior', text: senior },
            { speaker: 'junior', text: junior },
          ],
          claimIds: [],
        });
      }
      return { text, inputTokens: 10, outputTokens: 10, costPence: 0.1, model: 'writer-1' };
    },
  };
  return client;
};

const fakeChecker = (verdict = 'consistent'): LlmClient & { calls: number } => {
  const client = {
    name: 'fake-checker',
    model: 'checker-1',
    calls: 0,
    async complete(): Promise<LlmResponse> {
      client.calls++;
      return {
        text: JSON.stringify(
          Array.from({ length: 30 }, (_, i) => ({ index: i, verdict, reason: 'r' }))
        ),
        inputTokens: 5,
        outputTokens: 5,
        costPence: 0.02,
        model: 'checker-1',
      };
    },
  };
  return client;
};

/** Reaching either of these is itself the failure. */
const forbiddenSearch: SearchProvider = {
  name: 'forbidden',
  async search() {
    throw new Error('fiction must never search');
  },
};

const forbiddenGet = async (): Promise<never> => {
  throw new Error('fiction must never fetch');
};

const fakeTts = (): TtsProvider & { calls: number } => {
  const provider = {
    name: 'fake-tts',
    calls: 0,
    async synthesise() {
      provider.calls++;
      return {
        audio: Buffer.alloc(4000),
        provider: 'fake-tts',
        model: 'tts-1',
        voiceId: 'voice-1',
        costPence: 0.2,
      };
    },
  };
  return provider;
};

describe('runFiction', () => {
  let root: string;
  let bibles: string;

  const buildDeps = (over: Partial<PipelineDeps> = {}): PipelineDeps => ({
    writer: fakeWriter(),
    verifier: fakeChecker(),
    search: forbiddenSearch,
    tts: fakeTts(),
    fetchDeps: { httpGet: forbiddenGet },
    ...over,
  });

  const makeRun = () =>
    Run.create({ personaId: PERSONA_ID, formatId: FORMAT_ID, topic: 'A quiet night' }, { root });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-fiction-'));
    bibles = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-bibles-'));
    process.env.FOUNDRY_EPISODE_BUDGET_PENCE = '10000';
    process.env.FOUNDRY_RUNS_DIR = root;
    process.env.FOUNDRY_BIBLES_DIR = bibles;

    jest.spyOn(assemble, 'probeDuration').mockResolvedValue(95);
    jest.spyOn(assemble, 'concatBeats').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bibles, { recursive: true, force: true });
    delete process.env.FOUNDRY_RUNS_DIR;
    delete process.env.FOUNDRY_BIBLES_DIR;
  });

  it('writes a first episode with no research at all', async () => {
    // The search provider and the fetcher both throw. Reaching either is the
    // failure, and that is most of what makes fiction cheap: no brief, no
    // corpus, no quote binding, no verifier per claim.
    const { script, gate } = await runFiction({ run: makeRun() }, buildDeps());

    expect(script.beats).toHaveLength(7);
    expect(gate.findings.filter((f) => f.check === 'factuality')).toEqual([]);
    expect(gate.findings.filter((f) => f.check === 'evidenceDensity')).toEqual([]);
  });

  it('records what the episode established, ONLY after a pass', async () => {
    const result = await runFiction({ run: makeRun() }, buildDeps());
    expect(result.gate.passed).toBe(true);

    const saved = loadBible(PERSONA_ID, bibles);
    expect(saved.episodes).toHaveLength(1);
    expect(saved.entities.map((e) => e.id)).toContain('ward');
  });

  it('LEAVES THE BIBLE UNTOUCHED when the episode fails', async () => {
    // The ordering this whole file exists for. A failed episode in the bible
    // means every later episode is checked against something nobody heard, and
    // gets marked as contradicting the series for disagreeing with it.
    //
    // Needs a first episode to fail AGAINST: a series opener has nothing
    // established, so there is nothing it could contradict.
    await runFiction({ run: makeRun() }, buildDeps());
    const afterFirst = loadBible(PERSONA_ID, bibles);

    const { gate } = await runFiction(
      { run: makeRun() },
      buildDeps({ verifier: fakeChecker('contradicts') })
    );

    expect(gate.passed).toBe(false);
    expect(loadBible(PERSONA_ID, bibles)).toEqual(afterFirst);
  });

  it('checks the second episode against what the first established', async () => {
    await runFiction({ run: makeRun() }, buildDeps());

    const checker = fakeChecker();
    await runFiction({ run: makeRun() }, buildDeps({ verifier: checker }));

    // The first episode had nothing to check against and cost no call. The
    // second has the first's facts, so it does.
    expect(checker.calls).toBe(1);
  });

  it('hands the writer the cast rather than letting it invent one twice', async () => {
    // Continuity is not only a check. A writer given the established cast does
    // not invent a second version of the same character, which is the drift
    // the check would otherwise have to catch after the fact.
    await runFiction({ run: makeRun() }, buildDeps());

    const writer = fakeWriter();
    await runFiction({ run: makeRun() }, buildDeps({ writer }));

    expect(writer.prompts.some((p) => p.includes('The overnight ward.'))).toBe(true);
    expect(writer.prompts.some((p) => p.includes('Six Admissions'))).toBe(true);
  });

  it('costs a fraction of a researched episode', async () => {
    // No search, no fetch, no per-claim verification. Write, check continuity
    // once, render.
    const run = makeRun();
    await runFiction({ run }, buildDeps());
    expect(run.manifest.spentPence).toBeLessThan(300);
  });

  it('resumes without rewriting or re-rendering', async () => {
    const run = makeRun();
    await runFiction({ run }, buildDeps());
    const spentOnce = run.manifest.spentPence;

    const writer = fakeWriter();
    const tts = fakeTts();
    await runFiction({ run: Run.open(run.id, { root }) }, buildDeps({ writer, tts }));

    expect(writer.calls).toBe(0);
    expect(tts.calls).toBe(0);
    expect(Run.open(run.id, { root }).manifest.spentPence).toBe(spentOnce);

    // And the episode is in the series exactly once. The bible is append-only
    // and lives outside the run directory, so a second recording would never
    // be noticed - it would simply become two episodes that both happened.
    expect(loadBible(PERSONA_ID, bibles).episodes).toHaveLength(1);
  });

  it('REFUSES to run a factual show through it', async () => {
    // The one that would publish unsourced claims under a show whose entire
    // claim on a listener is that it read the documents.
    const factual = Run.create(
      { personaId: 'the-teardown', formatId: 'case-study-teardown', topic: 'x' },
      { root }
    );

    await expect(runFiction({ run: factual }, buildDeps())).rejects.toThrow(
      /not a fiction show/
    );
  });
});
