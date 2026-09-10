/**
 * The publish client, which is the one part of this repo that had never been
 * executed against the real API and was wrong in three separate ways at once.
 *
 * All three failed differently and none of them failed in a way the pipeline
 * could see:
 *   - it sent a category NAME in a field that wants ids, so every upload 400d
 *   - it omitted content_rating, which the API refuses rather than defaults
 *   - it had no series route, so a serial's episodes could only land loose
 *
 * What is pinned here is the wire format, because that is the whole contract
 * and it is invisible from inside the Foundry. Everything is asserted off the
 * FormData actually handed to the transport rather than off a return value.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AudioVibeClient, PublishError } from '../ingest';
import { ProvenancePayload } from '../provenance';

const CATEGORIES = {
  status: 200,
  json: {
    data: {
      categories: [
        { id: 'cat-biz', name: 'Business & Finance' },
        { id: 'cat-fic', name: 'Fiction' },
      ],
    },
  },
  text: '',
};

const provenance = {
  persona_ref: 'the-teardown',
  content_kind: 'reported',
  generator_version: '0.1.0',
  model_ids: {},
  evidence_summary: {
    claim_count: 0,
    claims_by_tier: {},
    counter_evidence_found: false,
    counter_evidence_addressed: false,
    sources: [],
  },
  rendered_at: '2026-09-10T00:00:00.000Z',
} as ProvenancePayload;

/** Records every call, so the wire format can be read back. */
const spyTransport = (
  responses: Array<{ status: number; json: unknown; text: string }>
) => {
  const posts: Array<{ url: string; form: FormData; headers: Record<string, string> }> = [];
  const gets: string[] = [];
  let next = 0;

  return {
    posts,
    gets,
    post: async (url: string, headers: Record<string, string>, form: FormData) => {
      posts.push({ url, form, headers });
      return responses[next++] ?? { status: 201, json: {}, text: '' };
    },
    get: async (url: string) => {
      gets.push(url);
      return CATEGORIES;
    },
  };
};

const audioOk = {
  status: 201,
  json: { data: { audio: { id: 'audio-1', processing_status: 'processing' } } },
  text: '',
};

describe('AudioVibeClient', () => {
  let dir: string;
  let audioPath: string;

  const client = (t: ReturnType<typeof spyTransport>) =>
    new AudioVibeClient('https://staging.example.com', 'tok', t.post, t.get);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-publish-'));
    audioPath = path.join(dir, 'episode.wav');
    fs.writeFileSync(audioPath, Buffer.alloc(64));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = () => ({
    title: 'An episode',
    description: 'Two sentences.',
    audioPath,
    category: 'Business & Finance',
    beatMap: [],
    provenance,
  });

  describe('categories', () => {
    it('sends category_ids with a resolved ID, not the name', () => {
      // The bug that would have 400d every publish ever made. The controller
      // reads category_ids and requires at least one.
      const t = spyTransport([audioOk]);
      return client(t)
        .publish(base())
        .then(() => {
          expect(t.posts[0]!.form.get('category_ids')).toBe('cat-biz');
          expect(t.posts[0]!.form.get('categories')).toBeNull();
        });
    });

    it('REFUSES a category name the platform does not have', async () => {
      // The worse half of the same bug. The API silently DROPS an id it does
      // not recognise, so a wrong one publishes an uncategorised episode that
      // works perfectly and is invisible to every genre rail. Failing loudly
      // here is the only place it can be caught.
      const t = spyTransport([audioOk]);
      await expect(
        client(t).publish({ ...base(), category: 'Underwater Basket Weaving' })
      ).rejects.toThrow(/no category named/i);
    });

    it('names what the platform does have, so the fix is obvious', async () => {
      const t = spyTransport([audioOk]);
      await expect(client(t).publish({ ...base(), category: 'Nope' })).rejects.toThrow(
        /business & finance/i
      );
    });

    it('matches case-insensitively', async () => {
      const t = spyTransport([audioOk]);
      await client(t).publish({ ...base(), category: 'business & finance' });
      expect(t.posts[0]!.form.get('category_ids')).toBe('cat-biz');
    });

    it('fetches the list once per client, not once per call', async () => {
      const t = spyTransport([audioOk, audioOk]);
      const c = client(t);
      await c.publish(base());
      await c.publish(base());
      expect(t.gets).toHaveLength(1);
    });

    it('refuses rather than guessing when the list comes back empty', async () => {
      const t = spyTransport([audioOk]);
      const c = new AudioVibeClient('https://x.example.com', 'tok', t.post, async () => ({
        status: 200,
        json: { data: { categories: [] } },
        text: '',
      }));
      await expect(c.publish(base())).rejects.toThrow(/came back empty/);
    });
  });

  describe('content rating', () => {
    it('always sends one, because the API refuses an upload without it', async () => {
      // Not a default the server applies - resolveContentRating throws when a
      // non-adult creator omits it, because quietly defaulting is how unrated
      // content ends up rated.
      const t = spyTransport([audioOk]);
      await client(t).publish(base());
      expect(t.posts[0]!.form.get('content_rating')).toBe('general');
    });

    it('sends what it was given', async () => {
      const t = spyTransport([audioOk]);
      await client(t).publish({ ...base(), contentRating: 'mature' });
      expect(t.posts[0]!.form.get('content_rating')).toBe('mature');
    });
  });

  describe('the disclosure', () => {
    it('goes on every upload', async () => {
      const t = spyTransport([audioOk]);
      await client(t).publish(base());
      expect(t.posts[0]!.form.get('is_ai_generated')).toBe('true');
    });

    it('goes on a series episode too', async () => {
      // The path that did not exist. An episode publishing without the label
      // would be a compliance problem, not a data-quality one.
      const t = spyTransport([audioOk]);
      await client(t).publish({ ...base(), seriesId: 'series-1' });
      expect(t.posts[0]!.form.get('is_ai_generated')).toBe('true');
      expect(t.posts[0]!.form.get('provenance')).toBeTruthy();
    });
  });

  describe('where it posts', () => {
    it('sends a loose card to the AUDIOS route, plural', async () => {
      // Getting this wrong 404s every publish, and the client then reports a
      // failure with no hint that the path is the problem.
      const t = spyTransport([audioOk]);
      await client(t).publish(base());
      expect(t.posts[0]!.url).toBe('https://staging.example.com/api/audios/ingest');
    });

    it('sends an episode to the SERIES route', async () => {
      // Not cosmetic: the audio route refuses a series_id outright, it does not
      // ignore it, so an episode has to go here or it cannot be an episode.
      const t = spyTransport([audioOk]);
      await client(t).publish({ ...base(), seriesId: 'series-1' });
      expect(t.posts[0]!.url).toBe(
        'https://staging.example.com/api/series/series-1/episodes/ingest'
      );
    });

    it('carries the credential', async () => {
      const t = spyTransport([audioOk]);
      await client(t).publish(base());
      expect(t.posts[0]!.headers.authorization).toBe('Bearer tok');
    });
  });

  describe('reading the result', () => {
    it('reads the id out of data.audio, not data', async () => {
      // Reading this wrong makes every successful publish look like a failure
      // and invites a retry that duplicates the episode.
      const t = spyTransport([audioOk]);
      const res = await client(t).publish(base());
      expect(res).toEqual({ audioId: 'audio-1', status: 'processing' });
    });

    it('treats a 2xx with no id as a failure', async () => {
      const t = spyTransport([{ status: 201, json: { data: {} }, text: '{}' }]);
      await expect(client(t).publish(base())).rejects.toThrow(/no audio id/);
    });

    it('reports the API message on a refusal', async () => {
      const t = spyTransport([
        { status: 400, json: { message: 'At least one category is required' }, text: '' },
      ]);
      await expect(client(t).publish(base())).rejects.toThrow(/At least one category/);
    });

    it('refuses before the network when the audio file is missing', async () => {
      const t = spyTransport([audioOk]);
      await expect(
        client(t).publish({ ...base(), audioPath: path.join(dir, 'gone.wav') })
      ).rejects.toThrow(PublishError);
      expect(t.posts).toHaveLength(0);
    });
  });

  describe('createSeries', () => {
    const seriesOk = {
      status: 201,
      json: { data: { series: { id: 'series-7', title: 'Night Shift' } } },
      text: '',
    };

    it('posts to the series ingest route with a resolved category', async () => {
      const t = spyTransport([seriesOk]);
      const res = await client(t).createSeries({
        title: 'Night Shift',
        description: 'A hospital at night.',
        category: 'Fiction',
      });

      expect(t.posts[0]!.url).toBe('https://staging.example.com/api/series/ingest');
      expect(t.posts[0]!.form.get('category_ids')).toBe('cat-fic');
      expect(t.posts[0]!.form.get('content_rating')).toBe('general');
      expect(res.seriesId).toBe('series-7');
    });

    it('treats a 2xx with no series id as a failure', async () => {
      // A caller that recorded an undefined id would create a second series on
      // the next publish and fork the show.
      const t = spyTransport([{ status: 201, json: { data: {} }, text: '{}' }]);
      await expect(
        client(t).createSeries({ title: 'x', description: 'y', category: 'Fiction' })
      ).rejects.toThrow(/no id/);
    });
  });
});
