/**
 * What the studio's players play: a compressed copy, not the master WAV
 * (2026-10-06).
 *
 * A 23-minute episode is a 134MB WAV, and a page with a player on it streamed
 * that into the browser (twice, with a music mix beside it), so a long episode
 * made the studio crawl. The players get a 128kbps MP3 instead, about a sixth
 * of the size, made once on first play and reused until the WAV changes.
 * Downloading and publishing still use the full-quality files.
 */
import fs from 'fs';
import { runProcess } from '../render/assemble';
import { archivedOwner } from '../archive/record';

/** One encode per file at a time, however many requests ask for it at once. */
const encoding = new Map<string, Promise<string>>();

export const playbackFile = async (wav: string): Promise<string> => {
  if (!wav.endsWith('.wav')) return wav;
  const out = wav.replace(/\.wav$/, '.play.mp3');
  // ARCHIVED TO R2: its compressed copy went too, when there was one.
  if (!fs.existsSync(wav)) return archivedOwner(out) ? out : wav;

  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(wav).mtimeMs) return out;

  const pending = encoding.get(wav);
  if (pending) return pending;

  const job = (async () => {
    const tmp = `${out}.${Date.now()}.part.mp3`;
    const res = await runProcess(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      '-y', '-loglevel', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '128k', tmp,
    ]);
    if (res.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
      fs.rmSync(tmp, { force: true });
      return wav; // A failed encode still plays: just the big way.
    }
    fs.renameSync(tmp, out);
    return out;
  })().finally(() => encoding.delete(wav));
  encoding.set(wav, job);
  return job;
};
