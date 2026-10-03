/**
 * Your own music under a finished episode: a library of uploaded tracks, and a
 * mix you can redo as often as you like before publishing.
 *
 * THE FLOW. Render the episode voice-only (music is off by default everywhere).
 * Upload an mp3 to the library once. On the run, pick a track and a volume and
 * mix; listen; change the volume and mix again. Publishing sends the mix.
 * Everything is ffmpeg on this machine, so none of it costs anything.
 *
 * THE VOICE FILE IS NEVER TOUCHED. The mix is written beside it as
 * episode.mixed.wav, so every remix starts from clean speech rather than from
 * the last mix, and removing the music is deleting one file.
 *
 * A STALE MIX IS NEVER PUBLISHED. The mix records the size and modified time of
 * the voice file it was made from. Re-render the episode and the mix no longer
 * matches, so publish falls back to the voice and the page says to mix again.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { repoRoot } from '../config';
import { Run } from '../run/store';
import { probeDuration, runProcess } from './assemble';
import { DUCK } from './bed';

/** Where uploaded tracks live. Gitignored: music is yours, not the repo's. */
export const musicDir = (): string => process.env.FOUNDRY_MUSIC_DIR ?? path.join(repoRoot(), 'music');

/** Big enough for a long track at a high bitrate, small enough to refuse a video. */
export const MAX_TRACK_BYTES = 40 * 1024 * 1024;

export class BackingRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackingRefused';
  }
}

/** A track's name on disk: lowercase words joined by hyphens. */
export const trackSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/\.mp3$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

const trackPath = (name: string): string => {
  const slug = trackSlug(name);
  if (!slug) throw new BackingRefused('a track needs a name');
  return path.join(musicDir(), `${slug}.mp3`);
};

/** An MP3 announces itself: an ID3 tag, or an MPEG audio frame sync. */
export const looksLikeMp3 = (bytes: Buffer): boolean =>
  (bytes.length > 3 && bytes.subarray(0, 3).toString('latin1') === 'ID3') ||
  (bytes.length > 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);

export interface Track {
  name: string;
  bytes: number;
}

export const listTracks = (): Track[] => {
  const dir = musicDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.mp3'))
    .sort()
    .map((f) => ({ name: f.replace(/\.mp3$/, ''), bytes: fs.statSync(path.join(dir, f)).size }));
};

export const saveTrack = (name: string, bytes: Buffer): Track => {
  if (bytes.length > MAX_TRACK_BYTES) {
    throw new BackingRefused(`that file is over ${MAX_TRACK_BYTES / (1024 * 1024)}MB. Use a shorter or lighter mp3.`);
  }
  if (!looksLikeMp3(bytes)) {
    throw new BackingRefused('that file is not an mp3. The file itself says so, whatever its name.');
  }
  const file = trackPath(name);
  fs.mkdirSync(musicDir(), { recursive: true });
  fs.writeFileSync(file, bytes);
  return { name: path.basename(file, '.mp3'), bytes: bytes.length };
};

export const trackFile = (name: string): string | null => {
  const file = trackPath(name);
  return fs.existsSync(file) ? file : null;
};

export const deleteTrack = (name: string): boolean => {
  const file = trackFile(name);
  if (!file) return false;
  fs.rmSync(file);
  return true;
};

// --- The mix ----------------------------------------------------------------

export const mixSchema = z.object({
  track: z.string().min(1),
  /** Music level, 0 to 100. 15 sits under speech; 30 is clearly present. */
  volume: z.number().min(0).max(100),
  /** Push the music down while somebody is speaking. */
  duck: z.boolean(),
  /** The voice file this was made from, so a re-render makes it stale. */
  voiceBytes: z.number(),
  voiceMtimeMs: z.number(),
  mixedAt: z.string(),
});

export type Mix = z.infer<typeof mixSchema>;

const MIXED = 'episode.mixed.wav';
const FADE_IN_S = 3;
const FADE_OUT_S = 4;

const voiceSignature = (file: string) => {
  const st = fs.statSync(file);
  return { voiceBytes: st.size, voiceMtimeMs: Math.round(st.mtimeMs) };
};

export interface MixState {
  mix: Mix | null;
  /** The mix exists but was made from a voice file that has since changed. */
  stale: boolean;
}

// Its own small file beside the audio, not a pipeline artifact: mixing is not a
// stage, and a resume must never think it has one to redo.
const recordPath = (run: Run): string => run.mediaPath('mix.json');

const readMix = (run: Run): Mix | null => {
  const file = recordPath(run);
  if (!fs.existsSync(file)) return null;
  const parsed = mixSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  return parsed.success ? parsed.data : null;
};

export const mixState = (run: Run): MixState => {
  const mix = readMix(run);
  if (!mix) return { mix: null, stale: false };
  const voice = run.audioFile();
  const mixed = path.join(path.dirname(run.mediaPath(MIXED)), MIXED);
  if (!voice || !fs.existsSync(mixed)) return { mix, stale: true };
  const now = voiceSignature(voice);
  return { mix, stale: now.voiceBytes !== mix.voiceBytes || now.voiceMtimeMs !== mix.voiceMtimeMs };
};

/** The file to publish: the mix when there is a current one, else null. */
export const mixedAudioFor = (run: Run): string | null => {
  const state = mixState(run);
  return state.mix && !state.stale ? run.mediaPath(MIXED) : null;
};

export const mixedFileFor = (run: Run): string | null => {
  const file = run.mediaPath(MIXED);
  return fs.existsSync(file) ? file : null;
};

export interface MixDeps {
  run?: typeof runProcess;
  ffmpeg?: string;
  probe?: (file: string) => Promise<number | null>;
}

/**
 * Mix a library track under the episode's voice, at a chosen level.
 *
 * The track loops if it is shorter than the episode and is cut if longer,
 * with a fade at each end. Ducking, when on, is the same sidechain the
 * synthesised bed uses, so speech always wins.
 */
export const mixRun = async (
  run: Run,
  input: { track: string; volume: number; duck: boolean },
  deps: MixDeps = {}
): Promise<Mix> => {
  const voice = run.audioFile();
  if (!voice) throw new BackingRefused('this run has no audio yet. Voice it first, then add music.');
  const track = trackFile(input.track);
  if (!track) throw new BackingRefused(`no track called "${input.track}" in the music library`);
  if (!(input.volume >= 0 && input.volume <= 100)) {
    throw new BackingRefused('the volume is a number from 0 to 100');
  }

  const d = await (deps.probe ?? probeDuration)(voice);
  if (!d) throw new BackingRefused('could not measure the episode audio');

  const gain = (input.volume / 100).toFixed(3);
  const fadeOutAt = Math.max(0, d - FADE_OUT_S).toFixed(3);
  const bed =
    `[0:a]atrim=0:${d.toFixed(3)},asetpts=PTS-STARTPTS,` +
    `afade=t=in:st=0:d=${FADE_IN_S},afade=t=out:st=${fadeOutAt}:d=${FADE_OUT_S},` +
    `volume=${gain}[bed];`;
  const graph = input.duck
    ? `[1:a]asplit=2[voice][key];${bed}[bed][key]sidechaincompress=${DUCK}[ducked];` +
      `[voice][ducked]amix=inputs=2:duration=first:normalize=0[out]`
    : `${bed}[1:a][bed]amix=inputs=2:duration=first:normalize=0[out]`;

  const out = run.mediaPath(MIXED);
  const tmp = `${out}.tmp.wav`;
  const res = await (deps.run ?? runProcess)(deps.ffmpeg ?? process.env.FFMPEG_PATH ?? 'ffmpeg', [
    '-y', '-loglevel', 'error',
    '-stream_loop', '-1', '-i', track,
    '-i', voice,
    '-filter_complex', graph,
    '-map', '[out]',
    tmp,
  ]);
  if (res.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
    fs.rmSync(tmp, { force: true });
    throw new BackingRefused(`the mix failed: ${res.stderr.slice(0, 200) || `ffmpeg exited ${res.code}`}`);
  }
  fs.renameSync(tmp, out);

  const mix: Mix = {
    track: path.basename(track, '.mp3'),
    volume: input.volume,
    duck: input.duck,
    ...voiceSignature(voice),
    mixedAt: new Date().toISOString(),
  };
  fs.writeFileSync(recordPath(run), JSON.stringify(mix, null, 2));
  return mix;
};

/** Back to voice only. */
export const clearMix = (run: Run): void => {
  fs.rmSync(run.mediaPath(MIXED), { force: true });
  fs.rmSync(recordPath(run), { force: true });
};
