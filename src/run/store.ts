/**
 * A run is a directory, and every stage writes its artifact into it.
 *
 * WHY A DIRECTORY AND NOT A DATABASE. The design document gives the Foundry its
 * own Postgres, which is right at volume and wrong at three shows a week. What
 * an evidence ledger needs before anything else is to be INSPECTABLE: when an
 * episode says something wrong, the question is "where did that come from", and
 * a directory you can open answers it in seconds where a table needs a query
 * and a client. Postgres earns its place at stage 9, when the closed loop
 * starts asking questions across runs. Moving then is a migration of files that
 * were always structured; starting there is setup friction paid before a single
 * episode exists.
 *
 * WHY EVERY STAGE PERSISTS. A pipeline that holds everything in memory can only
 * be run from the start. Rendering is the expensive step and scripting is the
 * slow one, so re-running QA on an existing script has to be possible without
 * paying for either again. Persisted stages also make the thing debuggable by
 * reading rather than by instrumenting.
 */
import fs from 'fs';
import { readArchive } from '../archive/record';
import { loadFormat } from '../formats/load';

const isShortFormat = (formatId: string): boolean => {
  try {
    return loadFormat(formatId).kind === 'short';
  } catch {
    return false;
  }
};
import path from 'path';
import { z } from 'zod';
import { runsDir } from '../config';

/** The stages, in the order they run. A run records which it has completed. */
export const STAGES = [
  'brief',
  'corpus',
  'claims',
  // The single-story lane's replacement for claims, verification and repair:
  // the one to three documents that carry the story, read whole and fused into
  // one reference article. Its own stage so a resumed run does not pay for the
  // fusion twice - it is the most expensive single call on that lane, because
  // it reads three documents at sixty thousand characters each.
  // See evidence/story.ts.
  'reference',
  // The true crime lane's replacement for the same three stages, and a separate
  // stage from `reference` rather than a reuse of it because what it holds is a
  // different object: a dated chronology, a cast with backgrounds, and every
  // event marked established, alleged or disputed. Sharing the name would mean
  // one artifact file that parses two ways depending on which lane wrote it,
  // and a resumed run guessing which. See evidence/casefile.ts.
  'casefile',
  'verification',
  // Narrowing, rebinding and hedging the claims that failed verification, so a
  // claim that says more than its quote loses the over-reach instead of losing
  // the fact. Its own stage because it is separately resumable and separately
  // costed - see evidence/repair.ts.
  'repair',
  'script',
  // The last pass over the prose before it is voiced, and the only one whose
  // subject is how it SOUNDS rather than whether it is right. It may not add a
  // fact, which is enforced rather than requested. See script/perform.ts.
  'perform',
  // Reading the finished script against the ledger for anything it states that
  // no claim supports. Runs AFTER the performance pass, so it reviews the text
  // that will actually be spoken. Its own stage for the ordinary reason: it costs
  // a model call, so a resumed run must not pay for it twice.
  'grounding',
  'render',
  'qa',
  'publish',
] as const;

export type Stage = (typeof STAGES)[number];

/**
 * Thrown by Run.spend past the hard ceiling. A NAMED CLASS so the renderer can
 * recognise it and finish the voicing it is in the middle of rather than
 * throwing away beats already paid for (owner, 2026-10-08); everything else
 * stops on it as before.
 */
export class BudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceeded';
  }
}

/** Thrown by Run.spend when a person pressed Stop. Never swallowed. */
export class StoppedByPerson extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoppedByPerson';
  }
}

/**
 * Runs somebody asked to stop, and who asked. Checked at every paid call, so a
 * job stops after the call it is in, keeping what that call bought. Cleared
 * when a job on the run starts or ends (server/jobs.ts).
 */
export const stopRequests = new Map<string, string>();

export const runManifestSchema = z.object({
  id: z.string().min(1),
  personaId: z.string().min(1),
  formatId: z.string().min(1),
  topic: z.string().min(1),
  createdAt: z.string().datetime(),
  /** Stages finished, in order. Lets a rerun skip what is already done. */
  completed: z.array(z.enum(STAGES)).default([]),
  /** Accumulated spend in pence, so the budget ceiling is enforceable. */
  spentPence: z.number().nonnegative().default(0),
  /** Set when a run is abandoned, with the reason, rather than deleting it. */
  abandoned: z.string().optional(),
  /**
   * The run this one was derived from, for a short cut from a finished episode.
   *
   * Recorded on the run rather than inferred from a naming convention, because
   * the provenance question a short has to be able to answer is "which verified
   * facts is this restating", and the answer lives in the parent's claims
   * artifact. A short whose parent is gone cannot answer it.
   */
  derivedFrom: z.string().optional(),

  /**
   * The series a long episode is filed into, by title. Its script opens by
   * naming it (formats/forRun.ts) and publish puts it on that series' shelf,
   * creating the shelf the first time a title is used.
   */
  seriesTitle: z.string().min(1).optional(),

  /** A rapid fire's chosen countries, by name. Unset: the desk's own regions. */
  countries: z.array(z.string()).optional(),

  /** Written by hand from a blank template: no research, no paid writing. */
  handwritten: z.boolean().default(false),

  /** Overrides the channel's content rating for this one. Unset = the channel's. */
  contentRating: z.enum(['general', 'mature']).optional(),

  /**
   * Which episode of the channel this is.
   *
   * Recorded rather than parsed back out of the directory name, because a
   * short needs its PARENT's number to sit beside it and reading that from a
   * string is the kind of thing that works until somebody renames a folder.
   */
  episode: z.number().int().positive().default(1),

  /** Which short of that episode, when it is one. */
  short: z.number().int().positive().optional(),

  /**
   * Nobody may spend on audio for this run until a person has read the script.
   *
   * THE BREAK IS THE POINT. Rendering is the only irreversible spend in the
   * pipeline - research and writing produce text somebody can read and throw
   * away, audio produces a file and a bill. Stopping between them means a
   * script that is wrong costs pennies instead of pounds, and it is the one
   * place a person can still change the outcome cheaply.
   *
   * Set at creation. `approvedAt` releases it, and is a timestamp rather than a
   * flag because "who let this through and when" is the question somebody asks
   * about a published episode six weeks later.
   */
  holdForApproval: z.boolean().default(false),
  /** How many times the voice was discarded by an edit and has to be made again. */
  revoicings: z.number().int().nonnegative().default(0),
  /** How many times the voice was made again from nothing, as a new take. */
  regenerations: z.number().int().nonnegative().default(0),
  /** Why the last job on this run failed; cleared when the next one starts. */
  lastFailure: z
    .object({ at: z.string().datetime(), message: z.string(), stage: z.string().nullable().default(null) })
    .optional(),
  approvedAt: z.string().datetime().optional(),

  /**
   * Which engine voices this run, chosen per run in the studio.
   *
   * PER RUN, NOT PER DEPLOYMENT. FOUNDRY_TTS used to decide for every run at
   * once; now a person picks at the point of spending. openai is the default
   * because it is the cheap one, and a run never mixes the two: changing it
   * deletes any beats the other engine already made.
   */
  voiceEngine: z.enum(['openai', 'elevenlabs']).default('openai'),
  /**
   * ElevenLabs only: run the tag pass (script/tagPass.ts) once before voicing.
   * Off means the script is voiced exactly as written, hand-typed tags included.
   */
  tagPass: z.boolean().default(false),
  /** When the tag pass ran, so a resume never pays for it twice. */
  tagPassAt: z.string().datetime().optional(),
  /**
   * A label a person can find a run by, shown beside it everywhere in the
   * studio. First used for the GPT-voiced originals re-voiced on ElevenLabs
   * (owner, 2026-10-10).
   */
  tag: z.string().trim().min(1).max(40).optional(),

  /**
   * This run's script was written in one call rather than beat by beat.
   *
   * RECORDED BECAUSE IT CHANGES WHAT THE RUN IS EVIDENCE OF. The two methods
   * are being compared on real episodes, and a comparison needs to know which
   * is which six weeks later, when the only thing left is a directory. It also
   * means a `resume` continues the way the run started rather than quietly
   * switching methods halfway through an episode.
   */
  onePass: z.boolean().optional(),
  /**
   * Which optional stages this run was started with.
   *
   * ON THE MANIFEST FOR THE SAME REASON AS onePass: a resume must continue the way
   * the run started. Resuming with different stages would mean half an episode was
   * checked by passes the other half never saw, and the gate report would describe
   * neither half. See config/stages.ts.
   */
  stages: z.record(z.boolean()).optional(),

  /**
   * How this run researched, when it was asked for something other than what
   * its format says.
   *
   * ON THE MANIFEST FOR THE SAME REASON AS onePass AND stages: a resume must
   * continue the way the run started. Half an episode researched breadth-first
   * and half from one fused reference would be neither, and the artifacts on
   * disk would not say which. Absent means the format decides, which is the
   * normal case.
   */
  research: z.enum(['extensive', 'single']).optional(),

  /**
   * Which unit of a source script this run was cut from.
   *
   * ONLY ANTHOLOGIES HAVE ONE. A source format writes ten self-contained
   * stories in one script and each becomes its own run, so "the third story of
   * that script" is the only durable name the third one has - its short number
   * is an arrival order, and cutting stories 3 and 7 on their own makes them
   * s01 and s02.
   *
   * Recorded so a second cut can find the run it already made instead of
   * rendering a duplicate beside it, and so the set can be reassembled in the
   * order it was written rather than the order somebody cut it.
   */
  story: z.number().int().positive().optional(),

  /**
   * When this is meant to go out.
   *
   * WHY A RUN CARRIES ITS OWN TIME. Cadence in schedule.yaml answers "is this
   * SHOW behind", which is the right question for an episode and the wrong one
   * for ten shorts cut in an afternoon. Those ten are finished, they are all
   * due by any cadence you like, and publishing them together is exactly the
   * thing that makes a feed look like a machine emptied a bucket into it.
   *
   * So a batch is given release times when it is cut, one per story, spread
   * across the days between episodes. Nothing enforces it: a person can always
   * publish something now, and this is what the queue reads to decide whether
   * to offer that or to say when it is due.
   *
   * Absent means "whenever somebody says", which is what an episode is.
   */
  releaseAt: z.string().optional(),

  /**
   * When a person approved this to go out by itself, at `releaseAt`.
   *
   * SEPARATE FROM `releaseAt` ON PURPOSE. A date is a plan; this is a decision.
   * Something that publishes on its own must be able to say who allowed it and
   * when, and "it had a date on it" is not that - a date could be left over
   * from an arrangement somebody changed their mind about.
   *
   * It is also what the releaser passes as `confirmed`, which is the same thing
   * `--yes` means on the command line: a person looked and meant it.
   */
  releaseApprovedAt: z.string().optional(),

  /**
   * When somebody parked this rather than publishing it.
   *
   * A THIRD STATE, AND IT IS NOT A FAILURE. An episode can pass every check and
   * still not be one you want out this week: the subject has gone cold, two of
   * them cover the same ground, you want to rewrite the open. Without somewhere
   * to put those, the only choices are publish it or leave it cluttering the
   * list you are trying to decide from - and both are how a good episode gets
   * published by accident.
   *
   * Nothing is lost by holding. It comes back the moment somebody takes it off
   * hold, in the state it was in.
   */
  heldAt: z.string().optional(),
});

export type RunManifest = z.infer<typeof runManifestSchema>;

const MANIFEST = 'run.json';

/**
 * Run ids sort chronologically as strings.
 *
 * A directory listing is the primary interface to these, so the order `ls`
 * gives has to be the order they happened. An opaque uuid would make the most
 * common question - "what did we make most recently" - need a tool.
 *
 * The stamp is only accurate to the second, so `exists` disambiguates a
 * collision. Two runs of the same show inside one second is not hypothetical -
 * cutting a short immediately after gating its parent does it - and before this
 * existed the second run silently ADOPTED the first's directory: same manifest
 * path, same artifacts, `hasArtifact` true for stages it had never run. It
 * would have written an episode out of another episode's corpus and looked
 * entirely healthy doing it.
 *
 * The suffix keeps the chronological sort, because it lands between this second
 * and the next one either way.
 */
/**
 * A run's name, which is also its place on disk.
 *
 * WHAT THE OLD ONE COULD NOT TELL YOU. Every run lived directly under runs/ as
 * `20260913-000745-older-than-writing`, which answers "when" and "which show"
 * and nothing else. It could not say which episode of that show this was,
 * what it was about, or - worst - which episode a short had been cut from. Six
 * episodes in, `ls runs/` was a wall of timestamps and the only way to find one
 * was to open manifests until the topic matched.
 *
 * So the layout is a channel per directory, and a name that says what it is:
 *
 *   runs/root-health/e001-20260913-why-a-bad-night-makes-you-forget/
 *   runs/root-health/e001-s01-20260913-the-twenty-minute-gap/
 *   runs/root-health/e002-20260920-whether-willpower-runs-out/
 *
 * The episode number is per channel and counted from what is already there, so
 * it matches what a listener sees in a feed. A short carries its PARENT's
 * number and its own, which is the whole point - a short is not an episode and
 * belongs beside the one it came from rather than in a sequence of its own.
 *
 * SORTING STILL WORKS. Within a channel the episode number leads, so lexical
 * order is production order and `ls` answers "what did we make most recently"
 * without a tool. That was the reason the old scheme led with a timestamp, and
 * it survives.
 */
export const slugForTopic = (topic: string, words = 6): string => {
  const slug = topic
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    // Leading filler says nothing and eats the budget: "the sinking of the
    // Marchioness" should slug as "sinking-of-the-marchioness".
    .filter((w, i) => !(i === 0 && ['the', 'a', 'an', 'how', 'what', 'why', 'whether'].includes(w)))
    .slice(0, words)
    .join('-');

  return slug || 'untitled';
};

const DATE_STAMP = (now: Date) => now.toISOString().slice(0, 10).replace(/-/g, '');

/** Episode directories already in a channel, highest number first. */
export const episodesIn = (root: string, channelId: string): string[] => {
  const dir = path.join(root, channelId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => /^e\d{3}-/.test(d) && fs.existsSync(path.join(dir, d, MANIFEST)))
    .sort();
};

/**
 * The next episode number for a channel.
 *
 * Counted from EPISODE directories only, so cutting three shorts from episode
 * one does not make the next episode number four. A short is not an episode.
 */
export const nextEpisodeNumber = (root: string, channelId: string): number => {
  const numbers = episodesIn(root, channelId)
    .filter((d) => !/^e\d{3}-s\d{2}-/.test(d))
    .map((d) => Number(d.slice(1, 4)))
    .filter((n) => Number.isFinite(n));

  return numbers.length ? Math.max(...numbers) + 1 : 1;
};

/** Shorts already cut from one episode, so the next gets the next number. */
const nextShortNumber = (root: string, channelId: string, episode: number): number => {
  const prefix = `e${String(episode).padStart(3, '0')}-s`;
  const numbers = episodesIn(root, channelId)
    .filter((d) => d.startsWith(prefix))
    .map((d) => Number(d.slice(prefix.length, prefix.length + 2)))
    .filter((n) => Number.isFinite(n));

  return numbers.length ? Math.max(...numbers) + 1 : 1;
};

/**
 * SHORTS ARE NUMBERED APART FROM EPISODES (owner, 2026-10-05): s001, s002 for a
 * channel's shorts, e001, e002 for its episodes. A short made on its own used
 * to take the next episode number, so a channel's first episode could be
 * "e004". A short CUT FROM an episode keeps e001-s01: it belongs to that one.
 */
export const nextStandaloneShortNumber = (root: string, channelId: string): number => {
  const dir = path.join(root, channelId);
  if (!fs.existsSync(dir)) return 1;
  const numbers = fs
    .readdirSync(dir)
    .filter((d) => /^s\d{3}-/.test(d))
    .map((d) => Number(d.slice(1, 4)));
  return numbers.length ? Math.max(...numbers) + 1 : 1;
};

/** e001, s001 or e001-s01, from a run's folder name. */
export const runLabel = (runId: string): string =>
  runId.split('/')[1]?.match(/^(e\d{3}-s\d{2}|[es]\d{3})/)?.[1] ?? runId;

export interface RunName {
  /** `<channel>/<folder>` - the id, and the path under runs/. */
  id: string;
  /** Which episode of the channel this is, or which it was cut from. */
  episode: number;
  /** Which short of that episode, when it is one. */
  short?: number;
}

export const newRunName = (
  input: { personaId: string; topic: string; parentEpisode?: number; short?: boolean },
  root: string,
  now = new Date()
): RunName => {
  const slug = slugForTopic(input.topic);
  const stamp = DATE_STAMP(now);

  if (input.parentEpisode !== undefined) {
    const n = nextShortNumber(root, input.personaId, input.parentEpisode);
    const e = String(input.parentEpisode).padStart(3, '0');
    return {
      id: `${input.personaId}/e${e}-s${String(n).padStart(2, '0')}-${stamp}-${slug}`,
      episode: input.parentEpisode,
      short: n,
    };
  }

  if (input.short) {
    const n = nextStandaloneShortNumber(root, input.personaId);
    return { id: `${input.personaId}/s${String(n).padStart(3, '0')}-${stamp}-${slug}`, episode: n };
  }

  const episode = nextEpisodeNumber(root, input.personaId);
  return {
    id: `${input.personaId}/e${String(episode).padStart(3, '0')}-${stamp}-${slug}`,
    episode,
  };
};

export class Run {
  private constructor(
    readonly dir: string,
    private manifestData: RunManifest
  ) {}

  get id(): string {
    return this.manifestData.id;
  }

  get manifest(): Readonly<RunManifest> {
    return this.manifestData;
  }

  static create(
    input: {
      personaId: string;
      formatId: string;
      topic: string;
      derivedFrom?: string;
      /** Set when this is a short, so it sits beside the episode it came from. */
      parentEpisode?: number;
      /** Set when this is one story cut out of a source script. */
      story?: number;
      /** Set when the script is to be written in a single call. */
      onePass?: boolean;
      stages?: Record<string, boolean>;
      /** Override the format's research mode for this run only. */
      research?: 'extensive' | 'single';
      /** Stop before rendering and wait for a person to read the script. */
      holdForApproval?: boolean;
      /** The series a long episode belongs to. */
      seriesTitle?: string;
      /** A blank template to be written by hand. See pipeline/handwritten.ts. */
      handwritten?: boolean;
      /** A rapid fire's chosen countries. See news/countries.ts. */
      countries?: string[];
    },
    opts: { root?: string; now?: () => Date } = {}
  ): Run {
    const now = opts.now?.() ?? new Date();
    const root = opts.root ?? runsDir();
    // ONE CALL. It reads the directory to decide the next number, so calling it
    // twice invites two different answers for one run.
    const name = newRunName(
      {
        personaId: input.personaId,
        topic: input.topic,
        parentEpisode: input.parentEpisode,
        // A short made on its own is numbered among the channel's shorts.
        short: input.parentEpisode === undefined && isShortFormat(input.formatId),
      },
      root,
      now
    );
    const { id } = name;
    const dir = path.join(root, ...id.split('/'));

    fs.mkdirSync(dir, { recursive: true });

    const manifest = runManifestSchema.parse({
      id,
      episode: name.episode,
      short: name.short,
      personaId: input.personaId,
      formatId: input.formatId,
      seriesTitle: input.seriesTitle,
      topic: input.topic,
      createdAt: now.toISOString(),
      completed: [],
      spentPence: 0,
      derivedFrom: input.derivedFrom,
      story: input.story,
      onePass: input.onePass,
      stages: input.stages,
      research: input.research,
      holdForApproval: input.holdForApproval ?? false,
      handwritten: input.handwritten ?? false,
      countries: input.countries?.length ? input.countries : undefined,
    });

    const run = new Run(dir, manifest);
    run.save();
    return run;
  }

  /**
   * Open a run by id, or by just the folder name when that is unambiguous.
   *
   * The id is `<channel>/<folder>`, which is what the logs print and what a
   * person should paste back. The leaf-only form is accepted because somebody
   * reading a directory listing will type what they see, and refusing that
   * would be pedantry - but an ambiguous leaf is an error rather than a guess,
   * since resuming the wrong run spends money on the wrong episode.
   */
  static open(id: string, opts: { root?: string } = {}): Run {
    const root = opts.root ?? runsDir();
    const direct = path.join(root, ...id.split('/'));

    if (fs.existsSync(path.join(direct, MANIFEST))) {
      const manifest = runManifestSchema.parse(
        JSON.parse(fs.readFileSync(path.join(direct, MANIFEST), 'utf8'))
      );

      // THE DIRECTORY IS THE TRUTH ABOUT WHICH RUN THIS IS.
      //
      // The id is stored in the manifest as well, and the two can disagree -
      // renaming a run directory is enough to do it. When they do, everything
      // that compares an id against `Run.list()` silently stops matching, and
      // nothing reports an error: the self-similarity check stopped excluding
      // the run being gated and every short reported a hundred percent overlap
      // with itself, naming itself as the source.
      //
      // Corrected on the way in rather than treated as an error, because the
      // folder is how this run was found and there is nothing to decide.
      const fromDir = path.relative(root, direct).split(path.sep).join('/');
      if (manifest.id !== fromDir) manifest.id = fromDir;

      return new Run(direct, manifest);
    }

    const matches = Run.list(opts).filter((candidate) => candidate.split('/').pop() === id);
    if (matches.length === 1) return Run.open(matches[0]!, opts);
    if (matches.length > 1) {
      throw new Error(
        `"${id}" matches ${matches.length} runs. Use the full id:\n  ${matches.join('\n  ')}`
      );
    }

    throw new Error(`no run "${id}" (looked in ${direct})`);
  }

  /**
   * Most recent run, which is what a bare `--run` almost always means.
   *
   * BY createdAt, NOT BY NAME, and that changed with the layout. Names used to
   * lead with a timestamp so lexical order was production order across the
   * whole studio; now they lead with a channel, so the newest run of the
   * alphabetically-last channel would win.
   *
   * The manifest's own field rather than the file's mtime, for two reasons:
   * resuming a run rewrites its manifest, so mtime means "last touched" rather
   * than "most recent", and mtime has millisecond resolution that two runs
   * created in the same tick share - which made the answer depend on readdir
   * order.
   */
  static latest(opts: { root?: string } = {}): Run | null {
    const runs = Run.list(opts).map((id) => Run.open(id, opts));
    if (!runs.length) return null;

    return runs.sort(
      (a, b) => Date.parse(b.manifest.createdAt) - Date.parse(a.manifest.createdAt)
    )[0]!;
  }

  /**
   * The runs already cut from one source run, in the order they were written.
   *
   * WHAT THIS IS FOR. Cutting ten stories out of a source script is ten renders,
   * and a cut interrupted at story seven has to be resumable or the second
   * attempt pays for all ten again AND leaves the first six sitting beside
   * their own duplicates, indistinguishable in a directory listing.
   *
   * Only the source's own channel is searched, because a run derived from
   * another run is always the same show - a short in a different channel from
   * its parent would be a different show wearing its facts.
   */
  static derivedFrom(sourceId: string, opts: { root?: string } = {}): Run[] {
    const channel = sourceId.split('/')[0];
    return Run.list(opts)
      .filter((id) => id.split('/')[0] === channel)
      .map((id) => Run.open(id, opts))
      .filter((run) => run.manifest.derivedFrom === sourceId)
      .sort((a, b) => (a.manifest.story ?? 0) - (b.manifest.story ?? 0));
  }

  /**
   * Every run, as `<channel>/<folder>`, in channel then production order.
   *
   * One level deep, deliberately. A run directory holds media and checkpoints
   * and is not somewhere to go looking recursively, and the archive of older
   * runs lives under its own channel folder like everything else.
   */
  static list(opts: { root?: string } = {}): string[] {
    const root = opts.root ?? runsDir();
    if (!fs.existsSync(root)) return [];

    const ids: string[] = [];
    for (const channel of fs.readdirSync(root).sort()) {
      const channelDir = path.join(root, channel);
      if (!fs.statSync(channelDir).isDirectory()) continue;

      for (const folder of fs.readdirSync(channelDir).sort()) {
        if (fs.existsSync(path.join(channelDir, folder, MANIFEST))) {
          ids.push(`${channel}/${folder}`);
        }
      }
    }
    return ids;
  }

  private save(): void {
    fs.writeFileSync(
      path.join(this.dir, MANIFEST),
      `${JSON.stringify(this.manifestData, null, 2)}\n`,
      'utf8'
    );
  }

  /** Write a stage artifact as pretty JSON, so it can be read by a person. */
  writeArtifact(stage: Stage, data: unknown): string {
    const file = path.join(this.dir, `${stage}.json`);
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return file;
  }

  /**
   * The third type parameter pins Input to `unknown` deliberately.
   *
   * With a bare `z.ZodType<T>` TypeScript unifies T with the schema's INPUT
   * type, so any schema using `.default()` hands back a type whose defaulted
   * fields are still optional - `contested?: boolean` rather than the
   * `contested: boolean` that parsing actually produces. Everything downstream
   * then has to handle an undefined that cannot occur.
   */
  readArtifact<T>(stage: Stage, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
    const file = path.join(this.dir, `${stage}.json`);
    if (!fs.existsSync(file)) {
      throw new Error(`run ${this.id} has no ${stage} artifact yet`);
    }
    return schema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  hasArtifact(stage: Stage): boolean {
    return fs.existsSync(path.join(this.dir, `${stage}.json`));
  }

  /** Somewhere to put audio, which does not belong in JSON. */
  /**
   * Where this run's audio actually is, or null.
   *
   * THE DIRECTORY IS THE TRUTH, NOT THE RECORD OF IT. render.json stores the
   * path the renderer was given, which is absolute, while the schema calls the
   * field "relative to the run directory" - so the two have disagreed since the
   * field existed, and an absolute path stops being true the moment a run
   * directory is renamed. Renumbering a catalogue did exactly that, and the
   * failure surfaced at the last possible moment: "no audio at ...e006-s05..."
   * for a file sitting in e001-s04 with a different name on the door.
   *
   * So this looks in the run's own media directory first and falls back to the
   * stored value, which covers a relative path, a still-valid absolute one and
   * a stale one. Same lesson as the app's downloads: never trust a persisted
   * absolute path.
   */
  audioFile(stored?: string): string | null {
    const own = path.join(this.dir, 'media', 'episode.wav');
    if (fs.existsSync(own)) return own;

    if (stored) {
      const resolved = path.resolve(this.dir, stored);
      if (fs.existsSync(resolved)) return resolved;
    }
    // ARCHIVED TO R2: the path still names the audio; the file server fetches
    // it from R2. See archive/record.ts.
    if (readArchive(this.dir)?.files['media/episode.wav'] !== undefined) return own;
    return null;
  }

  mediaPath(name: string): string {
    const dir = path.join(this.dir, 'media');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
  }

  /**
   * Release the hold, so the next resume renders.
   *
   * Recorded on the manifest rather than done by deleting a file, because the
   * approval is a fact about the run that outlives the moment: a published
   * episode should be able to say when somebody read it.
   */
  /** The script changed after it was voiced: one more voicing is allowed for. */
  noteRevoicing(): void {
    this.manifestData.revoicings = (this.manifestData.revoicings ?? 0) + 1;
    this.save();
  }

  noteRegeneration(): void {
    this.manifestData.regenerations = (this.manifestData.regenerations ?? 0) + 1;
    this.save();
  }

  setVoiceEngine(engine: 'openai' | 'elevenlabs'): void {
    this.manifestData.voiceEngine = engine;
    this.save();
  }

  setTag(tag: string | undefined): void {
    this.manifestData.tag = tag;
    this.save();
  }

  setTagPass(on: boolean, doneAt?: Date): void {
    this.manifestData.tagPass = on;
    if (doneAt) this.manifestData.tagPassAt = doneAt.toISOString();
    this.save();
  }

  /** Asked for again: forget the last one, so the next voicing runs it. */
  forgetTagPass(): void {
    delete this.manifestData.tagPassAt;
    this.save();
  }

  approve(now = new Date()): void {
    this.manifestData.approvedAt = now.toISOString();
    this.save();
  }

  /**
   * Say when this is meant to go out, or clear it.
   *
   * ADVISORY, NEVER A LOCK. Nothing refuses to publish something early; this is
   * what the queue reads to decide whether to offer a publish button now or to
   * say when it is due. A schedule that stopped a person publishing would be a
   * schedule somebody works around.
   */
  /** File this episode under a series. Only before it is published. */
  setSeriesTitle(title: string): void {
    this.manifestData.seriesTitle = title;
    this.save();
  }

  setContentRating(rating: 'general' | 'mature' | null): void {
    if (rating) this.manifestData.contentRating = rating;
    else delete this.manifestData.contentRating;
    this.save();
  }

  setReleaseAt(when: Date | null, approvedAt?: Date): void {
    if (when) {
      this.manifestData.releaseAt = when.toISOString();
      if (approvedAt) this.manifestData.releaseApprovedAt = approvedAt.toISOString();
      // Approving takes it off the shelf, for the same reason holding
      // withdraws an approval: the two states are exclusive.
      delete this.manifestData.heldAt;
    } else {
      // CLEARING THE DATE CLEARS THE APPROVAL. An approval that outlived the
      // plan it was given for would let a run somebody took off the schedule
      // go out the next time it was put back on, without being asked again.
      delete this.manifestData.releaseAt;
      delete this.manifestData.releaseApprovedAt;
    }
    this.save();
  }

  /**
   * Park this, or take it off the shelf.
   *
   * HOLDING WITHDRAWS AN APPROVAL. The two cannot both be true: something
   * somebody deliberately set aside must not then publish itself on Thursday
   * because it still had a date from before.
   */
  setHeld(held: boolean, at = new Date()): void {
    if (held) {
      this.manifestData.heldAt = at.toISOString();
      delete this.manifestData.releaseAt;
      delete this.manifestData.releaseApprovedAt;
    } else {
      delete this.manifestData.heldAt;
    }
    this.save();
  }

  /** Waiting on a person, rather than on work. */
  get awaitingApproval(): boolean {
    return this.manifestData.holdForApproval && !this.manifestData.approvedAt;
  }

  markComplete(stage: Stage): void {
    if (!this.manifestData.completed.includes(stage)) {
      this.manifestData.completed.push(stage);
      this.save();
    }
  }

  /**
   * Mark a stage as not done, because what it produced is no longer true.
   *
   * THE ONE CASE THIS EXISTS FOR: a script edited after it was voiced. The audio
   * is about different words now, and a run that still reports `render` complete
   * would carry a duration measured from a file nobody is going to hear and a
   * gate report about prose that has changed underneath it.
   *
   * Deliberately narrow. This is not an undo - it does not delete artifacts or
   * refund anything - it is a statement that a stage has to happen again.
   */
  uncomplete(stage: Stage): void {
    const before = this.manifestData.completed.length;
    this.manifestData.completed = this.manifestData.completed.filter((s) => s !== stage);
    if (this.manifestData.completed.length !== before) this.save();
  }

  isComplete(stage: Stage): boolean {
    return this.manifestData.completed.includes(stage);
  }

  /**
   * Record spend and refuse to continue past the ceiling.
   *
   * Throwing rather than warning is the point: a run that quietly carries on
   * over budget produces an episode nobody decided to pay for.
   *
   * THE TARGET ONLY WARNS. Crossing it is journalled once, so the run's page
   * and its record say it went over what it was meant to cost, and the work
   * carries on to the ceiling (owner, 2026-10-08: "don't stop the generation").
   */
  spend(pence: number, budgetPence: number, targetPence?: number): void {
    const before = this.manifestData.spentPence;
    this.manifestData.spentPence += pence;
    this.save();
    const after = this.manifestData.spentPence;
    if (targetPence !== undefined && before <= targetPence && after > targetPence && after <= budgetPence) {
      this.journal({
        stage: 'budget',
        event: `over the ${targetPence}p target at ${after.toFixed(1)}p; carrying on, the hard ceiling is ${budgetPence}p`,
      });
    }
    // A PERSON PRESSED STOP: halt here, after what was just paid for is kept.
    if (stopRequests.has(this.id)) {
      throw new StoppedByPerson(`stopped by ${stopRequests.get(this.id) ?? 'somebody'} at ${after.toFixed(1)}p`);
    }
    if (after > budgetPence) {
      throw new BudgetExceeded(
        `run ${this.id} has spent ${after.toFixed(1)}p, over the ${budgetPence}p ceiling (the hard limit), ` +
          `so it stopped here. Everything paid for so far is kept: Resume carries on from this step ` +
          `once the ceiling is raised (FOUNDRY_SHORT_BUDGET_PENCE / FOUNDRY_EPISODE_BUDGET_PENCE).`
      );
    }
  }

  /**
   * Why the last piece of work on this run failed, kept on the run.
   *
   * THE JOB'S ERROR LIVES IN MEMORY, so a restart (or fifty other jobs) lost
   * the one sentence that explained a run with no audio. On disk, it survives
   * and the run's page can say what went wrong and what to press.
   */
  noteFailure(message: string, stage: string | null = null, at = new Date()): void {
    this.manifestData.lastFailure = { at: at.toISOString(), message: message.slice(0, 2000), stage };
    this.save();
  }

  clearFailure(): void {
    if (!this.manifestData.lastFailure) return;
    delete this.manifestData.lastFailure;
    this.save();
  }

  /**
   * Partial work inside a stage, so a failure halfway through does not throw
   * away what was already paid for.
   *
   * WHY STAGE ARTIFACTS ARE NOT ENOUGH. A stage persists when it FINISHES. That
   * makes a run resumable between stages and worthless within one: writing a
   * ten-beat script is thirty model calls, and before this a failure on beat
   * eight discarded the twenty-one calls that had already succeeded. The
   * expensive failures are all mid-stage, because that is where the time is.
   *
   * Kept in a subdirectory rather than beside the stage artifacts so that a
   * directory listing still reads as the nine stages, and so a checkpoint is
   * obviously working state rather than a result.
   */
  writeCheckpoint(name: string, data: unknown): string {
    const dir = path.join(this.dir, 'checkpoints');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return file;
  }

  readCheckpoint<T>(name: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T | null {
    const file = path.join(this.dir, 'checkpoints', `${name}.json`);
    if (!fs.existsSync(file)) return null;

    try {
      return schema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // A checkpoint that cannot be read is work that has to be redone, which
      // costs money but is correct. Throwing here would make a corrupt
      // checkpoint permanently block a run that could simply start the stage
      // again - the one situation where silently discarding is the right call.
      return null;
    }
  }

  clearCheckpoint(name: string): void {
    const file = path.join(this.dir, 'checkpoints', `${name}.json`);
    if (fs.existsSync(file)) fs.rmSync(file);
  }

  /**
   * Append one line to the run's journal.
   *
   * APPEND-ONLY AND NEWLINE-DELIMITED, so it survives the process being killed
   * mid-write and can be read with `tail -f` while a run is going. A run that
   * dies leaves a journal ending exactly where it died, which is the single
   * most useful thing for working out what happened.
   *
   * Never throws. An observability failure must not be able to fail a run that
   * is otherwise fine - that would make the logging the least reliable part of
   * the system and the most likely thing to take an episode down with it.
   */
  journal(event: { stage: string; event: string; detail?: string; pence?: number }): void {
    try {
      fs.appendFileSync(
        path.join(this.dir, 'journal.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
        'utf8'
      );
    } catch {
      // Deliberately silent.
    }
  }

  /** The journal, parsed. Lines that will not parse are skipped, not fatal. */
  readJournal(): Array<{ at: string; stage: string; event: string; detail?: string; pence?: number }> {
    const file = path.join(this.dir, 'journal.jsonl');
    if (!fs.existsSync(file)) return [];

    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          // A half-written last line is what a killed process leaves behind.
          return [];
        }
      });
  }

  /**
   * When this run published, as the ISO string the publish artifact recorded.
   *
   * A NARROW READER RATHER THAN A SCHEMA, because the publish artifact is
   * written and read by the same code and the only field anything else needs is
   * this one. A Zod schema mirroring the platform's whole response would be a
   * second definition to keep in step for no safety it does not already have.
   */
  readPublishTimestamp(): string | null {
    const file = path.join(this.dir, 'publish.json');
    if (!fs.existsSync(file)) return null;
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as { publishedAt?: unknown };
    return typeof body.publishedAt === 'string' ? body.publishedAt : null;
  }

  abandon(reason: string): void {
    this.manifestData.abandoned = reason;
    this.save();
  }
}
