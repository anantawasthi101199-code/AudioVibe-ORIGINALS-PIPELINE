/**
 * Re-voicing something that is already live, and swapping it in.
 *
 * WHY (owner, 2026-10-10). The first uploads on every channel were voiced on
 * GPT, before the channels had ElevenLabs voices. The owner wants them out
 * again in the channel's real voice with everything else exactly as it is:
 * title, description, script, picture, series.
 *
 * THE PLATFORM CANNOT SWAP AUDIO IN PLACE: a channel can edit a live audio's
 * title and description and nothing else. So a re-voiced piece goes out as a
 * NEW audio and the old one is deleted. Plays, likes and comments stay with
 * the old one and go when it goes; the owner accepted that.
 *
 * TWO STEPS, AND THE OLD ONE STAYS LIVE BETWEEN THEM.
 *   1. prepareRevoice: the run forgets it was published (so it can be voiced
 *      and published again), remembers WHICH audio it replaces in
 *      replaces.json, switches engine and is tagged. Nothing on the platform
 *      changes.
 *   2. publishRun publishes the new audio and THEN calls retireReplaced, which
 *      deletes the old one. That order means the channel is never missing the
 *      piece: the worst case is a duplicate for a few seconds, or, if the
 *      delete fails, a duplicate somebody removes with `revoice --retire-old`.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { loadPersona } from '../canon/load';
import { platformUrl } from '../config';
import { Run } from '../run/store';
import { AccountError, PlatformAccounts, loadAccounts } from './account';

const REPLACES = 'replaces.json';
const REPLACED = 'replaced.json';

const replacesSchema = z
  .object({
    audioId: z.string().min(1),
    publishedAt: z.string().optional(),
    preparedAt: z.string(),
    previousEngine: z.string().optional(),
  })
  .passthrough();

export type Replaces = z.infer<typeof replacesSchema>;

/** The live audio this run will replace when it is published, or null. */
export const replacedAudio = (run: Run): Replaces | null => {
  const file = path.join(run.dir, REPLACES);
  return fs.existsSync(file) ? replacesSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) : null;
};

/**
 * Step 1. Make a published run voiceable again on `engine`, leaving its live
 * audio untouched until the new one is published.
 */
export const prepareRevoice = (
  run: Run,
  opts: { tag: string; engine?: 'openai' | 'elevenlabs'; who?: string | null }
): Replaces => {
  const engine = opts.engine ?? 'elevenlabs';
  if (replacedAudio(run)) throw new Error(`${run.id} is already waiting to replace its live audio`);
  if (!run.isComplete('publish') || !run.hasArtifact('publish')) {
    throw new Error(`${run.id} is not published, so there is nothing to re-voice and replace`);
  }

  const publishFile = path.join(run.dir, 'publish.json');
  const published = JSON.parse(fs.readFileSync(publishFile, 'utf8')) as Record<string, unknown>;
  if (typeof published.audioId !== 'string') throw new Error(`${run.id} has no audio id in publish.json`);

  const record: Replaces = {
    ...published,
    audioId: published.audioId,
    preparedAt: new Date().toISOString(),
    previousEngine: run.manifest.voiceEngine,
  };
  // Written BEFORE publish.json goes, so there is no moment at which the run
  // has forgotten its live audio entirely.
  fs.writeFileSync(path.join(run.dir, REPLACES), JSON.stringify(record, null, 2));
  fs.rmSync(publishFile, { force: true });
  run.uncomplete('publish');

  // The other engine's beats and the finished render go, exactly as switching
  // engine on the run page does: one episode never mixes two voices.
  const media = path.join(run.dir, 'media');
  if (fs.existsSync(media)) {
    for (const name of fs.readdirSync(media)) {
      if (/^\d{2}-.+\.mp3$/.test(name)) fs.rmSync(path.join(media, name), { force: true });
    }
  }
  fs.rmSync(path.join(run.dir, 'render.json'), { force: true });
  run.uncomplete('render');
  run.uncomplete('qa');
  // A whole voicing's room on the budget, as the studio's Regenerate gives.
  run.noteRegeneration();

  run.setVoiceEngine(engine);
  run.setTag(opts.tag);
  run.journal({
    stage: 'publish',
    event: `prepared to re-voice on ${engine} and replace ${record.audioId}${opts.who ? ` (${opts.who})` : ''}`,
    detail: `tag "${opts.tag}"; the old audio stays live until the new one is published`,
  });
  return record;
};

/**
 * Step 2, after the new audio is published: delete the old one as the channel.
 * A 404 means it is already gone, which is fine. Returns null when the run
 * replaces nothing.
 */
export const retireReplaced = async (
  run: Run,
  deps: { accounts?: PlatformAccounts; log?: (m: string) => void } = {}
): Promise<{ audioId: string; removed: boolean } | null> => {
  const old = replacedAudio(run);
  if (!old) return null;
  const log = deps.log ?? (() => undefined);

  const persona = loadPersona(run.manifest.personaId);
  const account = loadAccounts()[persona.id];
  if (!account) throw new Error(`no account recorded for ${persona.name}, so the old audio cannot be deleted`);

  const api = deps.accounts ?? new PlatformAccounts(platformUrl().url);
  await api.signInAsChannel(account.email, account.password);

  let removed = true;
  try {
    log(`deleting the old audio ${old.audioId}`);
    await api.deleteAudio(old.audioId);
  } catch (err) {
    if (!(err instanceof AccountError && err.status === 404)) throw err;
    removed = false;
  }

  // Kept, not deleted: "which audio did this replace" is a question somebody
  // asks later.
  fs.writeFileSync(
    path.join(run.dir, REPLACED),
    JSON.stringify({ ...old, retiredAt: new Date().toISOString(), removed }, null, 2)
  );
  fs.rmSync(path.join(run.dir, REPLACES), { force: true });
  run.journal({ stage: 'publish', event: `deleted the old audio ${old.audioId}`, detail: removed ? undefined : 'it was already gone' });
  return { audioId: old.audioId, removed };
};
