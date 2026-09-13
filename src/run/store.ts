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
import path from 'path';
import { z } from 'zod';
import { runsDir } from '../config';

/** The stages, in the order they run. A run records which it has completed. */
export const STAGES = [
  'brief',
  'corpus',
  'claims',
  'verification',
  // Narrowing, rebinding and hedging the claims that failed verification, so a
  // claim that says more than its quote loses the over-reach instead of losing
  // the fact. Its own stage because it is separately resumable and separately
  // costed - see evidence/repair.ts.
  'repair',
  'script',
  'render',
  'qa',
  'publish',
] as const;

export type Stage = (typeof STAGES)[number];

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
 *   runs/honest-health/e001-20260913-why-a-bad-night-makes-you-forget/
 *   runs/honest-health/e001-s01-20260913-the-twenty-minute-gap/
 *   runs/honest-health/e002-20260920-whether-willpower-runs-out/
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

export interface RunName {
  /** `<channel>/<folder>` - the id, and the path under runs/. */
  id: string;
  /** Which episode of the channel this is, or which it was cut from. */
  episode: number;
  /** Which short of that episode, when it is one. */
  short?: number;
}

export const newRunName = (
  input: { personaId: string; topic: string; parentEpisode?: number },
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
    },
    opts: { root?: string; now?: () => Date } = {}
  ): Run {
    const now = opts.now?.() ?? new Date();
    const root = opts.root ?? runsDir();
    // ONE CALL. It reads the directory to decide the next number, so calling it
    // twice invites two different answers for one run.
    const name = newRunName(
      { personaId: input.personaId, topic: input.topic, parentEpisode: input.parentEpisode },
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
      topic: input.topic,
      createdAt: now.toISOString(),
      completed: [],
      spentPence: 0,
      derivedFrom: input.derivedFrom,
      story: input.story,
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
      return new Run(
        direct,
        runManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(direct, MANIFEST), 'utf8')))
      );
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
  mediaPath(name: string): string {
    const dir = path.join(this.dir, 'media');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
  }

  markComplete(stage: Stage): void {
    if (!this.manifestData.completed.includes(stage)) {
      this.manifestData.completed.push(stage);
      this.save();
    }
  }

  isComplete(stage: Stage): boolean {
    return this.manifestData.completed.includes(stage);
  }

  /**
   * Record spend and refuse to continue past the ceiling.
   *
   * Throwing rather than warning is the point: a run that quietly carries on
   * over budget produces an episode nobody decided to pay for.
   */
  spend(pence: number, budgetPence: number): void {
    this.manifestData.spentPence += pence;
    this.save();
    if (this.manifestData.spentPence > budgetPence) {
      throw new Error(
        `run ${this.id} has spent ${this.manifestData.spentPence.toFixed(1)}p, over the ` +
          `${budgetPence}p ceiling. Raise FOUNDRY_EPISODE_BUDGET_PENCE or start again.`
      );
    }
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
