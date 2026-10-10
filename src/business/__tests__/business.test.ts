/**
 * The business-story lane: the free parts exactly, lane exclusivity, and a
 * whole run with every outside service faked.
 */
import fs from 'fs';
import { z } from 'zod';
import os from 'os';
import path from 'path';
import { LlmClient, LlmRequest, LlmResponse } from '../../models/client';
import { HttpResponse } from '../../evidence/fetch';
import { TtsProvider } from '../../render/tts';
import * as assemble from '../../render/assemble';
import { Run } from '../../run/store';
import { loadPersona } from '../../canon/load';
import { loadFormat } from '../../formats/load';
import { PipelineDeps } from '../../pipeline/episode';
import { runBusiness } from '../../pipeline/business';
import { assertFormatInLane, laneOf } from '../../pipeline/lanes';
import { regate } from '../../qa/regate';
import { inventedQuotes } from '../../qa/sourceText';
import { scriptSchema } from '../../script/write';
import { casebookSchema, hasCasebook, loadCasebook } from '../casebook';
import { chronologyJumps } from '../check';
import { cleanStoryText, isRefused, scoreSource, subjectOf } from '../pickSource';
import { sourceSchema } from '../../evidence/source';

const NOW = new Date('2026-09-29T12:00:00Z');
const book = loadCasebook('business-decoded');

describe('the shipped channel', () => {
  it('is a business channel and nothing else', () => {
    expect(hasCasebook('business-decoded')).toBe(true);
    expect(laneOf(loadPersona('business-decoded'))).toBe('business');
    for (const id of loadPersona('business-decoded').formats) loadFormat(id);
  });

  it('keeps every lane to its own formats', () => {
    expect(() => assertFormatInLane('business', 'biz-short')).not.toThrow();
    expect(() => assertFormatInLane('story', 'biz-short')).toThrow(/business format/);
    expect(() => assertFormatInLane('news', 'biz-episode')).toThrow(/business format/);
    expect(() => assertFormatInLane('business', 'news-short')).toThrow(/news format/);
    expect(() => assertFormatInLane('business', 'myth-story')).toThrow(/only runs its own/);
    expect(laneOf(loadPersona('global-thread'))).toBe('news');
    expect(laneOf(loadPersona('mythic-archives'))).toBe('story');
  });

  it('parses a casebook and rejects a query with no subject in it', () => {
    expect(() => casebookSchema.parse({ ...book, queries: ['company history'] })).toThrow();
  });
});

describe('the duplicate-topic check, for business questions', () => {
  it('does not treat two "how did X become Y" topics as the same subject', () => {
    const { overlap, subjectKey } = jest.requireActual('../../catalogue/covered');
    const a = subjectKey('how did Haldiram become Haldiram');
    const b = subjectKey('how did reliance group ambani become the richest in asia');
    expect(overlap(a, b)).toBe(0);
  });
});

describe('finding the one source', () => {
  it('pulls the subject out of a question', () => {
    expect(subjectOf('how did Haldiram become Haldiram')).toBe('Haldiram');
    expect(subjectOf('how did reliance group ambani become the richest in asia')).toBe('reliance group ambani');
    expect(subjectOf("Haldiram's")).toBe("Haldiram's");
    expect(subjectOf('the story of Toyota')).toBe('Toyota');
  });

  it('refuses social, Q&A and content-farm pages the live probe returned', () => {
    expect(isRefused('https://www.linkedin.com/pulse/remarkable-success-story-haldirams', book)).toMatch(/refused/);
    expect(isRefused('https://www.quora.com/Who-is-the-founder-of-Haldirams-1', book)).toMatch(/refused/);
    expect(isRefused('https://startuptalky.com/haldirams-success-story/', book)).toMatch(/refused/);
    expect(isRefused('https://en.wikipedia.org/wiki/Haldiram%27s', book)).toBeNull();
  });

  it('strips citation markers and back matter so footnotes cannot pass as figures', () => {
    const text = `Founded in 1937 [12] in Bikaner.[a] Grew [ 20 ] fast. ${'Story. '.repeat(200)}\nReferences\n1. Some 2021 book.`;
    const cleaned = cleanStoryText(text);
    expect(cleaned).not.toMatch(/\[12\]|\[a\]|\[ 20 \]|References|2021/);
    expect(cleaned).toMatch(/1937/);
  });

  const src = (url: string, text: string) =>
    sourceSchema.parse({
      id: url.length.toString(16).padStart(4, '0'),
      url,
      title: url,
      retrievedAt: NOW.toISOString(),
      contentHash: 'a'.repeat(64),
      tier: 'T3',
      text,
      httpStatus: 200,
    });

  const story = (years: number[], filler: number) =>
    years.map((y) => `In ${y} Haldiram grew again.`).join(' ') + ' Haldiram sold snacks. '.repeat(filler);

  it('scores a complete chronological encyclopedia over a thin blog', () => {
    const wiki = scoreSource(src('https://en.wikipedia.org/wiki/Haldiram', story([1937, 1941, 1955, 1970, 1983, 1990, 1996, 2003, 2010, 2020], 900)), 'Haldiram', book, 'long', NOW);
    const blog = scoreSource(src('https://someblog.in/haldiram', story([1937, 2020], 900)), 'Haldiram', book, 'long', NOW);
    expect('score' in wiki && 'score' in blog && wiki.score > blog.score).toBe(true);
  });

  it('rejects a page too short for the format, or not about the subject', () => {
    expect(scoreSource(src('https://x.com/a', story([1937], 10)), 'Haldiram', book, 'long', NOW)).toHaveProperty('rejected');
    expect(scoreSource(src('https://x.org/a', 'A page about Tata. '.repeat(1000)), 'Haldiram', book, 'short', NOW)).toHaveProperty('rejected');
  });
});

describe('the free checks', () => {
  it('finds a quotation the source never contains', () => {
    const source = 'He said "we will make the best bhujia in India" to his sons.';
    expect(inventedQuotes('He told them, "we will make the best bhujia in India".', source)).toEqual([]);
    expect(inventedQuotes('He said, "never stop dreaming big my son".', source)).toEqual(['never stop dreaming big my son']);
    expect(inventedQuotes('They called it "the bhujia".', source)).toEqual([]);
  });

  it('accepts a decade the source has years inside, and no other', async () => {
    const { unsupportedFigures } = await import('../../qa/sourceText');
    const source = 'In 1991 it listed. In 1995 it grew.';
    expect(unsupportedFigures('Through the 1990s it grew.', source, NOW)).toEqual([]);
    expect(unsupportedFigures('Through the 1980s it grew.', source, NOW)).toEqual(['1980']);
    expect(unsupportedFigures('In 1990 it grew.', source, NOW)).toEqual(['1990']);
  });

  it('counts the story stepping back in time after the hook', () => {
    const b = (t: string) => ({ turns: [{ text: t }] });
    expect(chronologyJumps([b('Today, in 2024.'), b('In 1937. Then 1941.'), b('By 1970. In 1990.'), b('Now.')], NOW)).toBe(0);
    expect(chronologyJumps([b('x'), b('In 1990.'), b('Back in 1941. Then 1985. Then 1950.'), b('end')], NOW)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The whole run
// ---------------------------------------------------------------------------

const YEARS = [1937, 1941, 1955, 1970, 1983, 1990, 1996, 2003, 2010, 2020];
const STORY = YEARS.map((y, i) => `In ${y}, Haldiram's opened shop number ${i + 1} in Bikaner.`).join(' ');
const PAGE = (body: string) =>
  `<html><head><title>Haldiram's - Wikipedia</title></head><body><p>${body}</p></body></html>`;

const REPLY = {
  title: "How a Bikaner Sweet Shop Became Haldiram's",
  description: "The story of Haldiram's from one shop in 1937. Told in order.",
  beats: [
    { beatId: 'story', turns: [{ speaker: 'host', text: "In 1937, Haldiram's was one tiny shop in Bikaner, selling snacks to the people who walked past it every single morning. By 1955 it had grown. Then came 1970, and with it a much bigger idea about where those snacks could go next." }] },
    { beatId: 'rise', turns: [{ speaker: 'host', text: 'By 1990 it was everywhere. And by 2020, the family had opened shop number 10, a long way from that first counter in Bikaner where it had all started.' }] },
    { beatId: 'close', turns: [{ speaker: 'host', text: 'It took patience. Follow for more business stories like this one, and I will see you next time.' }] },
  ],
};

const fakeWriter = (reply: unknown = REPLY): LlmClient & { calls: number; prompts: string[] } => {
  const client = {
    name: 'fake-writer',
    model: 'writer-1',
    calls: 0,
    prompts: [] as string[],
    async complete(req: LlmRequest): Promise<LlmResponse> {
      client.calls++;
      client.prompts.push(req.prompt);
      return { text: JSON.stringify(reply), inputTokens: 10, outputTokens: 10, costPence: 4, model: 'writer-1' };
    },
  };
  return client;
};

const fakeTts = (): TtsProvider & { calls: number } => {
  const provider = {
    name: 'fake-tts',
    calls: 0,
    async synthesise() {
      provider.calls++;
      return { audio: Buffer.alloc(4000), provider: 'fake-tts', model: 'tts-1', voiceId: 'coral', costPence: 1 };
    },
  };
  return provider;
};

describe('runBusiness', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-biz-'));
    process.env.FOUNDRY_EPISODE_BUDGET_PENCE = '1000';
    process.env.FOUNDRY_RUNS_DIR = root;
    process.env.FOUNDRY_VOICES_FILE = path.join(root, 'voices.json');
    jest.spyOn(assemble, 'probeDuration').mockResolvedValue(50);
    jest.spyOn(assemble, 'concatBeats').mockImplementation(async (_f: string[], out: string) => {
      fs.writeFileSync(out, Buffer.alloc(16));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FOUNDRY_RUNS_DIR;
    delete process.env.FOUNDRY_VOICES_FILE;
  });

  const search = {
    name: 'fake',
    search: jest.fn(async () => [
      { url: 'https://www.linkedin.com/pulse/haldiram', title: 'x' },
      { url: 'https://someblog.in/haldiram-story', title: 'x' },
      { url: 'https://en.wikipedia.org/wiki/Haldiram%27s', title: "Haldiram's" },
    ]),
  };

  const httpGet = jest.fn(async (url: string): Promise<HttpResponse> => ({
    status: 200,
    body: url.includes('wikipedia')
      ? PAGE(`${STORY} ${"Haldiram's makes snacks. ".repeat(700)}`)
      : PAGE(`In 1937 Haldiram's began. ${"Haldiram's is great. ".repeat(250)}`),
    finalUrl: url,
    contentType: 'text/html',
  }));

  const deps = (writer = fakeWriter()): PipelineDeps => ({
    // Off explicitly: these test the lane, not the channel's music setting,
    // and a real ffmpeg bed under every render pushes them past the timeout.
    music: false,
    writer,
    verifier: writer,
    search,
    tts: fakeTts(),
    fetchDeps: { httpGet },
  });

  const makeRun = (formatId = 'biz-short') =>
    Run.create({ personaId: 'business-decoded', formatId, topic: 'how did Haldiram become Haldiram' }, { root });

  const bizDeps = { now: () => NOW, sleep: async () => undefined };

  it('tells the story from ONE source, the most complete, in one call, and passes', async () => {
    const run = makeRun();
    const writer = fakeWriter();
    const { gate } = await runBusiness(run, deps(writer), bizDeps);

    expect(httpGet.mock.calls.map((c) => c[0])).not.toContain('https://www.linkedin.com/pulse/haldiram');
    const corpus = run.readArtifact('corpus', z.object({ sources: z.array(z.object({ url: z.string() })) }).passthrough());
    expect(corpus.sources).toHaveLength(1);
    expect(corpus.sources[0]!.url).toContain('wikipedia');
    expect(writer.calls).toBe(1);
    expect(writer.prompts[0]).toContain('THE SUBJECT: Haldiram');
    expect(writer.prompts[0]).toContain('avoid jargon altogether');
    expect(gate.findings.filter((f) => f.blocking)).toEqual([]);
    expect(gate.passed).toBe(true);
  });

  it('asks an episode to explain tricky terms, which a short does not', async () => {
    const writer = fakeWriter({ ...REPLY, beats: [] });
    await runBusiness(makeRun('biz-episode'), deps(writer), bizDeps).catch(() => undefined);
    expect(writer.prompts[0]).toContain('which is when a company first sells its shares');
  });

  it('BLOCKS an invented year and an invented quotation', async () => {
    const wrong = JSON.parse(JSON.stringify(REPLY));
    wrong.beats[0].turns[0].text = 'In 1932, Haldiram said, "one day we will feed the whole world".';
    const { gate } = await runBusiness(makeRun(), deps(fakeWriter(wrong)), bizDeps);
    const checks = gate.findings.filter((f) => f.blocking).map((f) => f.check);
    expect(checks).toEqual(expect.arrayContaining(['bizFigures', 'bizQuote']));
  });

  it('resumes without paying twice, and regate uses this lane', async () => {
    const run = makeRun();
    await runBusiness(run, deps(), bizDeps);
    const second = fakeWriter();
    await runBusiness(Run.open(run.id, { root }), deps(second), bizDeps);
    expect(second.calls).toBe(0);
    expect(regate(run, run.readArtifact('script', scriptSchema))?.passed).toBe(true);
  });

  it('resumes a run made before this lane existed (reference without the business record)', async () => {
    const run = makeRun();
    await runBusiness(run, deps(), bizDeps);
    run.writeArtifact('reference', { selection: { chosen: ['x'] } });
    const second = fakeWriter();
    await runBusiness(Run.open(run.id, { root }), deps(second), bizDeps);
    expect(second.calls).toBe(0);
  });

  it('abandons when no source tells the whole story', async () => {
    const thin = { name: 'thin', search: async () => [{ url: 'https://someblog.in/x', title: 'x' }] };
    const d = { ...deps(), search: thin, fetchDeps: { httpGet: async (url: string): Promise<HttpResponse> => ({ status: 200, body: PAGE('Haldiram. '.repeat(20)), finalUrl: url, contentType: 'text/html' }) } };
    await expect(runBusiness(makeRun(), d, bizDeps)).rejects.toThrow(/abandoned/);
  });
});
