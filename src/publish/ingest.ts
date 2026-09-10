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
    super(`publish failed: ${message}`);
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
      form.append(
        'cover',
        new Blob([fs.readFileSync(input.coverPath)]),
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

  async publish(input: PublishInput): Promise<PublishResult> {
    if (!fs.existsSync(input.audioPath)) {
      throw new PublishError(null, `no audio at ${input.audioPath}`);
    }

    const form = await this.baseForm(input);
    form.append(
      'audio',
      new Blob([fs.readFileSync(input.audioPath)]),
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
      const body = res.json as { message?: string } | null;
      throw new PublishError(res.status, body?.message ?? res.text.slice(0, 300));
    }

    return AudioVibeClient.readResult(res);
  }
}
