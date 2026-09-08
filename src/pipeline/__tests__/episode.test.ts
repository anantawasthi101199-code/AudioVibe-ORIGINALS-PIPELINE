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
const PERSONA_ID = 'the-teardown';
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
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FOUNDRY_RUNS_DIR;
  });

  // Renders are faked, so durations come from a stubbed probe rather than
  // ffmpeg. The beat map arithmetic itself is covered in render tests.
  const renderStubs = () => {
    jest.spyOn(assemble, 'probeDuration').mockResolvedValue(65);
    jest.spyOn(assemble, 'concatBeats').mockResolvedValue(undefined);
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
    renderStubs();
    const run = makeRun();
    const deps = buildDeps();
    await runEpisode(run, deps);
    expect((deps.tts as TtsProvider & { calls: number }).calls).toBe(BEATS.length);
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
});
