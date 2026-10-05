/**
 * What a run's archive.json says: that the run is in R2, and where its final
 * audio is now that the server's copy has been removed.
 *
 * READ BY THE FEW PLACES THAT LOOK AT A RUN'S AUDIO (store.audioFile,
 * backing.finalAudioFor, the download and the file server), so an archived run
 * still plays, downloads and shows as having audio. Kept dependency-free, so
 * run/store.ts can read it without importing the archive machinery.
 */
import fs from 'fs';
import path from 'path';

export interface ArchiveRecord {
  archivedAt: string;
  bucket: string;
  /**
   * Where its files are in R2, e.g. runs/root-health/e001-.... Recorded so a
   * run renamed after archiving (shorts became s001, 2026-10-05) still finds
   * them. Absent on records written before this: runs/<current id>.
   */
  prefix?: string;
  /** Every file uploaded, path inside the run folder -> bytes. */
  files: Record<string, number>;
  /** What the final-audio code would have said, frozen at archive time. */
  final: { file: string; key: string; music: { track: string; volume: number } | null; speed: number } | null;
  /** The MP3 a download hands out, made before the audio was removed. */
  download: string | null;
  /** The files removed from the server after R2 confirmed them. */
  removed: string[];
}

export const ARCHIVE_FILE = 'archive.json';

export const readArchive = (runDir: string): ArchiveRecord | null => {
  const file = path.join(runDir, ARCHIVE_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ArchiveRecord;
  } catch {
    return null;
  }
};

/** The run folder a file is in, when it is inside one that has been archived. */
export const archivedOwner = (file: string): { runDir: string; rel: string; record: ArchiveRecord } | null => {
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 6; i += 1) {
    const record = readArchive(dir);
    if (record) {
      const rel = path.relative(dir, path.resolve(file)).split(path.sep).join('/');
      return record.files[rel] !== undefined ? { runDir: dir, rel, record } : null;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
};
