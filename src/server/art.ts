/**
 * Choosing a picture, from the studio rather than by copying files about.
 *
 * WHY THIS IS A SEPARATE FILE FROM operate.ts. Nothing here touches the
 * platform. It writes a file to this machine's disk and reads it back, and the
 * upload happens later, inside the setup or publish that was going to run
 * anyway. Keeping it apart means the list of things that can reach production
 * stays short enough to read.
 *
 * THE SHAPES ARE NOT NEGOTIABLE AND ARE NOT INVENTED HERE. Every target below
 * is the size the corresponding renderer already produces, imported rather than
 * retyped: a supplied avatar has to match what art/channel.ts draws, and a
 * supplied episode cover has to match art/cover.ts, because the app crops to
 * one ratio and does not care which of the two made the file.
 */
import fs from 'fs';
import path from 'path';
import { loadPersona } from '../canon/load';
import { repoRoot } from '../config';
import { AVATAR_SIZE, PROFILE_BANNER_SIZE } from '../art/generate';
import { AUDIO_COVER_SIZE, SERIES_COVER_SIZE } from '../art/cover';
import {
  ArtRefused,
  ArtShape,
  removeSuppliedArt,
  saveSuppliedArt,
  suppliedArt,
} from '../art/supplied';
import { Run } from '../run/store';
import { HttpError } from './routes';

export type ChannelArtKind = 'avatar' | 'cover' | 'series';

/**
 * What each picture has to be, and what to call it when refusing one.
 *
 * The labels are the words the interface uses, not the words the code does. A
 * person who picked the wrong file is not helped by being told that `cover`
 * failed a check.
 */
export const SHAPES: Record<ChannelArtKind, ArtShape> = {
  avatar: { width: AVATAR_SIZE, height: AVATAR_SIZE, label: 'profile picture' },
  cover: { width: PROFILE_BANNER_SIZE.width, height: PROFILE_BANNER_SIZE.height, label: 'cover image' },
  // The shelf a serial's episodes sit on. Read once, by series setup.
  series: { width: SERIES_COVER_SIZE.width, height: SERIES_COVER_SIZE.height, label: 'series cover' },
};

export const EPISODE_SHAPE: ArtShape = {
  width: AUDIO_COVER_SIZE.width,
  height: AUDIO_COVER_SIZE.height,
  label: 'episode image',
};

/**
 * How large an upload may be.
 *
 * Bigger than the JSON limit by a lot, because this is the one route that
 * carries a photograph. A 1536x1024 PNG straight out of a camera roll is
 * comfortably several megabytes, and refusing it would send somebody away to
 * compress a file for no reason the studio can explain.
 */
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

const artDirFor = (channelId: string): string => {
  // THE SHAPE OF THE ID IS CHECKED BEFORE ANYTHING USES IT, and separately
  // from whether the channel exists. Loading the persona does refuse
  // "../../etc" today, but only because no persona happens to live there -
  // which is luck rather than a rule, and this id goes on to build a path that
  // gets written to. The pattern is the one personaSchema already enforces.
  if (!/^[a-z0-9-]+$/.test(channelId)) {
    throw new HttpError(400, `"${channelId}" is not a channel id`);
  }

  // And this is the check that it is a channel this studio knows about.
  loadPersona(channelId);
  return path.join(repoRoot(), 'art', channelId);
};

const runMediaDir = (runId: string): string => path.dirname(Run.open(runId).mediaPath('cover.png'));

const asHttp = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (err) {
    // A refused picture is the person's to fix, so it is a 400 with the reason
    // rather than a 500 with a stack trace.
    if (err instanceof ArtRefused) throw new HttpError(400, err.message);
    throw err;
  }
};

export interface ArtState {
  /** Whether this picture is one a person chose. */
  supplied: boolean;
  /** What shape a replacement has to be, so the interface can say so. */
  width: number;
  height: number;
}

const state = (dir: string, name: string, shape: ArtShape): ArtState => ({
  supplied: Boolean(suppliedArt(dir, name)),
  width: shape.width,
  height: shape.height,
});

/** What the channel is wearing, and what a replacement would have to be. */
export const channelArtState = (channelId: string): Record<ChannelArtKind, ArtState> => {
  const dir = artDirFor(channelId);
  return {
    avatar: state(dir, 'avatar', SHAPES.avatar),
    cover: state(dir, 'cover', SHAPES.cover),
    series: state(dir, 'series', SHAPES.series),
  };
};

export const runArtState = (runId: string): ArtState =>
  state(runMediaDir(runId), 'cover', EPISODE_SHAPE);

export const saveChannelArt = (channelId: string, kind: ChannelArtKind, bytes: Buffer) => {
  const { size } = asHttp(() =>
    saveSuppliedArt(artDirFor(channelId), kind, bytes, SHAPES[kind])
  );
  return { ok: true as const, kind, width: size.width, height: size.height };
};

export const removeChannelArt = (channelId: string, kind: ChannelArtKind) => ({
  ok: true as const,
  removed: removeSuppliedArt(artDirFor(channelId), kind),
});

export const saveRunArt = (runId: string, bytes: Buffer) => {
  const { size } = asHttp(() => saveSuppliedArt(runMediaDir(runId), 'cover', bytes, EPISODE_SHAPE));
  return { ok: true as const, width: size.width, height: size.height };
};

export const removeRunArt = (runId: string) => ({
  ok: true as const,
  removed: removeSuppliedArt(runMediaDir(runId), 'cover'),
});

/**
 * The file to show in the interface, whichever kind it turned out to be.
 *
 * SUPPLIED FIRST, THEN DRAWN, which is the same order the publish uses. A
 * preview that showed the drawn one while the supplied one was what shipped
 * would be worse than no preview.
 *
 * Null rather than a throw when there is nothing yet: a channel before its
 * first setup genuinely has no picture, and that is a state the page draws
 * rather than an error it reports.
 */
export const channelArtFile = (channelId: string, kind: ChannelArtKind): string | null => {
  const dir = artDirFor(channelId);
  const drawn = path.join(dir, `${kind}.png`);
  return suppliedArt(dir, kind) ?? (fs.existsSync(drawn) ? drawn : null);
};

export const runArtFile = (runId: string): string | null => {
  const dir = runMediaDir(runId);
  const drawn = path.join(dir, 'cover.png');
  return suppliedArt(dir, 'cover') ?? (fs.existsSync(drawn) ? drawn : null);
};

/** The kind named in a query string, or a 400 saying which ones exist. */
export const artKind = (raw: string | null): ChannelArtKind => {
  if (raw === 'avatar' || raw === 'cover' || raw === 'series') return raw;
  throw new HttpError(400, `kind has to be "avatar", "cover" or "series", not ${JSON.stringify(raw)}`);
};
