/**
 * Which voice each channel speaks in, recorded the first time it is used.
 *
 * WHY THIS HAS TO BE WRITTEN DOWN. A listener finds a show by its voice long
 * before they read its name. Change the voice at episode twelve and the show
 * has quietly become a different show to everybody who was following it - and
 * the archive behind it is now a different person reading the same words.
 *
 * The persona file already holds a voice id, and a comment telling whoever
 * edits it never to change it. A comment is not a guarantee: it is one careless
 * edit, one experiment somebody forgot to undo, one merge. The way you find out
 * is a published episode in the wrong voice, and by then it is public.
 *
 * SO THE FIRST USE IS THE COMMITMENT. The first time a channel renders audio,
 * the voice it used is written here, and from then on a mismatch stops the run
 * before a single call is made. Changing it deliberately is a two-step thing
 * somebody has to mean: edit the persona AND retire the recorded voice.
 *
 * COMMITTED TO THE REPO, like the series registry and for the same reason. This
 * is not derived state that a re-run would reproduce - it is a fact about what
 * listeners have already heard, and losing it cannot be recovered from anything
 * else in the repo.
 *
 * KEYED BY PROVIDER TOO. A show drafted on OpenAI and published on Eleven
 * legitimately has two voices, and they are not interchangeable - "fable" means
 * nothing to Eleven and a twenty-character Eleven id means nothing to OpenAI.
 * What must not drift is the voice a given provider uses for a given host.
 */
import fs from 'fs';
import { z } from 'zod';
import { voicesFile } from '../config';
import { Persona } from './schema';

export const voiceRecordSchema = z.object({
  provider: z.string().min(1),
  voiceId: z.string().min(1),
  /** When this channel first spoke in this voice. */
  firstUsedAt: z.string().datetime(),
  /** The run that did it, so the first episode in this voice is findable. */
  firstRunId: z.string().min(1),
});

export type VoiceRecord = z.infer<typeof voiceRecordSchema>;

/** personaId -> hostId -> provider -> record. */
export const voiceRegistrySchema = z.record(z.record(z.record(voiceRecordSchema)));

export type VoiceRegistry = z.infer<typeof voiceRegistrySchema>;

export class VoiceChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceChangedError';
  }
}

export const voiceRegistryPath = (): string => voicesFile();

export const loadVoiceRegistry = (file = voiceRegistryPath()): VoiceRegistry => {
  if (!fs.existsSync(file)) return {};
  return voiceRegistrySchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
};

export const saveVoiceRegistry = (registry: VoiceRegistry, file = voiceRegistryPath()): void => {
  fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
};

/** The voice a host will actually speak in, for the provider in use. */
export const voiceFor = (
  persona: Persona,
  hostId: string,
  provider: string
): { provider: string; voiceId: string } | null => {
  const host = persona.hosts.find((h) => h.id === hostId);
  if (!host) return null;

  // A draft provider has its own id on the same host. Absent means this show
  // cannot be drafted, which is a clear failure rather than a substitution.
  const voiceId = provider === host.voice.provider ? host.voice.voiceId : host.voice.draftVoiceId;
  return voiceId ? { provider, voiceId } : null;
};

/**
 * Every host whose persona now disagrees with what listeners have heard.
 *
 * Returns problems rather than throwing, so a caller can report all of them at
 * once. A show with two hosts that swapped both voices should say so in one
 * message rather than one per run.
 */
export const voiceChanges = (
  persona: Persona,
  provider: string,
  registry: VoiceRegistry
): string[] => {
  const problems: string[] = [];
  const recorded = registry[persona.id] ?? {};

  for (const host of persona.hosts) {
    const now = voiceFor(persona, host.id, provider);
    if (!now) continue;

    const before = recorded[host.id]?.[provider];
    if (!before) continue;

    if (before.voiceId !== now.voiceId) {
      problems.push(
        `${persona.name}: ${host.name} has spoken as "${before.voiceId}" on ${provider} ` +
          `since ${before.firstUsedAt.slice(0, 10)} (${before.firstRunId}), and the persona ` +
          `now says "${now.voiceId}". A listener finds a show by its voice, so this is a ` +
          `different show to everybody following it.`
      );
    }
  }

  return problems;
};

/**
 * Refuse to run when a channel's voice has changed under it.
 *
 * CALLED BEFORE ANY MODEL CALL, because the alternative is finding out after
 * paying for research, a script and audio. The message says how to do it on
 * purpose, because sometimes it IS on purpose and an error that only forbids is
 * an error somebody works around by deleting the file.
 */
export const assertVoiceUnchanged = (
  persona: Persona,
  provider: string,
  registry: VoiceRegistry
): void => {
  const problems = voiceChanges(persona, provider, registry);
  if (!problems.length) return;

  throw new VoiceChangedError(
    `${problems.join('\n')}\n\n` +
      `If the change is deliberate, retire the old voice first:\n` +
      `  npm run foundry -- voice-retire --show ${persona.id}\n` +
      `which records that the voice changed and when, so the archive stays explainable.`
  );
};

/**
 * Write down the voice a channel just used, the first time it uses one.
 *
 * Idempotent and never overwrites: the first use is the commitment, and a later
 * run cannot quietly re-point it. Returns what it recorded so a caller can say
 * so out loud, because the first episode of a show is exactly when somebody
 * wants to know the voice has been pinned.
 */
export const recordVoices = (
  persona: Persona,
  provider: string,
  runId: string,
  registry: VoiceRegistry,
  now = new Date()
): { registry: VoiceRegistry; recorded: Array<{ hostId: string; voiceId: string }> } => {
  // A FAKE PROVIDER IS NOT A COMMITMENT AND MUST NEVER ENTER THE REGISTRY.
  //
  // This file is committed, and the whole point of it is that it is the record
  // of which real voice a show is pinned to forever. A stand-in used by a test
  // or a smoke run is the opposite of that: it names a voice nobody bought, on
  // a provider that does not exist, and it pins the show to it.
  //
  // It has happened twice. The first time the test suite wrote "fake-tts" into
  // the real file, which is why config/index.ts made the path configurable; the
  // second time a manual run did it, which no amount of test isolation would
  // have stopped. Refusing the name here is the fix that covers both, because
  // it lives with the invariant rather than with one of the callers.
  if (provider.startsWith('fake')) return { registry, recorded: [] };

  const next: VoiceRegistry = { ...registry, [persona.id]: { ...(registry[persona.id] ?? {}) } };
  const recorded: Array<{ hostId: string; voiceId: string }> = [];

  for (const host of persona.hosts) {
    const voice = voiceFor(persona, host.id, provider);
    if (!voice) continue;

    // A placeholder is not a commitment. Recording it would pin the show to a
    // string that exists to be replaced.
    if (voice.voiceId.startsWith('REPLACE_')) continue;

    const forHost = { ...(next[persona.id]![host.id] ?? {}) };
    if (forHost[provider]) continue;

    forHost[provider] = {
      provider,
      voiceId: voice.voiceId,
      firstUsedAt: now.toISOString(),
      firstRunId: runId,
    };
    next[persona.id]![host.id] = forHost;
    recorded.push({ hostId: host.id, voiceId: voice.voiceId });
  }

  return { registry: next, recorded };
};

/**
 * Forget a channel's recorded voice, so a new one may be committed.
 *
 * The deliberate path out. Kept separate from `recordVoices` so that changing a
 * show's voice is always two decisions rather than a side effect of editing a
 * persona file.
 */
export const retireVoices = (
  personaId: string,
  registry: VoiceRegistry,
  provider?: string
): VoiceRegistry => {
  const forShow = registry[personaId];
  if (!forShow) return registry;

  if (!provider) {
    const next = { ...registry };
    delete next[personaId];
    return next;
  }

  const nextShow: VoiceRegistry[string] = {};
  for (const [hostId, byProvider] of Object.entries(forShow)) {
    const kept = { ...byProvider };
    delete kept[provider];
    if (Object.keys(kept).length) nextShow[hostId] = kept;
  }

  const next = { ...registry };
  if (Object.keys(nextShow).length) next[personaId] = nextShow;
  else delete next[personaId];
  return next;
};
