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
//
// TWO SLOTS, BECAUSE TRYING IS NOT DECIDING. `preview` is the last mix made,
// there to listen to and nothing else. `chosen` is the one somebody pressed
// "use this version" on, and it is the only thing publishing reads. Mixing
// again replaces the preview and leaves the choice alone, so experimenting can
// never change what goes out.

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
  /**
   * The mixed file's name in media/. A NEW NAME FOR EVERY MIX, because on
   * Windows a file cannot be replaced while anything holds it open - and the
   * studio's player holds a mix open while it streams.
   */
  file: z.string().default('episode.mixed.wav'),
});

export type Mix = z.infer<typeof mixSchema>;

const recordSchema = z.object({
  preview: mixSchema.nullable().default(null),
  chosen: mixSchema.nullable().default(null),
});

type MixRecord = z.infer<typeof recordSchema>;

const FADE_IN_S = 3;
const FADE_OUT_S = 4;

const voiceSignature = (file: string) => {
  const st = fs.statSync(file);
  return { voiceBytes: st.size, voiceMtimeMs: Math.round(st.mtimeMs) };
};

export interface MixState {
  /** The last mix made, to listen to. Never published by itself. */
  preview: Mix | null;
  /** The mix that publishing sends. Null means the voice alone. */
  chosen: Mix | null;
  /** Made from a voice file that has since been re-rendered. */
  previewStale: boolean;
  chosenStale: boolean;
}

// Its own small file beside the audio, not a pipeline artifact: mixing is not a
// stage, and a resume must never think it has one to redo.
const recordPath = (run: Run): string => run.mediaPath('mix.json');

const readRecord = (run: Run): MixRecord => {
  const file = recordPath(run);
  if (!fs.existsSync(file)) return { preview: null, chosen: null };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (raw && typeof raw === 'object' && ('preview' in raw || 'chosen' in raw)) {
    const both = recordSchema.safeParse(raw);
    if (both.success) return both.data;
  }
  // The first version kept one flat mix, which publishing used without being
  // asked. It is read as a preview: nothing goes out until somebody chooses.
  const flat = mixSchema.safeParse(raw);
  return { preview: flat.success ? flat.data : null, chosen: null };
};

/** Every mixed file this run has ever had: the current ones and leftovers. */
const isMixedFile = (name: string): boolean => /^episode\.mixed.*\.wav$/.test(name);

/**
 * Delete every mixed file not in `keep`, quietly skipping any still open.
 *
 * A file the player is streaming cannot be deleted on Windows (EPERM/EBUSY).
 * It is harmless to leave: it is not recorded, and the next change tries again.
 */
const sweepMixes = (run: Run, keep: Array<string | undefined>): void => {
  const dir = path.dirname(recordPath(run));
  for (const name of fs.readdirSync(dir)) {
    if (!isMixedFile(name) || keep.includes(name)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // Still open somewhere. Next time.
    }
  }
};

const writeRecord = (run: Run, record: MixRecord): void => {
  if (!record.preview && !record.chosen) fs.rmSync(recordPath(run), { force: true });
  else fs.writeFileSync(recordPath(run), JSON.stringify(record, null, 2));
  sweepMixes(run, [record.preview?.file, record.chosen?.file]);
};

const isStale = (run: Run, mix: Mix | null): boolean => {
  if (!mix) return false;
  const voice = run.audioFile();
  if (!voice || !fs.existsSync(run.mediaPath(mix.file))) return true;
  const now = voiceSignature(voice);
  return now.voiceBytes !== mix.voiceBytes || now.voiceMtimeMs !== mix.voiceMtimeMs;
};

export const mixState = (run: Run): MixState => {
  const { preview, chosen } = readRecord(run);
  return { preview, chosen, previewStale: isStale(run, preview), chosenStale: isStale(run, chosen) };
};

/**
 * The file to publish: the CHOSEN mix, when it still matches the voice.
 * Otherwise null, and the voice goes out alone.
 */
export const mixedAudioFor = (run: Run): string | null => {
  const { chosen } = readRecord(run);
  return chosen && !isStale(run, chosen) ? run.mediaPath(chosen.file) : null;
};

/** A mix's file, for the player: the preview or the chosen version. */
export const mixedFileFor = (run: Run, which: 'preview' | 'chosen' = 'preview'): string | null => {
  const mix = readRecord(run)[which];
  if (!mix) return null;
  const file = run.mediaPath(mix.file);
  return fs.existsSync(file) ? file : null;
};

export interface MixDeps {
  run?: typeof runProcess;
  ffmpeg?: string;
  probe?: (file: string) => Promise<number | null>;
}

/**
 * Mix a library track under the episode's voice, as a PREVIEW.
 *
 * The track loops if it is shorter than the episode and is cut if longer,
 * with a fade at each end. Ducking, when on, is the same sidechain the
 * synthesised bed uses, so speech always wins. Nothing here changes what
 * publishes; see chooseMix.
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

  // Written straight to a fresh name: nothing to rename over, so nothing an
  // open player can block.
  const name = `episode.mixed-${Date.now()}.wav`;
  const out = run.mediaPath(name);
  const res = await (deps.run ?? runProcess)(deps.ffmpeg ?? process.env.FFMPEG_PATH ?? 'ffmpeg', [
    '-y', '-loglevel', 'error',
    '-stream_loop', '-1', '-i', track,
    '-i', voice,
    '-filter_complex', graph,
    '-map', '[out]',
    out,
  ]);
  if (res.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size === 0) {
    try {
      fs.rmSync(out, { force: true });
    } catch {
      // Left for the next sweep.
    }
    throw new BackingRefused(`the mix failed: ${res.stderr.slice(0, 200) || `ffmpeg exited ${res.code}`}`);
  }

  const mix: Mix = {
    track: path.basename(track, '.mp3'),
    volume: input.volume,
    duck: input.duck,
    ...voiceSignature(voice),
    mixedAt: new Date().toISOString(),
    file: name,
  };
  writeRecord(run, { ...readRecord(run), preview: mix });
  return mix;
};

/** "Use this version": the preview becomes what publishing sends. */
export const chooseMix = (run: Run): Mix => {
  const record = readRecord(run);
  if (!record.preview) throw new BackingRefused('there is no mix to use yet. Mix one first.');
  if (isStale(run, record.preview)) {
    throw new BackingRefused('the episode was voiced again after this mix. Mix again, then use it.');
  }
  writeRecord(run, { ...record, chosen: record.preview });
  return record.preview;
};

/** Publish the voice alone again. The preview stays to listen to. */
export const unchooseMix = (run: Run): void => {
  writeRecord(run, { ...readRecord(run), chosen: null });
};

/** Back to nothing at all: no preview, voice only. */
export const clearMix = (run: Run): void => {
  writeRecord(run, { preview: null, chosen: null });
};
