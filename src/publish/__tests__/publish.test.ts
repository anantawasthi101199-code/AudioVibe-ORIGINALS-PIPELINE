import fs from 'fs';
import os from 'os';
import path from 'path';
import { Claim } from '../../evidence/claim';
import { Source } from '../../evidence/source';
import { buildProvenance, GENERATOR_VERSION } from '../provenance';
import { AudioVibeClient, PublishError } from '../ingest';

const source = (over: Partial<Source> = {}): Source =>
  ({
    id: 's1',
    url: 'https://www.sec.gov/f',
    title: 'A Filing',
    publisher: 'SEC',
    publishedAt: '2024-03-01',
    retrievedAt: '2026-09-08T00:00:00.000Z',
    contentHash: 'a'.repeat(64),
    tier: 'T1',
    text: 'x',
    httpStatus: 200,
    ...over,
  }) as Source;

const claim = (over: Partial<Claim> = {}): Claim => ({
  id: 'c1',
  text: 'x',
  type: 'statistic',
  beatId: 'stakes',
  sourceId: 's1',
  quote: 'q'.repeat(50),
  contested: false,
  ...over,
});

describe('buildProvenance', () => {
  const base = {
    personaId: 'the-teardown',
    counterEvidenceAddressed: false,
    models: { writer: 'w-1', verifier: 'v-1' },
    renderedAt: new Date('2026-09-08T12:00:00.000Z'),
  };

  it('counts claims by tier', () => {
    const p = buildProvenance({
      ...base,
      claims: [claim(), claim({ id: 'c2', sourceId: 's2' })],
      sources: [source(), source({ id: 's2', tier: 'T3', url: 'https://x.com/a' })],
      counterEvidence: [],
    });
    expect(p.evidence_summary.claim_count).toBe(2);
    expect(p.evidence_summary.claims_by_tier).toEqual({ T1: 1, T3: 1 });
  });

  it('lists ONLY sources a claim actually rests on', () => {
    // A corpus entry that was fetched and never used is working state, not
    // evidence, and listing it pads the sheet with documents the episode does
    // not depend on.
    const p = buildProvenance({
      ...base,
      claims: [claim()],
      sources: [source(), source({ id: 'unused', url: 'https://unused.com/x' })],
      counterEvidence: [],
    });
    expect(p.evidence_summary.sources).toHaveLength(1);
    expect(p.evidence_summary.sources[0]!.title).toBe('A Filing');
  });

  it('orders sources strongest first', () => {
    // The order a reader scanning for authority wants, and it puts the primary
    // documents where the show's claim on attention is.
    const p = buildProvenance({
      ...base,
      claims: [claim(), claim({ id: 'c2', sourceId: 's2' })],
      sources: [source({ id: 's2', tier: 'T4', url: 'https://reddit.com/x' }), source()],
      counterEvidence: [],
    });
    expect(p.evidence_summary.sources.map((s) => s.tier)).toEqual(['T1', 'T4']);
  });

  it('records whether counter-evidence was found and whether it was addressed', () => {
    const p = buildProvenance({
      ...base,
      claims: [claim()],
      sources: [source()],
      counterEvidence: [{ claimId: 'c1', sources: [source({ id: 'cx' })], queries: ['q'] }],
      counterEvidenceAddressed: true,
    });
    expect(p.evidence_summary.counter_evidence_found).toBe(true);
    expect(p.evidence_summary.counter_evidence_addressed).toBe(true);
  });

  it('records the generator version and every model that touched it', () => {
    // "Which writer produced the episode that got a claim wrong" has to stay
    // answerable months later.
    const p = buildProvenance({ ...base, claims: [claim()], sources: [source()], counterEvidence: [] });
    expect(p.generator_version).toBe(GENERATOR_VERSION);
    expect(p.model_ids).toEqual({ writer: 'w-1', verifier: 'v-1' });
    expect(p.persona_ref).toBe('the-teardown');
  });
});

describe('AudioVibeClient', () => {
  let dir: string;
  let audioPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-publish-'));
    audioPath = path.join(dir, 'episode.wav');
    fs.writeFileSync(audioPath, Buffer.alloc(2048));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const input = () => ({
    title: 'A Title',
    description: 'A description.',
    audioPath,
    category: 'Business & Finance',
    beatMap: [{ id: 'cold_open', type: 'cold_open', startS: 0, endS: 12 }],
    provenance: buildProvenance({
      personaId: 'the-teardown',
      claims: [claim()],
      sources: [source()],
      counterEvidence: [],
      counterEvidenceAddressed: false,
      models: { writer: 'w' },
      renderedAt: new Date('2026-09-08T12:00:00.000Z'),
    }),
  });

  it('publishes and returns the audio id', async () => {
    const client = new AudioVibeClient('https://api.example', 'tok', async () => ({
      status: 201,
      json: { data: { audio: { id: 'aud-1', processing_status: 'pending' } } },
      text: '',
    }));
    expect(await client.publish(input())).toEqual({ audioId: 'aud-1', status: 'pending' });
  });

  it('sends the AI disclosure explicitly, not by inference from the account', async () => {
    // is_ai_generated is a fact about the ITEM: a show could publish something
    // a human wrote and voiced.
    let form: FormData | null = null;
    const client = new AudioVibeClient('https://api.example', 'tok', async (_u, _h, f) => {
      form = f;
      return { status: 201, json: { data: { audio: { id: 'a' } } }, text: '' };
    });
    await client.publish(input());
    expect(form!.get('is_ai_generated')).toBe('true');
  });

  it('sends the beat map and the provenance', async () => {
    let form: FormData | null = null;
    const client = new AudioVibeClient('https://api.example', 'tok', async (_u, _h, f) => {
      form = f;
      return { status: 201, json: { data: { audio: { id: 'a' } } }, text: '' };
    });
    await client.publish(input());
    expect(JSON.parse(String(form!.get('beat_map')))[0].id).toBe('cold_open');
    expect(JSON.parse(String(form!.get('provenance'))).persona_ref).toBe('the-teardown');
  });

  it('posts to /api/audios (PLURAL), which is where the router mounts it', async () => {
    // Verified against the live API: /api/audio/ingest 404s, /api/audios/ingest
    // returns 401. Getting this wrong fails every publish with no hint that the
    // path is the problem.
    let url = '';
    const client = new AudioVibeClient('https://api.example', 'tok', async (u) => {
      url = u;
      return { status: 201, json: { data: { audio: { id: 'a' } } }, text: '' };
    });
    await client.publish(input());
    expect(url).toBe('https://api.example/api/audios/ingest');
  });

  it('authenticates with the ingest token as a bearer', async () => {
    let headers: Record<string, string> = {};
    const client = new AudioVibeClient('https://api.example', 'tok', async (_u, h) => {
      headers = h;
      return { status: 201, json: { data: { audio: { id: 'a' } } }, text: '' };
    });
    await client.publish(input());
    expect(headers.authorization).toBe('Bearer tok');
  });

  it('does NOT set content-type, so fetch computes the multipart boundary', async () => {
    // Setting it by hand produces a body the server cannot parse.
    let headers: Record<string, string> = {};
    const client = new AudioVibeClient('https://api.example', 'tok', async (_u, h) => {
      headers = h;
      return { status: 201, json: { data: { audio: { id: 'a' } } }, text: '' };
    });
    await client.publish(input());
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('content-type');
  });

  it('refuses when the audio file is missing', async () => {
    const client = new AudioVibeClient('https://api.example', 'tok', async () => ({ status: 201, json: {}, text: '' }));
    await expect(client.publish({ ...input(), audioPath: '/nope.wav' })).rejects.toThrow(PublishError);
  });

  it('surfaces the server message on failure', async () => {
    const client = new AudioVibeClient('https://api.example', 'tok', async () => ({
      status: 401,
      json: { message: 'Unauthorized' },
      text: '',
    }));
    await expect(client.publish(input())).rejects.toThrow(/Unauthorized/);
  });

  it('treats a success with no audio id as a failure', async () => {
    // Otherwise the run records a publish that may not have happened.
    const client = new AudioVibeClient('https://api.example', 'tok', async () => ({
      status: 201,
      json: { data: {} },
      text: '{}',
    }));
    await expect(client.publish(input())).rejects.toThrow(/returned no audio id/);
  });
});
