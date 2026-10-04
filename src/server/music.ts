/**
 * The music library and a run's mix, from the studio.
 *
 * Nothing here touches the platform. Uploads land in music/ on this machine and
 * a mix is ffmpeg over files already here; publishing sends only the mix somebody chose
 * with "use this version". See render/backing.ts for the rules.
 */
import http from 'http';
import { z } from 'zod';
import {
  BackingRefused,
  MAX_TRACK_BYTES,
  chooseMix,
  clearMix,
  unchooseMix,
  deleteTrack,
  listTracks,
  mixRun,
  mixState,
  mixedFileFor,
  saveTrack,
  trackFile,
} from '../render/backing';
import { Run } from '../run/store';
import { HttpError } from './routes';

const asHttp = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    // A refused track or mix is the person's to fix: a 400 with the reason.
    if (err instanceof BackingRefused) throw new HttpError(400, err.message);
    throw err;
  }
};

/** Raw bytes, as the artwork upload takes them: a File is already a body. */
export const readTrack = async (req: http.IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_TRACK_BYTES) {
      throw new HttpError(413, `that file is over ${MAX_TRACK_BYTES / (1024 * 1024)}MB`);
    }
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) throw new HttpError(400, 'there was no file in that request');
  return Buffer.concat(chunks);
};

export const musicLibrary = () => ({ tracks: listTracks() });

export const uploadTrack = (name: string | null, bytes: Buffer) =>
  asHttp(() => {
    if (!name) throw new HttpError(400, 'give the track a name');
    return { ok: true as const, track: saveTrack(name, bytes) };
  });

export const removeTrack = (name: string | null) => ({
  ok: true as const,
  removed: deleteTrack(name ?? ''),
});

export const trackFileFor = (name: string | null): string | null => (name ? trackFile(name) : null);

export const runMixState = (runId: string) => mixState(Run.open(runId));

const mixBody = z.object({
  track: z.string().min(1),
  volume: z.number().min(0).max(100),
  duck: z.boolean().default(true),
});

export const makeMix = (runId: string, body: unknown) =>
  asHttp(async () => {
    const input = mixBody.parse(body);
    const run = Run.open(runId);
    await mixRun(run, input);
    return mixState(run);
  });

export const removeMix = (runId: string) => {
  const run = Run.open(runId);
  clearMix(run);
  return mixState(run);
};

/** "Use this version": the preview becomes what publishing sends. */
export const useMix = (runId: string) =>
  asHttp(() => {
    const run = Run.open(runId);
    chooseMix(run);
    return mixState(run);
  });

/** Publish the voice alone again. */
export const voiceOnly = (runId: string) => {
  const run = Run.open(runId);
  unchooseMix(run);
  return mixState(run);
};

export const mixedFile = (runId: string, which: string | null): string | null =>
  mixedFileFor(Run.open(runId), which === 'chosen' ? 'chosen' : 'preview');
