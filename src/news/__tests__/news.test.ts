/**
 * The news lane: the free parts exactly, and the whole run with every outside
 * service faked.
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
import { runNews, regateNews } from '../../pipeline/news';
import { PipelineDeps } from '../../pipeline/episode';
import { regate } from '../../qa/regate';
import { scriptSchema } from '../../script/write';
import { deskSchema, hasNewsDesk, loadDesk, outletFor } from '../desk';
import { isIndexPage, isLiveBlog, isOpinion, parseWhen, screenWire, stripSiteSuffix, WireItem } from '../wire';
import { clusterStories, headlineOverlap, headlineTokens, pickArticle } from '../pick';
import { draftProblems, unfamiliarNames, unsupportedFigures } from '../check';
import { spokenDate } from '../newsScript';

const desk = deskSchema.parse({
  id: 'global-thread',
  beat: 'geopolitics',
  queries: ['world news'],
  outlets: [
    { host: 'apnews.com', onAir: 'the Associated Press' },
    { host: 'bbc.co.uk', onAir: 'the BBC' },
    { host: 'theguardian.com', onAir: 'the Guardian' },
  ],
  excludeWords: ['football'],
});

const NOW = new Date('2026-09-29T12:00:00Z');

describe('the shipped desk', () => {
  it('exists for the geopolitics channel and loads', () => {
    expect(hasNewsDesk('global-thread')).toBe(true);
    expect(loadDesk('global-thread').beat).toBe('geopolitics');
  });

  it('does not exist for a story channel, so those are untouched', () => {
    expect(hasNewsDesk('mythic-archives')).toBe(false);
  });

  it('matches an outlet on a subdomain but not a lookalike', () => {
    expect(outletFor(desk, 'https://www.bbc.co.uk/news/world-1')?.onAir).toBe('the BBC');
    expect(outletFor(desk, 'https://notbbc.co.uk/x')).toBeNull();
  });
});

describe('the wire screen', () => {
  const item = (url: string, title: string) => ({ url, title, description: '' });

  it('refuses live blogs, the first probe of the endpoint returned three', () => {
    expect(isLiveBlog('https://foxnews.com/live-news/trump-iran', 'x')).toBe(true);
    expect(isLiveBlog('https://www.cbsnews.com/live-updates/iran-war/', 'x')).toBe(true);
    expect(isLiveBlog('https://apnews.com/article/x', 'Iran war: live updates')).toBe(true);
    expect(isLiveBlog('https://apnews.com/article/iran-talks-1', 'Iran rejects offer')).toBe(false);
  });

  it('refuses a headlines page, which the live wire returned', () => {
    expect(isIndexPage('https://www.npr.org/sections/news/', 'News: U.S. and World News Headlines : NPR')).toBe(true);
    expect(isIndexPage('https://www.bbc.co.uk/news/world', 'World')).toBe(true);
    expect(isIndexPage('https://www.bbc.co.uk/news/articles/c4g0x1y2z3', 'Ministers meet')).toBe(false);
    expect(isIndexPage('https://apnews.com/article/iran-trump-negotiations-871504dbd98d', 'Talks')).toBe(false);
  });

  it('refuses opinion and explainers', () => {
    expect(isOpinion('https://www.theguardian.com/commentisfree/2026/x', 'x')).toBe(true);
    expect(isOpinion('https://www.hindustantimes.com/ht-explainers/x', 'x')).toBe(true);
    expect(isOpinion('https://apnews.com/article/x', 'Analysis: what next')).toBe(true);
  });

  it('keeps only desk outlets, dedupes, and says why the rest went', () => {
    const { kept, rejected } = screenWire(
      [
        item('https://apnews.com/article/leaders-geneva-8a1b', 'Leaders meet in Geneva'),
        item('https://apnews.com/article/leaders-geneva-8a1b?utm=1', 'Leaders meet in Geneva'),
        item('https://randomblog.com/a', 'Leaders meet'),
        item('https://www.bbc.co.uk/sport/football/1', 'Football final'),
      ],
      desk
    );
    expect(kept.map((k) => k.outlet)).toEqual(['the Associated Press']);
    expect(rejected.map((r) => r.reason)).toEqual([
      'not one of the desk outlets',
      'off the desk\'s beat ("football")',
    ]);
  });

  it('strips the outlet off a headline', () => {
    expect(stripSiteSuffix('Iran rejects ceasefire | Hindustan Times')).toBe('Iran rejects ceasefire');
    expect(stripSiteSuffix('Leaders meet in Geneva - BBC News')).toBe('Leaders meet in Geneva');
    expect(stripSiteSuffix('Talks resume after 2020 deal')).toBe('Talks resume after 2020 deal');
    // From the first live run: a section name with a hyphen in it survived.
    expect(stripSiteSuffix('US-Iran talks in New York | US-Israel war on Iran News')).toBe(
      'US-Iran talks in New York'
    );
  });

  it('treats a zoneless Brave date as UTC and a missing one as unknown', () => {
    expect(parseWhen('2026-09-28T10:18:25')?.toISOString()).toBe('2026-09-28T10:18:25.000Z');
    expect(parseWhen(undefined)).toBeNull();
    expect(parseWhen('not a date')).toBeNull();
  });
});

describe('choosing the story', () => {
  const wi = (url: string, title: string, outlet: string, rank: number, seenAt = '2026-09-29T08:00:00'): WireItem => ({
    url,
    title,
    description: '',
    outlet,
    rank,
    seenAt,
  });

  it('ranks the story the most outlets carry first', () => {
    const stories = clusterStories([
      wi('https://apnews.com/1', 'Volcano erupts in Iceland', 'AP', 0),
      wi('https://apnews.com/2', 'Iran rejects US ceasefire proposal', 'AP', 0),
      wi('https://bbc.co.uk/2', 'US ceasefire proposal rejected by Iran', 'BBC', 1),
      wi('https://theguardian.com/2', 'Iran says no to ceasefire proposal from Washington', 'Guardian', 2),
    ]);
    expect(stories[0]!.outlets).toBe(3);
    expect(stories[0]!.items[0]!.title).toMatch(/Iran/);
    expect(stories[1]!.items[0]!.title).toMatch(/Volcano/);
  });

  it('does not merge two stories that share one word', () => {
    const a = headlineTokens('Iran election count begins');
    const b = headlineTokens('Iran ceasefire talks stall');
    expect(headlineOverlap(a, b)).toBeLessThan(0.5);
    expect(clusterStories([wi('u1', 'Iran election count begins', 'AP', 0), wi('u2', 'Iran ceasefire talks stall', 'BBC', 1)])).toHaveLength(2);
  });

  const page = (published: string, words = 400) =>
    `<html><head><title>T</title><meta property="article:published_time" content="${published}"></head>` +
    `<body><p>${'The ministers met in Geneva on Monday and agreed 12 points. '.repeat(words / 10)}</p></body></html>`;

  it('fetches the preferred outlet, and moves on when it fails', async () => {
    const story = clusterStories([
      wi('https://apnews.com/a', 'Ministers agree 12 point plan', 'the Associated Press', 0),
      wi('https://bbc.co.uk/a', 'Ministers agree 12 point plan in Geneva', 'the BBC', 1),
    ]);
    const httpGet = async (url: string): Promise<HttpResponse> =>
      url.includes('apnews')
        ? { status: 403, body: 'no', finalUrl: url }
        : { status: 200, body: page('2026-09-29T07:00:00Z'), finalUrl: url, contentType: 'text/html' };

    const picked = await pickArticle(story, desk, { httpGet }, NOW);
    expect(picked?.item.outlet).toBe('the BBC');
    expect(picked?.source.tier).toBe('T2');
    expect(picked?.rejected[0]!.url).toContain('apnews');
  });

  it('tries each outlet once, so one blocking outlet cannot use up a story', async () => {
    // The first live run: three NPR pages timed out in turn and the story's
    // other outlets were never tried.
    const story = clusterStories([
      wi('https://npr.org/1', 'Trump rejects Iran ceasefire proposal', 'NPR', 0),
      wi('https://npr.org/2', 'Trump rejects Iran ceasefire proposal again', 'NPR', 0),
      wi('https://npr.org/3', 'Trump rejects latest Iran ceasefire proposal', 'NPR', 0),
      wi('https://npr.org/4', 'Iran ceasefire proposal rejected by Trump', 'NPR', 0),
      wi('https://bbc.co.uk/1', 'Trump rejects Iran ceasefire proposal, BBC', 'the BBC', 1),
    ]);
    const httpGet = jest.fn(async (url: string): Promise<HttpResponse> =>
      url.includes('npr')
        ? { status: 403, body: 'no', finalUrl: url }
        : { status: 200, body: page('2026-09-29T07:00:00Z'), finalUrl: url, contentType: 'text/html' }
    );
    const picked = await pickArticle(story, desk, { httpGet }, NOW);
    expect(picked?.item.outlet).toBe('the BBC');
    expect(httpGet).toHaveBeenCalledTimes(2);
  });

  it('refuses an old article re-indexed today, by the page\'s own date', async () => {
    const story = clusterStories([wi('https://apnews.com/a', 'Ministers agree plan', 'AP', 0)]);
    const httpGet = async (url: string): Promise<HttpResponse> => ({
      status: 200,
      body: page('2026-09-20T07:00:00Z'),
      finalUrl: url,
      contentType: 'text/html',
    });
    expect(await pickArticle(story, desk, { httpGet }, NOW)).toBeNull();
  });

  it('refuses a teaser', async () => {
    const story = clusterStories([wi('https://apnews.com/a', 'Ministers agree plan', 'AP', 0)]);
    const httpGet = async (url: string): Promise<HttpResponse> => ({
      status: 200,
      body: page('2026-09-29T07:00:00Z', 50),
      finalUrl: url,
      contentType: 'text/html',
    });
    expect(await pickArticle(story, desk, { httpGet }, NOW)).toBeNull();
  });

  it('skips a story the channel already reported', async () => {
    const story = clusterStories([wi('https://apnews.com/a', 'Ministers agree 12 point plan', 'AP', 0)]);
    const httpGet = jest.fn();
    const picked = await pickArticle(story, desk, { httpGet }, NOW, {
      urls: new Set(['apnews.com/a']),
      titles: [],
    });
    expect(picked).toBeNull();
    expect(httpGet).not.toHaveBeenCalled();
  });
});

describe('the figure check', () => {
  const article =
    'The ministry said 39,812 people had been displaced and four aid workers were killed. ' +
    'The fund is worth $3.5bn. Talks began in 1991.';

  it('passes figures the article has, including newsreader rounding', () => {
    expect(unsupportedFigures('About 40,000 people have fled, and 4 aid workers died.', article, NOW)).toEqual([]);
    expect(unsupportedFigures('A fund of 3.5 billion dollars, first agreed in 1991.', article, NOW)).toEqual([]);
  });

  it('BLOCKS a figure the article does not have, and a small count changed at all', () => {
    expect(unsupportedFigures('About 60,000 people have fled.', article, NOW)).toEqual(['60,000']);
    expect(unsupportedFigures('5 aid workers were killed.', article, NOW)).toEqual(['5']);
  });

  it('allows the date and time the script is told to say', () => {
    expect(
      unsupportedFigures('On Tuesday the 29th of September, at 10:30, in 2026, the vote passed.', article, NOW)
    ).toEqual([]);
  });

  it('allows a spoken clock time, which the writer is told to say', () => {
    expect(unsupportedFigures('It was reported at 10 this morning, and again at 6 in the evening.', article, NOW)).toEqual([]);
  });

  it('reports names the article never uses', () => {
    expect(
      unfamiliarNames('The minister met Lavrov in Geneva. Rowan reporting.', 'The minister met in Geneva.', ['Rowan'])
    ).toEqual(['Lavrov']);
    // Both seen live as false alarms.
    expect(
      unfamiliarNames('Separately, the United Nations met.', 'The U.N. met on Monday.', [])
    ).toEqual([]);
  });

  it('BLOCKS a report that talks about "the article", seen on the first render', async () => {
    const { newsGate } = await import('../check');
    const { loadPersona } = await import('../../canon/load');
    const { loadFormat } = await import('../../formats/load');
    const persona = loadPersona('global-thread');
    const gate = newsGate({
      persona,
      format: loadFormat('news-short'),
      desk,
      script: {
        personaId: persona.id,
        formatId: 'news-short',
        title: 'T',
        description: 'D',
        writerModel: 'w',
        beats: [
          { beatId: 'lede', beatType: 'cold_open', claimIds: [], revisions: 0, turns: [{ speaker: 'reporter', text: 'The BBC reports talks met.' }] },
          { beatId: 'close', beatType: 'outro', claimIds: [], revisions: 0, turns: [{ speaker: 'reporter', text: 'The article does not say when talks end. Follow me.' }] },
        ],
      },
      source: {
        id: 's', url: 'https://bbc.co.uk/news/x-1', title: 'T', retrievedAt: NOW.toISOString(),
        contentHash: 'a'.repeat(64), tier: 'T2', text: 'Talks met.', httpStatus: 200,
      },
      outlet: 'the BBC',
      publishedAt: NOW.toISOString(),
      durationS: 100,
      measured: true,
      now: NOW,
    });
    expect(gate.findings.find((f) => f.check === 'newsMeta')?.blocking).toBe(true);
  });

  it('catches an unknown the source never stated, seen on the first render', async () => {
    const { unsourcedUnknowns } = await import('../check');
    const article = 'Talks were expected to resume on Monday. The seven-day timeline starts on acceptance.';
    expect(
      unsourcedUnknowns('PBS reports no date has been set, as mediators work behind the scenes.', article)
    ).toEqual(['no date has been set']);
    // Said in the source, so it may be reported.
    expect(unsourcedUnknowns('It is unclear when talks end.', 'It is not clear when talks end.')).toEqual([]);
  });

  it('checks the outro, the source and the length before any audio', () => {
    const problems = draftProblems(
      [
        { beatId: 'lede', turns: [{ text: 'Ministers met. '.repeat(10) }] },
        { beatId: 'close', turns: [{ text: 'That is all. Goodbye.' }] },
      ],
      { article, outlet: 'the BBC', now: NOW, closingBeatId: 'close' }
    );
    expect(problems).toEqual([
      'the report never says it comes from the BBC',
      'the last part never asks the listener to follow',
    ]);
  });

  it('says the date the way a British newsreader does', () => {
    expect(spokenDate(new Date('2026-09-29T12:00:00Z'))).toBe('Tuesday the 29th of September');
    expect(spokenDate(new Date('2026-09-22T12:00:00Z'))).toBe('Tuesday the 22nd of September');
    expect(spokenDate(new Date('2026-09-11T12:00:00Z'))).toBe('Friday the 11th of September');
  });
});

// ---------------------------------------------------------------------------
// The whole run
// ---------------------------------------------------------------------------

const ARTICLE_BODY =
  'Foreign ministers from 12 countries have agreed a ceasefire framework in Geneva, officials said on Tuesday. ' +
  'The agreement covers 3 border regions and would take effect within 48 hours. ' +
  'Russia said it had not been consulted. ' +
  'Negotiators will meet again next week to agree monitoring. '.repeat(30);

const ARTICLE_HTML =
  '<html><head><title>Ministers agree ceasefire framework in Geneva</title>' +
  '<meta property="article:published_time" content="2026-09-29T06:00:00Z"></head>' +
  `<body><article><p>${ARTICLE_BODY}</p></article></body></html>`;

const REPORT = {
  title: 'Ministers from 12 countries agree Geneva ceasefire framework',
  description: 'Foreign ministers agreed a framework covering 3 border regions. Russia says it was not consulted.',
  beats: [
    {
      beatId: 'hello',
      turns: [
        {
          speaker: 'reporter',
          text:
            'Hi, it\'s Rowan. Let\'s look at the latest on the border fighting that negotiators have been trying to stop for months. ' +
            'So here\'s what happened.',
        },
      ],
    },
    {
      beatId: 'news',
      turns: [
        {
          speaker: 'reporter',
          text:
            'On Tuesday, the BBC reported that foreign ministers from 12 countries have agreed a ceasefire framework in Geneva. ' +
            'Officials say it covers 3 border regions. Russia says it was not consulted.',
        },
      ],
    },
    {
      beatId: 'explain',
      turns: [
        {
          speaker: 'reporter',
          text:
            'Now, why does that matter? Because most of the fighting has been in those 3 regions. ' +
            'Think of the framework as a set of traffic rules everyone signs before the road reopens. ' +
            'Officials say it would take effect within 48 hours. That means both sides have two days to pull back. ' +
            'The talks took place over two days behind closed doors in Geneva, and this is the closest the negotiators have come.',
        },
      ],
    },
    {
      beatId: 'close',
      turns: [
        {
          speaker: 'reporter',
          text:
            'Negotiators meet again next week to agree how it will be monitored. ' +
            'So, 12 countries have agreed the rules for a ceasefire, and now it has to hold. ' +
            'To keep yourself updated on geopolitics, follow me. See you next time.',
        },
      ],
    },
  ],
};

const fakeWriter = (reply: unknown = REPORT): LlmClient & { calls: number; prompts: string[] } => {
  const client = {
    name: 'fake-writer',
    model: 'writer-1',
    calls: 0,
    prompts: [] as string[],
    async complete(req: LlmRequest): Promise<LlmResponse> {
      client.calls++;
      client.prompts.push(req.prompt);
      return { text: JSON.stringify(reply), inputTokens: 10, outputTokens: 10, costPence: 1.5, model: 'writer-1' };
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
      return { audio: Buffer.alloc(4000), provider: 'fake-tts', model: 'tts-1', voiceId: 'onyx', costPence: 1 };
    },
  };
  return provider;
};

const wire = {
  name: 'fake-wire',
  latest: jest.fn(async () => [
    { url: 'https://www.bbc.co.uk/news/world-1', title: 'Ministers agree ceasefire framework in Geneva', description: '', seenAt: '2026-09-29T06:30:00' },
    { url: 'https://www.theguardian.com/world/2026/sep/29/geneva', title: 'Geneva ceasefire framework agreed by ministers', description: '', seenAt: '2026-09-29T07:00:00' },
    { url: 'https://www.cbsnews.com/live-updates/geneva/', title: 'Live updates: Geneva', description: '' },
  ]),
};

describe('runNews', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-news-'));
    process.env.FOUNDRY_EPISODE_BUDGET_PENCE = '1000';
    process.env.FOUNDRY_RUNS_DIR = root;
    process.env.FOUNDRY_VOICES_FILE = path.join(root, 'voices.json');
    jest.spyOn(assemble, 'probeDuration').mockResolvedValue(35);
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

  const httpGet = async (url: string): Promise<HttpResponse> => ({
    status: 200,
    body: ARTICLE_HTML,
    finalUrl: url,
    contentType: 'text/html',
  });

  const deps = (writer = fakeWriter()): PipelineDeps => ({
    writer,
    verifier: writer,
    search: { name: 'unused', search: async () => [] },
    tts: fakeTts(),
    fetchDeps: { httpGet },
  });

  const makeRun = () =>
    Run.create({ personaId: 'global-thread', formatId: 'news-short', topic: 'geopolitics' }, { root });

  const newsDeps = { wire, now: () => NOW, sleep: async () => undefined };

  it('reports from ONE article, the preferred outlet, and passes its gate', async () => {
    const run = makeRun();
    const writer = fakeWriter();
    const { gate, script } = await runNews(run, deps(writer), newsDeps);

    const corpus = run.readArtifact('corpus', z.object({ sources: z.array(z.any()) }).passthrough());
    expect(corpus.sources).toHaveLength(1);
    expect(corpus.sources[0].url).toContain('bbc.co.uk');

    expect(writer.calls).toBe(1);
    expect(writer.prompts[0]).toContain('THE SOURCE, AS YOU SAY IT ON AIR: the BBC');
    expect(writer.prompts[0]).toMatch(/HOW THIS CHANNEL SIGNS OFF[\s\S]*follow/);
    expect(script.title).toMatch(/Geneva/);

    expect(gate.findings.filter((f) => f.blocking)).toEqual([]);
    expect(gate.passed).toBe(true);
    expect(run.hasArtifact('claims')).toBe(true);
    expect(run.hasArtifact('publish')).toBe(false);
  });

  it('resumes without paying twice or re-reading the wire', async () => {
    const run = makeRun();
    await runNews(run, deps(), newsDeps);
    wire.latest.mockClear();

    const second = fakeWriter();
    const again = deps(second);
    await runNews(Run.open(run.id, { root }), again, newsDeps);
    expect(second.calls).toBe(0);
    expect((again.tts as TtsProvider & { calls: number }).calls).toBe(0);
    expect(wire.latest).not.toHaveBeenCalled();
  });

  it('BLOCKS a report whose figure is not in the article', async () => {
    const wrong = JSON.parse(JSON.stringify(REPORT));
    wrong.beats[2].turns[0].text = wrong.beats[2].turns[0].text.replace('48 hours', '72 hours');
    const { gate } = await runNews(makeRun(), deps(fakeWriter(wrong)), newsDeps);
    expect(gate.passed).toBe(false);
    expect(gate.findings.find((f) => f.check === 'newsFigures')?.detail).toContain('72');
  });

  it('refuses at publish time once the report has gone stale', async () => {
    const run = makeRun();
    await runNews(run, deps(), newsDeps);
    const script = run.readArtifact('script', scriptSchema);

    expect(regateNews(run, script, NOW)?.passed).toBe(true);
    const later = regateNews(run, script, new Date('2026-10-02T12:00:00Z'));
    expect(later?.passed).toBe(false);
    expect(later?.findings.map((f) => f.check)).toContain('newsStale');
  });

  it('is what the shared regate uses for a news channel', async () => {
    const run = makeRun();
    await runNews(run, deps(), newsDeps);
    const report = regate(run, run.readArtifact('script', scriptSchema));
    expect(report).not.toBeNull();
  });

  it('abandons rather than report nothing', async () => {
    const empty = { name: 'empty', latest: async () => [] };
    const run = makeRun();
    await expect(runNews(run, deps(), { ...newsDeps, wire: empty })).rejects.toThrow(/abandoned/);
  });

  it('does not count a held, unvoiced run as having reported anything', async () => {
    const held = Run.create(
      { personaId: 'global-thread', formatId: 'news-short', topic: 'geopolitics', holdForApproval: true },
      { root }
    );
    await runNews(held, deps(), newsDeps);
    const { gate } = await runNews(makeRun(), deps(), newsDeps);
    expect(gate.passed).toBe(true);
  });

  it('will not report the same article on the next run', async () => {
    await runNews(makeRun(), deps(), newsDeps);
    const second = makeRun();
    // Both wire items are the story already reported, so there is nothing left.
    await expect(runNews(second, deps(), newsDeps)).rejects.toThrow(/abandoned/);
  });
});
