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
  /** Which AudioVibe category the show publishes into. */
  category: string;
  /** Beat timestamps, sent so retention can be attributed to a kind of beat. */
  beatMap: BeatTiming[];
  provenance: ProvenancePayload;
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

export class AudioVibeClient {
  constructor(
    private baseUrl: string,
    private token: string,
    private post: MultipartPost = nodeMultipartPost
  ) {}

  async publish(input: PublishInput): Promise<PublishResult> {
    if (!fs.existsSync(input.audioPath)) {
      throw new PublishError(null, `no audio at ${input.audioPath}`);
    }

    const form = new FormData();
    const audio = new Blob([fs.readFileSync(input.audioPath)]);
    form.append('audio', audio, path.basename(input.audioPath));
    form.append('title', input.title);
    form.append('description', input.description);
    form.append('categories', input.category);

    // The disclosure. Sent explicitly rather than inferred from the account,
    // because is_ai_generated is a fact about the ITEM: a show could in
    // principle publish something a human wrote and voiced.
    form.append('is_ai_generated', 'true');
    form.append('beat_map', JSON.stringify(input.beatMap));
    form.append('provenance', JSON.stringify(input.provenance));

    if (input.coverPath && fs.existsSync(input.coverPath)) {
      form.append('cover', new Blob([fs.readFileSync(input.coverPath)]), path.basename(input.coverPath));
    }

    const res = await this.post(
      `${this.baseUrl}/api/audio/ingest`,
      { authorization: `Bearer ${this.token}` },
      form
    );

    if (res.status < 200 || res.status >= 300) {
      const body = res.json as { message?: string } | null;
      throw new PublishError(res.status, body?.message ?? res.text.slice(0, 300));
    }

    // The shape the shared upload controller returns: { data: { audio, ... } }.
    // Reading it correctly matters more than it looks - a missing id is treated
    // as a failure below, and getting the path wrong would make every
    // successful publish look like a failure and invite a retry that
    // duplicates the episode.
    const body = res.json as { data?: { audio?: { id?: string; processing_status?: string } } } | null;
    const audioId = body?.data?.audio?.id;
    if (!audioId) {
      throw new PublishError(res.status, `succeeded but returned no audio id: ${res.text.slice(0, 200)}`);
    }

    return { audioId, status: body?.data?.audio?.processing_status ?? 'pending' };
  }
}
