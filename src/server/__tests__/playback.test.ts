import fs from 'fs';
import os from 'os';
import path from 'path';
import { runProcess } from '../../render/assemble';
import { playbackFile } from '../playback';

/** Real ffmpeg: a one-second WAV becomes a small MP3, made once and reused. */
describe('what the players play', () => {
  it('is a compressed copy of the WAV, reused until the WAV changes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-'));
    const wav = path.join(dir, 'episode.wav');
    await runProcess(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', wav,
    ]);
    const out = await playbackFile(wav);
    expect(out.endsWith('.play.mp3')).toBe(true);
    expect(fs.statSync(out).size).toBeLessThan(fs.statSync(wav).size);
    const made = fs.statSync(out).mtimeMs;
    expect(await playbackFile(wav)).toBe(out);
    expect(fs.statSync(out).mtimeMs).toBe(made);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it('leaves anything that is not a WAV alone', async () => {
    expect(await playbackFile('/x/episode.mp3')).toBe('/x/episode.mp3');
  });
});
