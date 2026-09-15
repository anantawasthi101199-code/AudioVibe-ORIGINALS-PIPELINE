/**
 * Taking something back off the platform, and forgetting it was ever there.
 *
 * WHY THIS EXISTS AT ALL, given that publishing is meant to be the
 * irreversible act. Because the first few episodes of a new channel are not
 * really publishing, they are looking at the result - and the first one out
 * showed a cover composed for a letterbox on a square tile. Without a way to
 * take it back, the only options are to leave a bad card in the catalogue
 * forever or to wipe the database, which would take the account, its artwork
 * and the credential with it.
 *
 * IT DELETES AS THE CHANNEL, through the endpoint a creator uses on their own
 * work. There is no admin path here and there should not be: a studio that can
 * delete anything is a different and much more dangerous thing than one that
 * can delete its own.
 *
 * IT FORGETS LOCALLY TOO. A run whose publish artifact stays behind reads as
 * published forever - it would sit in the calendar as a tick on a day nothing
 * happened, and refuse to be published again. So the artifact goes, the stage
 * is uncompleted, and the run comes back to the state it was in the moment
 * before: gated, approved, waiting.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { loadPersona } from '../canon/load';
import { platformUrl } from '../config';
import { Run } from '../run/store';
import { AccountError, PlatformAccounts, loadAccounts } from './account';

export interface UnpublishResult {
  runId: string;
  audioId: string;
  /** Whether the platform actually had it. A 404 is a success here. */
  removed: boolean;
  note?: string;
}

const publishArtifactSchema = z
  .object({ audioId: z.string(), publishedAt: z.string().optional() })
  .passthrough();

/**
 * Delete one published run from the platform and reset it here.
 *
 * A 404 FROM THE PLATFORM IS NOT A FAILURE. It means the thing is already
 * gone - deleted by hand in the app, say - and the only work left is the local
 * forgetting, which is exactly what this is for.
 */
export const unpublish = async (
  runId: string,
  deps: { accounts?: PlatformAccounts; log?: (message: string) => void } = {}
): Promise<UnpublishResult> => {
  const log = deps.log ?? (() => undefined);
  const run = Run.open(runId);
  const persona = loadPersona(run.manifest.personaId);

  if (!run.isComplete('publish') || !run.hasArtifact('publish')) {
    throw new Error(`${runId} is not published, so there is nothing to take back`);
  }

  const { audioId } = run.readArtifact('publish', publishArtifactSchema);

  const account = loadAccounts()[persona.id];
  if (!account) {
    throw new Error(
      `no account recorded for ${persona.name}, so this studio cannot sign in as it to delete`
    );
  }

  const platform = platformUrl();
  const api = deps.accounts ?? new PlatformAccounts(platform.url);

  log(`signing in as @${account.username}`);
  await api.signInAsChannel(account.email, account.password);

  let removed = true;
  let note: string | undefined;

  try {
    log(`deleting ${audioId} from ${platform.url}`);
    await api.deleteAudio(audioId);
  } catch (err) {
    if (err instanceof AccountError && err.status === 404) {
      removed = false;
      note = 'the platform had already lost it; only this studio still thought it was published';
    } else {
      throw err;
    }
  }

  // FORGOTTEN HERE ONLY AFTER THE PLATFORM AGREES. The other order would leave
  // a run that looks publishable and an audio still live, and publishing it
  // again would put the same episode out twice.
  fs.rmSync(path.join(run.dir, 'publish.json'), { force: true });
  run.uncomplete('publish');
  run.journal({ stage: 'publish', event: `unpublished ${audioId}` });

  log('this run is publishable again');
  return { runId, audioId, removed, note };
};
