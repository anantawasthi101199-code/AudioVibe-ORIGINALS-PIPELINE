/**
 * Archive a run the moment it is published, rather than waiting for the sweep.
 *
 * NOT AWAITED BY THE PUBLISH. A publish is done when the platform has the
 * episode; moving the files afterwards is housekeeping, and a failure here is
 * retried by the sweep (archive/r2.ts) rather than shown as a failed publish.
 */
import { archiveRun, r2Store } from '../archive/r2';
import { Run } from '../run/store';
import { audioDownloadFile } from './routes';

/** The download MP3, made while the audio is still here. */
export const archiveDownload = async (run: Run): Promise<string | null> => {
  try {
    return await audioDownloadFile(run.id);
  } catch {
    return null;
  }
};

export const archiveSoon = (run: Run): void => {
  const store = r2Store();
  if (!store) return;
  void archiveRun(run, { store, makeDownload: archiveDownload })
    .then((record) => {
      if (record) console.log(`  archived ${run.id} to R2`);
    })
    .catch((e: Error) => console.log(`  archive of ${run.id} will be retried: ${e.message}`));
};
