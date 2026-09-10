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
export const newRunId = (
  personaId: string,
  now = new Date(),
  exists: (id: string) => boolean = () => false
): string => {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const base = `${stamp}-${personaId}`;

  if (!exists(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`cannot make a run id: ${base} and 98 suffixes are all taken`);
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
    input: { personaId: string; formatId: string; topic: string; derivedFrom?: string },
    opts: { root?: string; now?: () => Date } = {}
  ): Run {
    const now = opts.now?.() ?? new Date();
    const root = opts.root ?? runsDir();
    const id = newRunId(input.personaId, now, (candidate) =>
      fs.existsSync(path.join(root, candidate, MANIFEST))
    );
    const dir = path.join(root, id);

    fs.mkdirSync(dir, { recursive: true });

    const manifest = runManifestSchema.parse({
      id,
      personaId: input.personaId,
      formatId: input.formatId,
      topic: input.topic,
      createdAt: now.toISOString(),
      completed: [],
      spentPence: 0,
      derivedFrom: input.derivedFrom,
    });

    const run = new Run(dir, manifest);
    run.save();
    return run;
  }

  static open(id: string, opts: { root?: string } = {}): Run {
    const dir = path.join(opts.root ?? runsDir(), id);
    const file = path.join(dir, MANIFEST);
    if (!fs.existsSync(file)) {
      throw new Error(`no run "${id}" (looked in ${dir})`);
    }
    return new Run(dir, runManifestSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))));
  }

  /** Most recent run, which is what a bare `--run` almost always means. */
  static latest(opts: { root?: string } = {}): Run | null {
    const root = opts.root ?? runsDir();
    if (!fs.existsSync(root)) return null;
    const ids = fs
      .readdirSync(root)
      .filter((d) => fs.existsSync(path.join(root, d, MANIFEST)))
      .sort();
    const last = ids[ids.length - 1];
    return last ? Run.open(last, opts) : null;
  }

  static list(opts: { root?: string } = {}): string[] {
    const root = opts.root ?? runsDir();
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root)
      .filter((d) => fs.existsSync(path.join(root, d, MANIFEST)))
      .sort();
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

  abandon(reason: string): void {
    this.manifestData.abandoned = reason;
    this.save();
  }
}
