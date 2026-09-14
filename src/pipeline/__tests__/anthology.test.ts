/**
 * The anthology lane: one research pass, ten self-contained stories, ten runs.
 *
 * The source script is produced by the real episode pipeline rather than
 * hand-written, for the same reason the short lane's test does it: what is most
 * likely to break here is the SHAPE of what the source wrote, and a fixture
 * stays in step with a stale idea of that shape while the pipeline moves on.
 *
 * What is pinned: the source is never rendered, every story becomes a run that
 * can answer where it came from on its own, each carries only the evidence it
 * actually states, a second cut resumes instead of duplicating, and the whole
 * set costs a fraction of ten episodes - which is the entire argument for the
 * format existing.
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
import { cutStories } from '../anthology';

const PERSONA_ID = 'honest-health';
const SOURCE_FORMAT_ID = 'ten-stories';
const EPISODE_FORMAT_ID = 'what-we-know';

const STORIES = 10;
const BEATS = Array.from({ length: STORIES }, (_, i) => `story_${String(i + 1).padStart(2, '0')}`);

/**
 * One long document every claim can quote from.
 *
 * Each story's quote is a different sentence of it, so the ten stories cite ten
 * different spans rather than all pointing at one - which is what makes the
 * narrowing test mean anything.
 */
const QUOTE = (n: number) =>
  `Trial number ${n} enrolled ${n * 40} adults and ran for ${n + 5} months.`;
const DOC_TEXT = `${BEATS.map((_, i) => QUOTE(i + 1)).join(' ')} ${'Filler about the method and its limits. '.repeat(40)}`;
const DOC_HTML = `<html><head><title>A Review</title></head><body><p>${DOC_TEXT}</p></body></html>`;

/**
 * Claims for whichever beats the chunk asked about.
 *
 * Read out of the prompt rather than hardcoded, because extraction is CHUNKED -
 * three beats a call - and a stub answering with all ten every time would be
 * answering a question it was not asked. It also lets the same fixture serve
 * the episode format further down, whose beats are named nothing like these.
 */
const claimsJson = (prompt: string) => {
  const asked = [...prompt.matchAll(/^- ([a-z0-9_]+) \(/gm)].map((m) => m[1]!);
  return JSON.stringify({
    claims: asked.flatMap((beatId, bi) =>
      Array.from({ length: 4 }, (_, i) => ({
        id: `c${bi}_${i}`,
        beatId,
        text: `A fact from ${beatId}, number ${i}.`,
        type: 'statistic',
        sourceId: 'SOURCE_ID',
        quote: QUOTE(((BEATS.indexOf(beatId) + STORIES) % STORIES) + 1),
        contested: false,
      }))
    ),
    unsupported: [],
  });
};

/**
 * Prose that differs story to story.
 *
 * Not decoration. These beats are supposed to be ten unrelated stories, and a
 * fixture repeating one paragraph ten times would make the ledger narrowing
 * look right while proving nothing about it.
 */
const SUBJECT = [
  'a swimming club in Aberdeen',
  'a bakery nightshift in Lyon',
  'a ferry crew on Lake Malawi',
  'a call centre outside Manila',
  'a wool mill in Otago',
  'a fishing fleet off Peniche',
  'a hospital laundry in Tbilisi',
  'a bus depot in Curitiba',
  'a grain store near Saskatoon',
  'a quarry above Carrara',
];

const prose = (n: number): string =>
  [
    `This one starts with ${SUBJECT[n - 1]}.`,
    `Somebody there kept a notebook for ${n + 5} months, and the reason anybody reads it now is that ${n * 40} people had agreed, without much thought, to write down the same four things every evening before they went home.`,
    `The numbers held.`,
    `What the notebook could not do was say why, and the people who ran it were careful about that from the first page to the last.`,
    `Nobody has repeated it since.`,
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
          angle: 'ten small trials nobody repeated',
          mustEstablish: ['who was counted'],
          queries: ['q1', 'q2', 'q3'],
          likelyContested: [],
        });
      } else if (req.system.includes('extract factual claims')) {
        text = claimsJson(req.prompt).replace(/SOURCE_ID/g, sourceId());
      } else if (req.system.includes('evidence AGAINST')) {
        text = JSON.stringify({ queries: ['counter'] });
      } else if (req.system.includes('title and description')) {
        // Cutting asks for a title per story, so it has to differ per story or
        // the resumption test cannot tell a reused title from a fresh one.
        text = JSON.stringify({
          title: `Trial ${client.calls}`,
          description: 'One sentence. Then another.',
        });
      } else {
        // WHICH BEAT THIS IS, read back out of the prompt rather than counted.
        // Beats are revised, so a call counter is not a beat index - and the
        // claim ids the extractor emitted are NOT the ids the pipeline ends up
        // with, because extraction renumbers across chunks. Both are read from
        // what the writer is actually handed.
        const beatId = /BEAT: (story_\d+)/.exec(req.prompt)?.[1] ?? 'story_01';
        const n = Number(beatId.slice(-2));
        const offered = [...req.prompt.matchAll(/^\[(c\d+)\]/gm)].map((m) => m[1]!);
        text = JSON.stringify({
          turns: [{ speaker: 'narrator', text: prose(n) }],
          claimIds: offered.slice(0, 2),
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
      { url: 'https://www.nih.gov/a', title: 'A' },
      { url: 'https://www.nih.gov/b', title: 'B' },
      { url: 'https://www.gov.uk/c', title: 'C' },
      { url: 'https://www.gov.uk/d', title: 'D' },
      { url: 'https://www.cochrane.org/e', title: 'E' },
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

describe('cutStories', () => {
  let root: string;
  let sourceIdRef: { id: string };
  let tts: TtsProvider & { calls: number };

  const buildDeps = (over: Partial<PipelineDeps> = {}): PipelineDeps => ({
    writer: fakeWriter(() => sourceIdRef.id),
    verifier: fakeVerifier(),
    search: fakeSearch,
    tts,
    fetchDeps: { httpGet, now: () => new Date('2026-09-13T00:00:00.000Z') },
    ...over,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-anthology-'));
    sourceIdRef = { id: sourceIdFor('https://www.nih.gov/a') };
    tts = fakeTts();
    process.env.FOUNDRY_EPISODE_BUDGET_PENCE = '10000';
    process.env.FOUNDRY_RUNS_DIR = root;
    // The registry is committed, so a suite writing to the real one pins live
    // shows to a voice called "fake-tts". It did, once.
    process.env.FOUNDRY_VOICES_FILE = path.join(root, 'voices.json');

    // Every cut story is one beat, and the format wants 90 to 180 seconds.
    jest.spyOn(assemble, 'probeDuration').mockResolvedValue(130);
    jest.spyOn(assemble, 'concatBeats').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FOUNDRY_RUNS_DIR;
    delete process.env.FOUNDRY_VOICES_FILE;
  });

  /** A finished source script: ten stories, no audio. */
  const makeSource = async (): Promise<Run> => {
    const run = Run.create(
      { personaId: PERSONA_ID, formatId: SOURCE_FORMAT_ID, topic: 'Small trials nobody repeated' },
      { root }
    );
    await runEpisode(run, buildDeps());
    return run;
  };

  it('writes the source script and renders nothing', async () => {
    // THE POINT OF sourceOnly. Twenty minutes of audio nobody will ever hear is
    // most of the bill, and an episode that exists as a file is an episode
    // somebody eventually publishes by accident.
    const source = await makeSource();

    expect(source.isComplete('script')).toBe(true);
    expect(source.hasArtifact('render')).toBe(false);
    expect(tts.calls).toBe(0);

    // IT IS STILL CHECKED, AND THE REPORT IS STILL KEPT. A source script is not
    // an episode and cannot be judged as one - there is no audio to time and no
    // render to fault - but the two things that matter about it are checked
    // here or nowhere: that no story is starved of evidence, and that no story
    // cites another story's claims. Written like any other run's report, so
    // `gate --run` has something to read.
    expect(source.isComplete('qa')).toBe(true);
    expect(source.hasArtifact('qa')).toBe(true);

    const script = source.readArtifact('script', scriptSchema);
    expect(script.beats).toHaveLength(STORIES);
  });

  it('gives every story its own run, its own title and its own audio', async () => {
    const source = await makeSource();
    const cuts = await cutStories({ source }, buildDeps());

    expect(cuts).toHaveLength(STORIES);
    expect(new Set(cuts.map((c) => c.run.id)).size).toBe(STORIES);
    expect(new Set(cuts.map((c) => c.script.title)).size).toBe(STORIES);

    for (const cut of cuts) {
      expect(cut.script.beats).toHaveLength(1);
      expect(cut.run.isComplete('render')).toBe(true);
      expect(cut.run.isComplete('qa')).toBe(true);
    }
  });

  it('numbers every story beside the source it came from', async () => {
    // A run is a directory somebody opens six months later. "Which episode is
    // this, and what was it cut out of" has to be answerable from the manifest
    // rather than from a naming convention nobody wrote down.
    const source = await makeSource();
    const cuts = await cutStories({ source }, buildDeps());

    for (const [i, cut] of cuts.entries()) {
      expect(cut.run.manifest.derivedFrom).toBe(source.id);
      expect(cut.run.manifest.story).toBe(i + 1);
      expect(cut.run.manifest.episode).toBe(source.manifest.episode);
      expect(cut.run.manifest.short).toBe(i + 1);
      expect(cut.run.id.startsWith(`${PERSONA_ID}/`)).toBe(true);
    }
  });

  it('carries only the evidence the story actually states', async () => {
    // A short publishing the whole set's Sources sheet lists nine documents it
    // never mentions, which is worse than listing none: it looks like evidence
    // for something it is not evidence for.
    const source = await makeSource();
    const cuts = await cutStories({ source }, buildDeps());

    const all = source.readArtifact('claims', z.object({ claims: z.array(claimSchema) })).claims;

    const seen = new Set<string>();
    for (const cut of cuts) {
      const { claims } = cut.run.readArtifact('claims', z.object({ claims: z.array(claimSchema) }));
      expect(claims.length).toBeGreaterThan(0);
      expect(claims.length).toBeLessThan(all.length);

      // Every claim belongs to this story's beat, and no two stories carry the
      // same claim.
      for (const claim of claims) {
        expect(claim.beatId).toBe(cut.script.beats[0]!.beatId);
        expect(seen.has(claim.id)).toBe(false);
        seen.add(claim.id);
      }
    }
  });

  it('leaves artifacts the publish command can actually read', async () => {
    const source = await makeSource();
    const [first] = await cutStories({ source, only: [1] }, buildDeps());

    expect(() => first!.run.readArtifact('claims', claimSetSchema)).not.toThrow();
    expect(() => first!.run.readArtifact('corpus', corpusSchema)).not.toThrow();
    expect(() => first!.run.readArtifact('script', scriptSchema)).not.toThrow();
    expect(() => first!.run.readArtifact('render', renderResultSchema)).not.toThrow();
  });

  it('costs a fraction of making the stories as separate episodes', async () => {
    // The entire case for the format. Research, extraction and verification are
    // paid once and fanned out; each story then pays for a title and a render.
    const source = await makeSource();
    const cuts = await cutStories({ source }, buildDeps());

    const episode = Run.create(
      { personaId: PERSONA_ID, formatId: EPISODE_FORMAT_ID, topic: 'One trial' },
      { root }
    );
    await runEpisode(episode, buildDeps());

    const whole = source.manifest.spentPence + cuts.reduce((s, c) => s + c.run.manifest.spentPence, 0);
    expect(whole).toBeLessThan(episode.manifest.spentPence * STORIES * 0.5);

    // And each cut on its own is small next to the research it inherited.
    for (const cut of cuts) {
      expect(cut.run.manifest.spentPence).toBeLessThan(source.manifest.spentPence / 2);
    }
  });

  it('cuts only the stories asked for', async () => {
    const source = await makeSource();
    const cuts = await cutStories({ source, only: [3, 7] }, buildDeps());

    expect(cuts.map((c) => c.story)).toEqual([3, 7]);
    expect(tts.calls).toBe(2);
  });

  it('resumes instead of rendering a second copy of every story', async () => {
    // A cut interrupted at story seven is resumed by running the same command
    // again. Without this the second attempt pays for all ten again AND leaves
    // ten duplicate runs beside the originals, indistinguishable in a listing.
    const source = await makeSource();
    const first = await cutStories({ source, only: [1, 2] }, buildDeps());
    const rendersAfterFirst = tts.calls;
    const spentAfterFirst = first.map((c) => c.run.manifest.spentPence);

    const second = await cutStories({ source }, buildDeps());

    expect(second).toHaveLength(STORIES);
    expect(second.slice(0, 2).map((c) => c.run.id)).toEqual(first.map((c) => c.run.id));
    expect(second.slice(0, 2).map((c) => c.script.title)).toEqual(first.map((c) => c.script.title));
    expect(second.slice(0, 2).map((c) => c.run.manifest.spentPence)).toEqual(spentAfterFirst);

    // Eight new renders, not ten.
    expect(tts.calls - rendersAfterFirst).toBe(STORIES - 2);
    expect(Run.derivedFrom(source.id, { root })).toHaveLength(STORIES);
  });

  it('gates each story as a ONE-BEAT format, not against all ten', async () => {
    // Passing the whole ten-beat format to gate a one-beat script made the gate
    // ask after nine beats that were never meant to be there - "beat story_02
    // cites 0 claims, below its floor of 6", and the same for story_03 through
    // story_10. Every short failed with ten to seventeen blocking findings,
    // almost all of them about beats belonging to other shorts.
    const source = await makeSource();
    const cuts = await cutStories({ source, only: [1] }, buildDeps());

    const density = cuts[0]!.gate.findings.filter((f) => f.check === 'evidenceDensity');
    for (const finding of density) {
      expect(finding.detail).not.toMatch(/story_(0[2-9]|10)/);
    }
  });

  it('re-renders when the source was remade under the same id', async () => {
    // A run id is deterministic - channel, episode, date, slug - so deleting a
    // source and remaking it the same day on the same topic produces the SAME
    // id. The shorts cut from the first one survive the deletion, are found by
    // that id, and their audio gets reused for a script they were never made
    // from. It happened: shorts timestamped 10:01 reused for a source created
    // at 12:41, every one with new words and old audio.
    const source = await makeSource();
    const first = await cutStories({ source, only: [1] }, buildDeps());
    const rendersAfterFirst = tts.calls;

    // The same run, its script replaced with different words - which is what a
    // remade source looks like from here.
    const script = source.readArtifact('script', scriptSchema);
    script.beats[0]!.turns = [
      { speaker: 'narrator', text: 'A completely different story about a different lake.' },
    ];
    source.writeArtifact('script', script);

    const second = await cutStories({ source, only: [1] }, buildDeps());

    expect(second[0]!.run.id).toBe(first[0]!.run.id);
    expect(tts.calls).toBeGreaterThan(rendersAfterFirst);
    expect(second[0]!.script.beats[0]!.turns[0]!.text).toMatch(/different lake/);
  });

  it('does not compare a story against itself or against the set it came from', async () => {
    // A cut story IS a beat of the source, word for word, so comparing the two
    // reports 100% overlap with something that is never published. And a second
    // cut compares a short against the copy of itself the first cut left on
    // disk, which reports 100% overlap with itself. Both were blocking every
    // short in a real set.
    const source = await makeSource();
    await cutStories({ source, only: [1] }, buildDeps());

    // Second cut, with the whole studio offered as prior work - which is what
    // the CLI hands it.
    const priors = Run.list({ root }).map((id) => ({
      label: id,
      text: 'unrelated words about a different subject entirely',
    }));
    const again = await cutStories({ source, only: [1] }, buildDeps({ priorTexts: priors }));

    const similarity = again[0]!.gate.findings.filter((f) => f.check === 'selfSimilarity');
    for (const finding of similarity) {
      expect(finding.detail).not.toContain(source.id);
      expect(finding.detail).not.toContain(again[0]!.run.id);
    }
  });

  it('REFUSES to cut a format that is not a source', async () => {
    // The long lane's shorts are DERIVED - a minute out of the middle of a
    // fifteen-minute story starts in the wrong place and ends in the wrong
    // place. Cutting one up beat by beat would publish ten fragments.
    const episode = Run.create(
      { personaId: PERSONA_ID, formatId: EPISODE_FORMAT_ID, topic: 'One trial' },
      { root }
    );
    await runEpisode(episode, buildDeps());

    await expect(cutStories({ source: episode }, buildDeps())).rejects.toThrow(
      /is not a source format/
    );
  });
});
