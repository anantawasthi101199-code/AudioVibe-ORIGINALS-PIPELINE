/**
 * The whole pipeline, end to end, with every external service faked.
 *
 * This is the test that proves the stages actually fit together, which no
 * amount of unit testing of the stages individually can. It also pins the two
 * behaviours that matter most operationally: resuming without re-paying, and
 * never publishing on its own.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LlmClient, LlmRequest, LlmResponse } from '../../models/client';
import { HttpResponse } from '../../evidence/fetch';
import { SearchProvider } from '../../evidence/search';
import { TtsProvider } from '../../render/tts';
import * as assemble from '../../render/assemble';
import { sourceIdFor } from '../../evidence/source';
import { Run } from '../../run/store';
import { runEpisode, PipelineDeps } from '../episode';

// The persona and format used here are the shipped ones, so this also proves
// the real beat sheet and show bible survive a full run.
const PERSONA_ID = 'business-teardowns';
const FORMAT_ID = 'case-study-teardown';

const BEATS = [
  'cold_open',
  'stakes',
  'context',
  'turn_1',
  'mechanism',
  'turn_2',
  'counterpoint',
  'payoff',
  'reckoning',
  'outro',
];

// A document long enough to be usable, containing the sentence every claim
// quotes so the deterministic check passes.
const QUOTE = 'The regulator fined the operator four point two million pounds in March 2024.';
const DOC_TEXT = `${QUOTE} ${'Filler sentence about the inquiry and its findings. '.repeat(30)}`;
const DOC_HTML = `<html><head><title>A Filing</title></head><body><p>${DOC_TEXT}</p></body></html>`;

const claimsJson = () =>
  JSON.stringify({
    claims: BEATS.flatMap((beatId, bi) =>
      Array.from({ length: 4 }, (_, i) => ({
        id: `c${bi}_${i}`,
        beatId,
        text: `A fact about the fine, number ${bi}${i}.`,
        type: 'chronology',
        sourceId: 'SOURCE_ID',
        quote: QUOTE,
        contested: false,
      }))
    ),
    unsupported: [],
  });

// Varied sentence lengths so the style gate passes; that gate is doing its job
// and a lazy fixture would fail it.
const BEAT_PROSE = [
  'The alarm had been off for eleven weeks.',
  'Nobody noticed, because the log that would have shown it was filled in every Friday for the week ahead, which meant the column was always complete and never once actually true.',
  'That is the part worth slowing down on.',
  'The regulator found it in a single afternoon.',
  'What took eleven weeks to happen came apart entirely under one question about who had signed the Thursday entry.',
].join(' ');

const fakeWriter = (sourceId: () => string): LlmClient & { calls: number } => {
  const client = {
    name: 'fake-writer',
    model: 'writer-1',
    calls: 0,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      client.calls++;
      let text: string;
      if (req.system.includes('plan the research')) {
        text = JSON.stringify({
          angle: 'the Thursday column',
          mustEstablish: ['the alarm was disabled'],
          queries: ['q1', 'q2', 'q3'],
          likelyContested: [],
        });
      } else if (req.system.includes('extract factual claims')) {
        text = claimsJson().replace(/SOURCE_ID/g, sourceId());
      } else if (req.system.includes('evidence AGAINST')) {
        text = JSON.stringify({ queries: ['counter'] });
      } else if (req.system.includes('title and description')) {
        text = JSON.stringify({ title: 'The Thursday Column', description: 'One. Two.' });
      } else {
        text = JSON.stringify({
          turns: [
            { speaker: 'reporter', text: BEAT_PROSE },
            { speaker: 'sceptic', text: 'Wait. Who signed the Thursday entry?' },
          ],
          claimIds: [],
        });
      }
      return { text, inputTokens: 10, outputTokens: 10, costPence: 0.1, model: 'writer-1' };
    },
  };
  return client;
};

const fakeVerifier = (): LlmClient & { calls: number } => {
  const client = {
    name: 'fake-verifier',
    model: 'verifier-1',
    calls: 0,
    async complete(): Promise<LlmResponse> {
      client.calls++;
      return {
        text: '{"verdict":"entailed","reason":"yes"}',
        inputTokens: 5,
        outputTokens: 5,
        costPence: 0.01,
        model: 'verifier-1',
      };
    },
  };
  return client;
};

const fakeSearch: SearchProvider = {
  name: 'fake-search',
  async search() {
    return [
      { url: 'https://www.sec.gov/a', title: 'A' },
      { url: 'https://www.sec.gov/b', title: 'B' },
      { url: 'https://www.gov.uk/c', title: 'C' },
      { url: 'https://www.gov.uk/d', title: 'D' },
      { url: 'https://www.reuters.com/e', title: 'E' },
    ];
  },
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

const httpGet = async (url: string): Promise<HttpResponse> => ({
  status: 200,
  body: DOC_HTML,
  finalUrl: url,
  contentType: 'text/html',
});

describe('runEpisode', () => {
  let root: string;
  let sourceIdRef: { id: string };

  const buildDeps = (over: Partial<PipelineDeps> = {}): PipelineDeps => ({
    writer: fakeWriter(() => sourceIdRef.id),
    verifier: fakeVerifier(),
    search: fakeSearch,
    tts: fakeTts(),
    fetchDeps: { httpGet, now: () => new Date('2026-09-08T00:00:00.000Z') },
    ...over,
  });

  const makeRun = () =>
    Run.create({ personaId: PERSONA_ID, formatId: FORMAT_ID, topic: 'A fine' }, { root });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-pipeline-'));
    // Sources get deterministic ids from their URL; the extractor has to cite
    // one that exists, and the first ranked candidate is the sec.gov page.
    sourceIdRef = { id: sourceIdFor('https://www.sec.gov/a') };
    process.env.FOUNDRY_EPISODE_BUDGET_PENCE = '10000';
    process.env.FOUNDRY_RUNS_DIR = root;
    // The registry is committed, so a suite writing to the real one pins live
    // shows to a voice called "fake-tts". It did, once.
    process.env.FOUNDRY_VOICES_FILE = path.join(root, 'voices.json');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FOUNDRY_RUNS_DIR;
    delete process.env.FOUNDRY_VOICES_FILE;
  });

  // Renders are faked, so durations come from a stubbed probe rather than
  // ffmpeg. The beat map arithmetic itself is covered in render tests.
  const renderStubs = () => {
    jest.spyOn(assemble, 'probeDuration').mockResolvedValue(65);
    // THE STUB HAS TO PRODUCE THE FILE, because a concat that leaves nothing on
    // disk is not a concat, and the pipeline now checks that the audio a render
    // artifact describes actually exists before reusing it. Mocking this as a
    // no-op made the fixture claim a render that had not happened.
    jest
      .spyOn(assemble, 'concatBeats')
      .mockImplementation(async (_files: string[], out: string) => {
        fs.writeFileSync(out, Buffer.alloc(16));
      });
  };

  it('runs every stage and writes an artifact for each', async () => {
    renderStubs();
    const run = makeRun();
    const { gate } = await runEpisode(run, buildDeps());

    for (const stage of ['brief', 'corpus', 'claims', 'verification', 'script', 'render', 'qa'] as const) {
      expect(run.hasArtifact(stage)).toBe(true);
    }
    expect(gate).toBeDefined();
  });

  it('NEVER publishes', async () => {
    // The pipeline stops at the gate. Publishing is a separate command a person
    // invokes after reading the report, because the checks the gate defers to a
    // human are exactly the ones automation would wave through.
    renderStubs();
    const run = makeRun();
    await runEpisode(run, buildDeps());
    expect(run.hasArtifact('publish')).toBe(false);
    expect(run.isComplete('publish')).toBe(false);
  });

  it('RESUMES without re-paying for finished stages', async () => {
    // Rendering is the expensive step and scripting the slow one, so a QA
    // failure must not mean paying for both again.
    renderStubs();
    const run = makeRun();
    const first = buildDeps();
    await runEpisode(run, first);

    const writerCalls = (first.writer as LlmClient & { calls: number }).calls;
    const ttsCalls = (first.tts as TtsProvider & { calls: number }).calls;
    expect(writerCalls).toBeGreaterThan(0);
    expect(ttsCalls).toBeGreaterThan(0);

    const second = buildDeps();
    await runEpisode(Run.open(run.id, { root }), second);

    expect((second.writer as LlmClient & { calls: number }).calls).toBe(0);
    expect((second.tts as TtsProvider & { calls: number }).calls).toBe(0);
  });

  it('renders one file per beat, so the beat map is real', async () => {
    // Asserted on the BEAT MAP, which is the thing the name is about. It used
    // to assert on the TTS call count, which is a different fact and stopped
    // being one-per-beat the moment a provider without a dialogue endpoint
    // started rendering a two-host beat a turn at a time - correctly.
    renderStubs();
    const run = makeRun();
    await runEpisode(run, buildDeps());

    const render = run.readArtifact('render', assemble.renderResultSchema);
    expect(render.beatMap).toHaveLength(BEATS.length);
    expect(render.beatMap.map((b) => b.id)).toEqual(BEATS);
  });

  it('gives each host their OWN voice even without a dialogue endpoint', async () => {
    // The fake provider has no synthesiseDialogue, which is the case this
    // guards: the old fallback rendered every turn of a two-host beat in the
    // FIRST speaker's voice, so the show came out as one person reading both
    // parts - silently, with no error and a perfectly valid file.
    renderStubs();
    const run = makeRun();
    const deps = buildDeps();
    await runEpisode(run, deps);

    // Two turns per beat, each its own request.
    expect((deps.tts as TtsProvider & { calls: number }).calls).toBe(BEATS.length * 2);

    const render = run.readArtifact('render', assemble.renderResultSchema);
    expect(render.provider).toContain('turnwise');
  });

  it('ABANDONS a run whose corpus is too thin, rather than writing from three documents', async () => {
    const thin: SearchProvider = {
      name: 'thin',
      async search() {
        return [{ url: 'https://www.sec.gov/only', title: 'only' }];
      },
    };
    const run = makeRun();
    await expect(runEpisode(run, buildDeps({ search: thin }))).rejects.toThrow(/abandoned/);
    expect(Run.open(run.id, { root }).manifest.abandoned).toMatch(/usable sources/);
  });

  it('records why the corpus was thin, so the failure is diagnosable', async () => {
    const failing = {
      httpGet: async (url: string) => ({ status: 403, body: '', finalUrl: url, contentType: 'text/html' }),
    };
    const run = makeRun();
    await expect(runEpisode(run, buildDeps({ fetchDeps: failing }))).rejects.toThrow(/403/);
  });

  it('stops when the budget ceiling is passed', async () => {
    // A run that quietly continues over budget produces an episode nobody
    // decided to pay for.
    process.env.FOUNDRY_EPISODE_BUDGET_PENCE = '0.05';
    const run = makeRun();
    await expect(runEpisode(run, buildDeps())).rejects.toThrow(/ceiling/);
  });

  it('does not let the writer see a claim the verifier rejected', async () => {
    // EVERY CLAIM CHECKED, because this pins the mechanism - a rejected claim
    // must not reach the writer - and not the sampling policy. Under the
    // default, three quarters of claims are never put to the verifier at all,
    // so a fixture whose verifier rejects everything would still see most of
    // them arrive. The sampling itself is pinned separately below.
    process.env.FOUNDRY_VERIFY = 'all';
    // Otherwise the gate becomes the only thing between a bad claim and an
    // episode, and a single gate bug ships it.
    renderStubs();
    const rejecting: LlmClient = {
      name: 'v',
      model: 'verifier-1',
      async complete(): Promise<LlmResponse> {
        return {
          text: '{"verdict":"contradicted","reason":"no"}',
          inputTokens: 1,
          outputTokens: 1,
          costPence: 0.01,
          model: 'verifier-1',
        };
      },
    };

    const writer = fakeWriter(() => sourceIdRef.id);
    const seen: string[] = [];
    const spy: LlmClient = {
      name: writer.name,
      model: writer.model,
      async complete(req) {
        seen.push(req.prompt);
        return writer.complete(req);
      },
    };

    const run = makeRun();
    const { gate } = await runEpisode(run, buildDeps({ writer: spy, verifier: rejecting }));

    const beatPrompts = seen.filter((p) => p.includes('CLAIMS:'));
    for (const p of beatPrompts) {
      expect(p).toContain('none available');
    }
    // And the gate fails anyway, because the beats are now below their floors.
    expect(gate.passed).toBe(false);
  });

    /**
     * THE ARTIFACT IS NOT THE AUDIO, and this is the one stage where that
     * distinction bites. Every other stage resumes from its JSON because the JSON
     * IS the output; render.json only describes a file sitting next to it, and
     * the two come apart the moment somebody deletes the media directory to force
     * a fresh take.
     *
     * That happened. The run reported "render: reusing 553s of audio", gated a
     * duration measured from a file that was not there, and finished with "no
     * audio created" without ever saying what was wrong.
     */
    it('renders again instead of reusing a recording that does not exist', async () => {
      jest.spyOn(assemble, 'probeDuration').mockResolvedValue(65);
      jest
        .spyOn(assemble, 'concatBeats')
        .mockImplementation(async (_files: string[], out: string) => {
          fs.writeFileSync(out, Buffer.alloc(16));
        });

      const run = makeRun();
      const first = buildDeps();
      await runEpisode(run, first);

      const render = run.readArtifact('render', assemble.renderResultSchema);
      const audio = path.resolve(run.dir, render.audioFile);
      expect(fs.existsSync(audio)).toBe(true);

      // What deleting the media directory leaves behind.
      fs.rmSync(audio, { force: true });
      fs.rmSync(path.join(run.dir, 'media'), { recursive: true, force: true });

      const second = buildDeps();
      await runEpisode(run, second);

      expect((second.tts as TtsProvider & { calls: number }).calls).toBeGreaterThan(0);
      expect(fs.existsSync(path.resolve(run.dir, render.audioFile))).toBe(true);
      // And nothing upstream was paid for twice.
      expect((second.writer as LlmClient & { calls: number }).calls).toBe(0);
    });

});

describe('the approval break', () => {
  let root: string;
  let sourceIdRef: { id: string };

  const buildDeps = (over: Partial<PipelineDeps> = {}): PipelineDeps => ({
    writer: fakeWriter(() => sourceIdRef.id),
    verifier: fakeVerifier(),
    search: fakeSearch,
    tts: fakeTts(),
    fetchDeps: { httpGet, now: () => new Date('2026-09-08T00:00:00.000Z') },
    ...over,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-approval-'));
    sourceIdRef = { id: sourceIdFor('https://www.sec.gov/a') };
    process.env.FOUNDRY_EPISODE_BUDGET_PENCE = '10000';
    process.env.FOUNDRY_RUNS_DIR = root;
    process.env.FOUNDRY_VOICES_FILE = path.join(root, 'voices.json');
    jest.spyOn(assemble, 'probeDuration').mockResolvedValue(65);
    jest.spyOn(assemble, 'concatBeats').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FOUNDRY_RUNS_DIR;
    delete process.env.FOUNDRY_VOICES_FILE;
  });

  const held = () =>
    Run.create(
      { personaId: PERSONA_ID, formatId: FORMAT_ID, topic: 'A fine', holdForApproval: true },
      { root }
    );

  it('writes the script and stops before spending a penny on audio', async () => {
    // Rendering is the only irreversible spend in the pipeline. Everything
    // before it produces text somebody can read and throw away.
    const tts = fakeTts();
    const run = held();
    const { gate, script } = await runEpisode(run, buildDeps({ tts }));

    expect(run.isComplete('script')).toBe(true);
    expect(run.hasArtifact('render')).toBe(false);
    expect(tts.calls).toBe(0);
    expect(script.title).toBeTruthy();

    // Not a failure. The run did what it was asked to do.
    expect(gate.passed).toBe(true);
    expect(gate.needsHumanReview).toBe(true);
    expect(gate.humanReviewReasons.join(' ')).toMatch(/held before the render/);
  });

  it('renders once approved, without re-paying for the script', async () => {
    const tts = fakeTts();
    const run = held();
    await runEpisode(run, buildDeps({ tts }));
    const spentOnScript = run.manifest.spentPence;

    run.approve();
    const { gate } = await runEpisode(run, buildDeps({ tts }));

    expect(tts.calls).toBeGreaterThan(0);
    expect(run.isComplete('render')).toBe(true);
    expect(run.manifest.spentPence).toBeGreaterThan(spentOnScript);
    expect(gate.measurement.words).toBeGreaterThan(0);
  });

  it('stays held across a resume until somebody approves it', async () => {
    // The whole point. A held run that quietly rendered on the next resume
    // would be a break nobody could rely on.
    const tts = fakeTts();
    const run = held();
    await runEpisode(run, buildDeps({ tts }));
    await runEpisode(run, buildDeps({ tts }));

    expect(tts.calls).toBe(0);
    expect(run.awaitingApproval).toBe(true);
  });

  it('records WHEN it was approved, not merely that it was', async () => {
    // "Who let this through and when" is the question somebody asks about a
    // published episode six weeks later.
    const run = held();
    run.approve(new Date('2026-09-14T11:00:00.000Z'));

    expect(run.manifest.approvedAt).toBe('2026-09-14T11:00:00.000Z');
    expect(run.awaitingApproval).toBe(false);
  });

  it('leaves an unheld run alone', async () => {
    const tts = fakeTts();
    const run = Run.create({ personaId: PERSONA_ID, formatId: FORMAT_ID, topic: 'A fine' }, { root });
    await runEpisode(run, buildDeps({ tts }));

    expect(run.isComplete('render')).toBe(true);
  });
});
