/**
 * Publishing into AudioVibe.
 *
 * THE ONE ARCHITECTURAL RULE OF THIS REPO LIVES HERE. The Foundry never writes
 * to the platform database. It authenticates as the show's own creator account
 * and calls the ordinary public API, exactly as a human creator would.
 *
 * Because it uses the same door, transcoding, loudness mastering, preview
 * generation, fingerprinting, content safety, follower fan-out, cache
 * invalidation, feed ranking and the seen ledger all behave identically. There
 * is no second code path to keep in sync, and a change to the platform's upload
 * pipeline cannot silently break the studio.
 *
 * The temptation to bypass this will come the first time something in the
 * upload path is inconvenient. Do not: the moment there are two ways for audio
 * to enter the platform, they start to differ, and the differences are always
 * discovered in production.
 */
import fs from 'fs';
import path from 'path';
import { fileBlob } from './mime';
import { z } from 'zod';
import { BeatTiming } from '../render/assemble';
import { ProvenancePayload } from './provenance';

export interface PublishInput {
  title: string;
  description: string;
  audioPath: string;
  /**
   * Which AudioVibe category the show publishes into, BY NAME.
   *
   * The API wants ids, not names, and it drops ids it does not recognise
   * silently rather than refusing them - so a wrong id produces an
   * uncategorised episode that publishes perfectly and is then invisible to
   * every genre-based rail. The name is resolved against the live category list
   * here, and a name that does not match is a loud failure listing what exists.
   */
  category: string;
  /**
   * Who the episode is for. Required by the API, with no default for a
   * non-adult creator: an upload that omits it is refused rather than assumed
   * general, which is how unrated content otherwise ends up rated.
   */
  contentRating?: ContentRating;
  /** Beat timestamps, sent so retention can be attributed to a kind of beat. */
  beatMap: BeatTiming[];
  provenance: ProvenancePayload;
  coverPath?: string;
  /**
   * Publish as an episode of this series instead of a standalone card.
   *
   * A serial REQUIRES this. Without it every episode lands loose in the
   * catalogue with no number and no order, and a serial a listener cannot play
   * in order is not a serial.
   */
  seriesId?: string;
}

export const CONTENT_RATINGS = ['general', 'mature', 'explicit'] as const;

export type ContentRating = (typeof CONTENT_RATINGS)[number];

export interface SeriesInput {
  title: string;
  description: string;
  category: string;
  contentRating?: ContentRating;
  coverPath?: string;
}

export const publishResultSchema = z.object({
  audioId: z.string(),
  status: z.string(),
});

export type PublishResult = z.infer<typeof publishResultSchema>;

export class PublishError extends Error {
  constructor(
    readonly status: number | null,
    message: string
  ) {
    // THE STATUS IS PART OF THE MESSAGE, because the message on its own is
    // often the platform's generic handler saying "An unexpected error
    // occurred" - which tells somebody staring at a failed publish nothing at
    // all, not even whether it was their request or the server. 500 and 413
    // are different problems with the same sentence attached.
    super(`publish failed${status ? ` (${status})` : ''}: ${message}`);
    this.name = 'PublishError';
  }
}

export type MultipartPost = (
  url: string,
  headers: Record<string, string>,
  form: FormData
) => Promise<{ status: number; json: unknown; text: string }>;

export const nodeMultipartPost: MultipartPost = async (url, headers, form) => {
  // Content-type is deliberately NOT set: fetch computes the multipart boundary
  // itself, and setting it by hand produces a body the server cannot parse.
  const res = await fetch(url, { method: 'POST', headers, body: form });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Left null; the caller reports raw text, which is what an HTML error page
    // from a proxy looks like.
  }
  return { status: res.status, json, text };
};

/** Injected so the unit suite never reaches the network. */
export type HttpGet = (
  url: string,
  headers: Record<string, string>
) => Promise<{ status: number; json: unknown; text: string }>;

export const nodeHttpGet: HttpGet = async (url, headers) => {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Left null; the caller reports raw text.
  }
  return { status: res.status, json, text };
};

export class AudioVibeClient {
  /**
   * Categories, fetched once per client.
   *
   * They change perhaps twice a year and a publish makes at most two calls that
   * need them, so re-fetching per call would be pure latency. Per-client rather
   * than module-level so one test never inherits another test's list.
   */
  private categories: Map<string, string> | null = null;

  constructor(
    private baseUrl: string,
    private token: string,
    private post: MultipartPost = nodeMultipartPost,
    private get: HttpGet = nodeHttpGet
  ) {}

  /**
   * Resolve a category NAME to the id the API wants.
   *
   * WHY THIS IS NOT OPTIONAL AND NOT BEST-EFFORT. The upload controller
   * requires at least one category id and then silently DROPS any id it does
   * not recognise. So sending a name where an id belongs fails outright, and
   * sending a plausible-but-wrong id succeeds and produces an episode that is
   * uncategorised: published, playable, and invisible to every genre rail and
   * to the recommender. The second failure is far worse than the first, because
   * nothing reports it.
   */
  async categoryId(name: string): Promise<string> {
    if (!this.categories) {
      // Public, unauthenticated, and cached hard by the API itself.
      const res = await this.get(`${this.baseUrl}/api/feed/categories`, {});
      if (res.status < 200 || res.status >= 300) {
        throw new PublishError(
          res.status,
          `could not read the category list: ${res.text.slice(0, 200)}`
        );
      }
      const body = res.json as {
        data?: { categories?: Array<{ id: string; name: string }> };
      } | null;
      const list = body?.data?.categories ?? [];
      if (!list.length) {
        throw new PublishError(res.status, 'the category list came back empty');
      }
      this.categories = new Map(list.map((c) => [c.name.toLowerCase(), c.id]));
    }

    const id = this.categories.get(name.toLowerCase());
    if (!id) {
      throw new PublishError(
        null,
        `no category named "${name}". The show's persona must name one of: ` +
          [...this.categories.keys()].sort().join(', ')
      );
    }
    return id;
  }

  /** The fields every studio upload sends, whether card, series or episode. */
  private async baseForm(input: {
    title: string;
    description: string;
    category: string;
    contentRating?: ContentRating;
    coverPath?: string;
  }): Promise<FormData> {
    const form = new FormData();
    form.append('title', input.title);
    form.append('description', input.description);
    form.append('category_ids', await this.categoryId(input.category));

    // Required by the API, which refuses an upload that omits it rather than
    // assuming general - quietly defaulting is how unrated content ends up
    // rated. Defaulted here rather than pushed onto every caller because every
    // show in this studio is general by construction: the personas forbid the
    // material that would make one anything else.
    form.append('content_rating', input.contentRating ?? 'general');

    if (input.coverPath && fs.existsSync(input.coverPath)) {
      // TYPED, because a blob without one is sent as application/octet-stream
      // and the platform's image filter rejects exactly that - while its audio
      // filter allows it, so the cover failed and the audio in the same request
      // did not.
      form.append(
        'cover',
        fileBlob(fs.readFileSync(input.coverPath), input.coverPath),
        path.basename(input.coverPath)
      );
    }
    return form;
  }

  private static readResult(res: {
    status: number;
    json: unknown;
    text: string;
  }): PublishResult {
    // The shape the shared upload controllers return: { data: { audio, ... } }.
    // Reading it correctly matters more than it looks - a missing id is treated
    // as a failure below, and getting the path wrong would make every
    // successful publish look like a failure and invite a retry that duplicates
    // the episode.
    const body = res.json as {
      data?: { audio?: { id?: string; processing_status?: string } };
    } | null;
    const audioId = body?.data?.audio?.id;
    if (!audioId) {
      throw new PublishError(
        res.status,
        `succeeded but returned no audio id: ${res.text.slice(0, 200)}`
      );
    }
    return { audioId, status: body?.data?.audio?.processing_status ?? 'pending' };
  }

  /**
   * Create the shelf a serial's episodes hang from.
   *
   * NOT IDEMPOTENT, AND CANNOT BE. The API has no create-or-get, so calling
   * this twice makes two series and the second one starts again at episode one.
   * The id it returns has to be recorded, which is what publish/seriesRegistry
   * is for and why that file is committed rather than treated as scratch.
   */
  async createSeries(input: SeriesInput): Promise<{ seriesId: string; title: string }> {
    const form = await this.baseForm(input);
    form.append('is_public', 'true');
    // THE SERIES ROUTE READS CATEGORIES AS A JSON LIST (2026-10-05): it
    // JSON.parse()s the field, so the bare id the audio route accepts made it
    // throw, and every first episode of a new series failed with "500: An
    // unexpected error occurred".
    form.set('category_ids', JSON.stringify([form.get('category_ids')]));

    const res = await this.post(
      `${this.baseUrl}/api/series/ingest`,
      { authorization: `Bearer ${this.token}` },
      form
    );

    if (res.status < 200 || res.status >= 300) {
      const body = res.json as { message?: string } | null;
      throw new PublishError(res.status, body?.message ?? res.text.slice(0, 300));
    }

    const body = res.json as { data?: { series?: { id?: string; title?: string } } } | null;
    const seriesId = body?.data?.series?.id;
    if (!seriesId) {
      throw new PublishError(
        res.status,
        `created a series but returned no id: ${res.text.slice(0, 200)}`
      );
    }
    return { seriesId, title: body?.data?.series?.title ?? input.title };
  }

  /**
   * Replace a series' cover on the platform, after it exists (2026-10-05). The
   * platform only lets a channel change its own series.
   */
  async updateSeriesCover(seriesId: string, coverPath: string): Promise<void> {
    const form = new FormData();
    form.append('cover', fileBlob(fs.readFileSync(coverPath), coverPath), path.basename(coverPath));
    const res = await this.post(
      `${this.baseUrl}/api/series/${encodeURIComponent(seriesId)}/cover/ingest`,
      { authorization: `Bearer ${this.token}` },
      form
    );
    if (res.status < 200 || res.status >= 300) {
      const body = res.json as { message?: string } | null;
      throw new PublishError(res.status, body?.message ?? res.text.slice(0, 300));
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    if (!fs.existsSync(input.audioPath)) {
      throw new PublishError(null, `no audio at ${input.audioPath}`);
    }

    const form = await this.baseForm(input);
    form.append(
      'audio',
      fileBlob(fs.readFileSync(input.audioPath), input.audioPath),
      path.basename(input.audioPath)
    );

    // The disclosure. Sent explicitly rather than inferred from the account,
    // because is_ai_generated is a fact about the ITEM: a show could in
    // principle publish something a human wrote and voiced.
    form.append('is_ai_generated', 'true');
    form.append('beat_map', JSON.stringify(input.beatMap));
    form.append('provenance', JSON.stringify(input.provenance));

    // TWO ENDPOINTS, AND THE CHOICE IS NOT COSMETIC. The audio route REFUSES a
    // series_id outright - it does not ignore it, it 400s - so an episode has
    // to go to the series route or it cannot be an episode at all.
    //
    // /api/audioS, plural. The router mounts audioRoutes at '/audios' and
    // getting this wrong 404s every publish, which the client then reports as a
    // failure with no hint that the path is the problem.
    const url = input.seriesId
      ? `${this.baseUrl}/api/series/${input.seriesId}/episodes/ingest`
      : `${this.baseUrl}/api/audios/ingest`;

    const res = await this.post(url, { authorization: `Bearer ${this.token}` }, form);

    if (res.status < 200 || res.status >= 300) {
      throw new PublishError(res.status, describeFailure(res));
    }

    return AudioVibeClient.readResult(res);
  }
}

/**
 * What went wrong, from a response that would rather not say.
 *
 * The platform's error handler answers a 500 with `{ message: "An unexpected
 * error occurred" }` and nothing else, which is correct of it - a public API
 * should not leak stack traces - and useless to the one person who needs to
 * know. So this takes whatever structure it can find, and when it finds only
 * that sentence it says where the real answer is instead of repeating it.
 */
export const describeFailure = (res: { status: number; json: unknown; text: string }): string => {
  const body = res.json as {
    message?: string;
    error?: { message?: string; code?: string; details?: unknown };
    errors?: unknown;
  } | null;

  const parts = [
    body?.error?.message ?? body?.message,
    body?.error?.code,
    body?.errors ? JSON.stringify(body.errors).slice(0, 200) : null,
  ].filter(Boolean);

  const said = parts.join(' | ') || res.text.slice(0, 300) || 'no message';

  // A 500 with the generic sentence means the detail is only in the server's
  // own log, and saying so beats leaving somebody to re-read their own request.
  if (res.status >= 500 && /unexpected error/i.test(said)) {
    return `${said} - the platform hit an error it did not describe. The reason is in the API service log on Railway, at the moment of this request.`;
  }

  return said;
};
