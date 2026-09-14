/**
 * The studio as something you can navigate: lanes, then channels, then work.
 *
 * WHY THIS IS NOT JUST "LIST THE PERSONAS". A show is not the top of the tree.
 * What decides how an episode is made is the LANE - whether truth comes from
 * documents or from a series bible - and that decision is worth weeks, while a
 * show is worth an hour. Putting lanes first in the interface puts the
 * expensive decision where it belongs and stops a new show being created
 * without anybody choosing how it will be checked.
 *
 * THE TWO ROUTES OUT OF A CHANNEL are the other thing this exists to make
 * plain. A channel can make an EPISODE, or it can make a SET OF SHORTS, and
 * they are genuinely different: one produces a thing to publish, the other
 * produces a script that is never published and is cut into ten things that
 * are. Everything downstream - what it costs, what gets approved, what gets
 * rendered - follows from that fork, so the interface asks it directly rather
 * than hiding it behind a format dropdown.
 *
 * Read-only and derived. Nothing here is stored; it is the persona files, the
 * beat sheets and the runs directory, arranged.
 */
import { z } from 'zod';
import { loadAllPersonas, loadPersona } from '../canon/load';
import { Persona } from '../canon/schema';
import { loadFormat } from '../formats/load';
import { EpisodeFormat, minClaimsFor, nominalSeconds } from '../formats/schema';
import { loadTopics } from '../schedule/load';
import { Run } from '../run/store';
import { loadVoiceRegistry } from '../canon/voiceRegistry';

export interface LaneSummary {
  id: 'factual' | 'fiction';
  name: string;
  /** One sentence on where truth comes from, which is what a lane decides. */
  basis: string;
  channels: ChannelSummary[];
}

export interface RouteSummary {
  /** `episode` makes one thing to publish; `shorts` makes ten. */
  kind: 'episode' | 'shorts';
  formatId: string;
  formatName: string;
  intent: string;
  /** How long the thing a listener meets is, in seconds. */
  seconds: [number, number];
  /** How many separate publishable items one run of this produces. */
  produces: number;
  minClaims: number;
  beats: number;
}

export interface ChannelSummary {
  id: string;
  name: string;
  handle: string;
  category: string;
  thesis: string;
  fiction: boolean;
  /** The one voice this channel is committed to, or null before first use. */
  voice: { provider: string; voiceId: string; since: string } | null;
  routes: RouteSummary[];
  /** Queued subjects, for the two queues a channel can have. */
  queued: { topics: number; sets: number };
  runs: { total: number; awaitingApproval: number; lastAt: string | null };
}

const routesFor = (persona: Persona): RouteSummary[] =>
  persona.formats
    .map((id) => {
      let format: EpisodeFormat;
      try {
        format = loadFormat(id);
      } catch {
        // A persona naming a beat sheet that is not there should not take the
        // whole catalogue down; it should be visibly missing from one channel.
        return null;
      }

      // A SOURCE FORMAT IS THE SHORTS ROUTE. It is the only format whose run
      // produces nothing publishable on its own, and the only one where the
      // thing a listener meets is a beat rather than the episode.
      const isShorts = format.sourceOnly;
      const unit = isShorts ? format.beats[0] : undefined;

      return {
        kind: isShorts ? ('shorts' as const) : ('episode' as const),
        formatId: format.id,
        formatName: format.name,
        intent: format.intent.trim().replace(/\s+/g, ' '),
        seconds: (unit?.seconds ?? format.targetSeconds) as [number, number],
        produces: isShorts ? format.beats.length : 1,
        minClaims: isShorts ? (unit?.minClaims ?? 0) : minClaimsFor(format),
        beats: format.beats.length,
      };
    })
    .filter((r): r is RouteSummary => r !== null);

const runsFor = (channelId: string): ChannelSummary['runs'] => {
  const ids = Run.list().filter((id) => id.startsWith(`${channelId}/`));
  let awaiting = 0;
  let lastAt: string | null = null;

  for (const id of ids) {
    try {
      const run = Run.open(id);
      if (run.awaitingApproval) awaiting++;
      const at = run.manifest.createdAt;
      if (!lastAt || at > lastAt) lastAt = at;
    } catch {
      // A half-written run directory is not a reason to fail the listing.
    }
  }

  return { total: ids.length, awaitingApproval: awaiting, lastAt };
};

export const channelSummary = (persona: Persona): ChannelSummary => {
  const queue = loadTopics(persona.id);
  // THE VOICE THIS CHANNEL IS COMMITTED TO, read from the registry rather than
  // from the persona. The persona says what it WOULD use; the registry says
  // what it has actually spoken in, which is the thing a listener would notice
  // changing and the thing the interface should show.
  const host = persona.hosts[0];
  const committed = host
    ? (loadVoiceRegistry()[persona.id]?.[host.id]?.[host.voice.provider] ?? null)
    : null;

  return {
    id: persona.id,
    name: persona.name,
    handle: persona.handle,
    category: persona.category,
    thesis: persona.thesis.trim().replace(/\s+/g, ' '),
    fiction: persona.fiction,
    voice: committed
      ? { provider: committed.provider, voiceId: committed.voiceId, since: committed.firstUsedAt }
      : null,
    routes: routesFor(persona),
    queued: { topics: queue.topics.length, sets: queue.sets.length },
    runs: runsFor(persona.id),
  };
};

/**
 * Every lane, with its channels under it.
 *
 * A lane with no channels is still listed. An empty lane is a fact worth seeing
 * - it is how you notice the fiction pipeline has never been used - and hiding
 * it would make the interface quietly describe a smaller studio than exists.
 */
export const catalogue = (): LaneSummary[] => {
  const personas = loadAllPersonas();

  const lanes: LaneSummary[] = [
    {
      id: 'factual',
      name: 'Factual',
      basis:
        'Every assertion binds to a verbatim quote from a document that was fetched, ' +
        'and is checked by a different model family than wrote it.',
      channels: [],
    },
    {
      id: 'fiction',
      name: 'Fiction',
      basis:
        'No research at all, because no document entails an invented scene. Continuity ' +
        'against a series bible replaces the evidence ledger.',
      channels: [],
    },
  ];

  for (const persona of personas) {
    const lane = lanes.find((l) => (persona.fiction ? l.id === 'fiction' : l.id === 'factual'))!;
    lane.channels.push(channelSummary(persona));
  }

  for (const lane of lanes) lane.channels.sort((a, b) => a.name.localeCompare(b.name));
  return lanes;
};

/** One channel, or null when the id is not a show. */
export const channel = (id: string): ChannelSummary | null => {
  try {
    return channelSummary(loadPersona(id));
  } catch {
    return null;
  }
};

export interface RunSummary {
  id: string;
  channelId: string;
  channelName: string;
  formatId: string;
  topic: string;
  title: string | null;
  createdAt: string;
  spentPence: number;
  completed: string[];
  /** Where the run is, in the words the interface uses. */
  state: 'running' | 'awaiting-approval' | 'ready' | 'failed' | 'published' | 'abandoned';
  episode: number;
  short: number | null;
  story: number | null;
  derivedFrom: string | null;
  durationS: number | null;
  gate: { passed: boolean; blocking: number; needsHumanReview: boolean } | null;
}

/**
 * What state a run is in, which is the one thing a list of runs must get right.
 *
 * Derived from what is on disk rather than stored, because a stored status is a
 * second source of truth that goes stale the moment a process dies between
 * writing an artifact and updating a field.
 */
export const runSummary = (run: Run, liveIds: ReadonlySet<string> = new Set()): RunSummary => {
  const m = run.manifest;

  // LOOSE SCHEMAS ON PURPOSE. A listing wants the title, the duration and
  // whether the gate passed; it does not want to fail because some other field
  // of an artifact written by an older version no longer parses. Every one of
  // these is wrapped, so an unreadable artifact costs a column rather than a
  // page.
  // The three-parameter form, for the reason readArtifact spells out: with a
  // bare z.ZodType<T> the compiler unifies T with the schema's INPUT type, so
  // every `.default()` comes back optional and nothing downstream can rely on
  // it having been applied.
  const read = <T>(
    stage: Parameters<Run['hasArtifact']>[0],
    schema: z.ZodType<T, z.ZodTypeDef, unknown>
  ): T | null => {
    try {
      return run.hasArtifact(stage) ? run.readArtifact(stage, schema) : null;
    } catch {
      return null;
    }
  };

  const title = read('script', z.object({ title: z.string() }).passthrough())?.title ?? null;
  const durationS = read('render', z.object({ durationS: z.number() }).passthrough())?.durationS ?? null;

  const report = read(
    'qa',
    z
      .object({
        passed: z.boolean(),
        needsHumanReview: z.boolean().default(false),
        findings: z.array(z.object({ blocking: z.boolean() }).passthrough()).default([]),
      })
      .passthrough()
  );

  const gate: RunSummary['gate'] = report
    ? {
        passed: report.passed,
        blocking: report.findings.filter((f) => f.blocking).length,
        needsHumanReview: report.needsHumanReview,
      }
    : null;

  const state: RunSummary['state'] = m.abandoned
    ? 'abandoned'
    : liveIds.has(run.id)
      ? 'running'
      : run.awaitingApproval
        ? 'awaiting-approval'
        : run.isComplete('publish')
          ? 'published'
          : gate
            ? gate.passed
              ? 'ready'
              : 'failed'
            : 'running';

  let channelName = m.personaId;
  try {
    channelName = loadPersona(m.personaId).name;
  } catch {
    /* the id is a serviceable name */
  }

  return {
    id: run.id,
    channelId: m.personaId,
    channelName,
    formatId: m.formatId,
    topic: m.topic,
    title,
    createdAt: m.createdAt,
    spentPence: m.spentPence,
    completed: [...m.completed],
    state,
    episode: m.episode,
    short: m.short ?? null,
    story: m.story ?? null,
    derivedFrom: m.derivedFrom ?? null,
    durationS,
    gate,
  };
};

/** Runs, newest first, optionally narrowed to one channel. */
export const runs = (opts: { channelId?: string; limit?: number; live?: ReadonlySet<string> } = {}): RunSummary[] => {
  const ids = Run.list().filter((id) => !opts.channelId || id.startsWith(`${opts.channelId}/`));
  const out: RunSummary[] = [];

  for (const id of ids) {
    try {
      out.push(runSummary(Run.open(id), opts.live));
    } catch {
      // A directory that is not a readable run is skipped rather than fatal.
    }
  }

  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return opts.limit ? out.slice(0, opts.limit) : out;
};

/** Rough spoken length a format aims at, for showing an estimate before a run. */
export const nominalMinutes = (format: EpisodeFormat): number =>
  Math.round(nominalSeconds(format) / 60);
