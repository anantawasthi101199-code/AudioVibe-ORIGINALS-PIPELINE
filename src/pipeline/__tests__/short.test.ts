/**
 * The short lane, end to end, derived from a real episode run.
 *
 * The episode is produced first with the same fakes the episode test uses,
 * rather than a hand-written parent artifact. That is deliberate: the thing
 * most likely to break here is the SHAPE of what the parent wrote, and a
 * hand-built fixture is exactly the thing that stays in step with a stale idea
 * of that shape while the real pipeline moves on.
 *
 * What is pinned: it costs a fraction of an episode, it refuses to derive from
 * anything unverified, and its run answers "where did that come from" without
 * needing the parent directory.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { LlmClient, LlmRequest, LlmResponse } from '../../models/client';
import { HttpResponse } from '../../evidence/fetch';
import { SearchProvider } from '../../evidence/search';
import { TtsProvider } from '../../render/tts';
import * as assemble from '../../render/assemble';
import { sourceIdFor } from '../../evidence/source';
import { claimSchema } from '../../evidence/claim';
import { claimSetSchema, corpusSchema } from '../../evidence/research';
import { scriptSchema } from '../../script/write';
import { renderResultSchema } from '../../render/assemble';
import { Run } from '../../run/store';
import { runEpisode, PipelineDeps } from '../episode';
import { runShort } from '../short';

const PERSONA_ID = 'the-teardown';
const FORMAT_ID = 'case-study-teardown';
const SHORT_FORMAT_ID = 'short-teardown';

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
      } else if (req.system.includes('single strongest moment')) {
        // The short selection. Two claims from two different parent beats, so
        // the redistribution has something real to re-point.
        text = JSON.stringify({
          angle: 'the column that was always filled in a week early',
          claimIds: ['c0_0', 'c4_1'],
          reason: 'it is one specific thing and it needs no setup',
        });
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

const fakeVerifier = (): LlmClient => ({
  name: 'fake-verifier',
  model: 'verifier-1',
  async complete(): Promise<LlmResponse> {
    return {
      text: '{"verdict":"entailed","reason":"yes"}',
      inputTokens: 5,
      outputTokens: 5,
      costPence: 0.01,
      model: 'verifier-1',
    };
  },
});

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

describe('runShort', () => {
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-short-'));
    sourceIdRef = { id: sourceIdFor('https://www.sec.gov/a') };
    process.env.FOUNDRY_EPISODE_BUDGET_PENCE = '10000';
    process.env.FOUNDRY_RUNS_DIR = root;

    // A short is 60 to 90 seconds; the episode is ten minutes. The stub has to
    // answer differently for each or one of them fails the duration gate.
    let call = 0;
    jest.spyOn(assemble, 'probeDuration').mockImplementation(async () => (call++ < 10 ? 65 : 15));
    jest.spyOn(assemble, 'concatBeats').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FOUNDRY_RUNS_DIR;
  });

  /** A finished, gate-passing episode to cut from. */
  const makeParent = async (): Promise<Run> => {
    const run = Run.create({ personaId: PERSONA_ID, formatId: FORMAT_ID, topic: 'A fine' }, { root });
    await runEpisode(run, buildDeps());
    return run;
  };

  it('produces a short from a finished episode', async () => {
    const parent = await makeParent();
    const { run, script, gate } = await runShort(
      { parent, formatId: SHORT_FORMAT_ID },
      buildDeps()
    );

    expect(run.manifest.derivedFrom).toBe(parent.id);
    expect(run.manifest.formatId).toBe(SHORT_FORMAT_ID);
    expect(script.beats).toHaveLength(5);

    // The evidence and format checks pass on real inherited claims. Style and
    // self-similarity deliberately DO fire, because the fake writer returns one
    // identical paragraph for every beat of both the parent and the short -
    // that is the gate working, and the self-similarity test below depends on
    // it. Asserting a clean gate here would mean writing a fixture good enough
    // to pass a prose check, which tests the fixture rather than the pipeline.
    const structural = gate.findings
      .filter((f) => f.blocking)
      .filter((f) => !f.check.startsWith('style:') && f.check !== 'selfSimilarity');
    expect(structural).toEqual([]);
  });

  it('fills the beats that require a fact', async () => {
    // The short format puts floors on the beat that states the thing and the
    // beat that answers it, and on nothing else - four floors in seventy-five
    // seconds would make it a list. What matters is that the two that have one
    // are actually filled.
    const parent = await makeParent();
    const { gate } = await runShort({ parent, formatId: SHORT_FORMAT_ID }, buildDeps());

    expect(gate.findings.filter((f) => f.check === 'evidenceDensity')).toEqual([]);
  });

  it('costs a fraction of what the parent cost', async () => {
    // The entire case for deriving. Research, extraction, verification and the
    // counter-evidence pass are inherited rather than repeated, so the short
    // pays for one selection call, five short beats and a render.
    const parent = await makeParent();
    const { run } = await runShort({ parent, formatId: SHORT_FORMAT_ID }, buildDeps());

    expect(run.manifest.spentPence).toBeLessThan(parent.manifest.spentPence / 2);
  });

  it('keeps the parent voices, because they are the same people', async () => {
    // A short in a different voice is a different show, whatever the artwork
    // says. It comes from the parent's persona rather than from a format field
    // precisely so this cannot drift.
    const parent = await makeParent();
    const { script } = await runShort({ parent, formatId: SHORT_FORMAT_ID }, buildDeps());

    const speakers = new Set(script.beats.flatMap((b) => b.turns.map((t) => t.speaker)));
    expect([...speakers].sort()).toEqual(['reporter', 'sceptic']);
  });

  it('writes its own evidence artifacts, narrowed to what it says', async () => {
    // A run is a directory somebody opens when an episode says something wrong.
    // One that answers "where did that come from" with "read the other
    // directory" has given up the property the store exists for.
    const parent = await makeParent();
    const { run } = await runShort({ parent, formatId: SHORT_FORMAT_ID }, buildDeps());

    const { claims } = run.readArtifact('claims', z.object({ claims: z.array(claimSchema) }));
    expect(claims.map((c) => c.id).sort()).toEqual(['c0_0', 'c4_1']);

    // Re-pointed at the SHORT's beats. Handed claims addressed to `mechanism`
    // while writing `pivot`, the writer sees none for the beat in front of it
    // and writes a beat with no facts in it, which passes silently.
    const shortBeatIds = run.readArtifact('script', z.object({ beats: z.array(z.object({ beatId: z.string() })) }))
      .beats.map((b) => b.beatId);
    for (const claim of claims) {
      expect(shortBeatIds).toContain(claim.beatId);
    }

    const corpus = run.readArtifact('corpus', z.object({ sources: z.array(z.object({ id: z.string() })) }));
    expect(corpus.sources.map((s) => s.id)).toEqual([sourceIdRef.id]);
  });

  it('leaves artifacts the publish command can actually read', async () => {
    // The gap nothing else would catch. Every stage of this pipeline succeeded
    // while writing a `claims` artifact one field short of the shape the
    // publisher parses, so a short could be made, gated and read, and then
    // failed at the last command with a schema error.
    const parent = await makeParent();
    const { run } = await runShort({ parent, formatId: SHORT_FORMAT_ID }, buildDeps());

    expect(() => run.readArtifact('claims', claimSetSchema)).not.toThrow();
    expect(() => run.readArtifact('corpus', corpusSchema)).not.toThrow();
    expect(() => run.readArtifact('script', scriptSchema)).not.toThrow();
    expect(() => run.readArtifact('render', renderResultSchema)).not.toThrow();
  });

  it('never gives the button beat a claim to recite', async () => {
    const parent = await makeParent();
    const { run } = await runShort({ parent, formatId: SHORT_FORMAT_ID }, buildDeps());
    const { claims } = run.readArtifact('claims', z.object({ claims: z.array(claimSchema) }));

    expect(claims.map((c) => c.beatId)).not.toContain('button');
  });

  it('resumes into the same run rather than making a second one', async () => {
    // Otherwise a rerun after a gate failure accumulates half-finished shorts,
    // each having paid for its own render.
    const parent = await makeParent();
    const first = await runShort({ parent, formatId: SHORT_FORMAT_ID }, buildDeps());
    const spentAfterFirst = first.run.manifest.spentPence;

    const second = await runShort({ parent, formatId: SHORT_FORMAT_ID }, buildDeps());

    expect(second.run.id).toBe(first.run.id);
    expect(second.run.manifest.spentPence).toBe(spentAfterFirst);
  });

  it('REFUSES to derive from a run that has not been verified', async () => {
    // A short cut from an unverified parent would carry the parent's label and
    // apparent authority with none of its checking.
    const bare = Run.create({ personaId: PERSONA_ID, formatId: FORMAT_ID, topic: 'x' }, { root });

    await expect(runShort({ parent: bare, formatId: SHORT_FORMAT_ID }, buildDeps())).rejects.toThrow(
      /has not finished verification/
    );
  });

  it('REFUSES a format that is not a short', async () => {
    const parent = await makeParent();

    await expect(runShort({ parent, formatId: FORMAT_ID }, buildDeps())).rejects.toThrow(
      /is a long format/
    );
  });

  it('compares the short against its parent for self-similarity', async () => {
    // A short that reuses its parent's sentences is the trailer this lane
    // exists not to be, and nothing else in the pipeline would notice. The fake
    // writer returns the SAME prose for every beat, so the parent comparison
    // must fire here - which is the assertion that the comparison is wired at
    // all rather than silently absent.
    const parent = await makeParent();
    const { gate } = await runShort({ parent, formatId: SHORT_FORMAT_ID }, buildDeps());

    const similarity = gate.findings.find((f) => f.check === 'selfSimilarity');
    expect(similarity?.detail).toMatch(/parent episode/);
  });
});
