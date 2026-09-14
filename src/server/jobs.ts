/**
 * Work that outlives the request that started it.
 *
 * THE PROBLEM THIS SOLVES. A run takes two to twelve minutes and costs real
 * money. An HTTP request that waits for one has already lost: the browser gives
 * up, a proxy gives up, the laptop sleeps, and the run carries on spending with
 * nobody watching. So starting a run and watching a run are different requests.
 *
 * IN PROCESS, ON PURPOSE. A queue with workers is the right answer when several
 * machines share the work; here there is one operator, one machine, and one
 * shell. A job is a promise held in a map, and its progress is an array of
 * lines with some listeners attached. Everything that actually matters - the
 * artifacts, the checkpoints, the spend - is already on disk and already
 * resumable, so a process that dies loses the live log and nothing else.
 *
 * WHICH IS THE POINT WORTH KEEPING. This module is a window onto work the
 * pipeline was always able to do; it is not where the work lives. Deleting it
 * would cost the web interface and nothing else.
 */
import { EventEmitter } from 'events';
import { Run } from '../run/store';

export type JobKind = 'run' | 'shorts';

export interface JobEvent {
  at: string;
  /** Which pipeline stage, or `story 3` for a cut. */
  stage: string;
  message: string;
  /** Spend at the moment the line was written, so a chart can be drawn. */
  spentPence: number;
}

export interface Job {
  id: string;
  kind: JobKind;
  /** The run this is working on. For a cut, the source run. */
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  events: JobEvent[];
  /** Set when the work threw. The message a person should read. */
  error: string | null;
  /** Ids the job produced, for a cut: one per story. */
  produced: string[];
}

/**
 * How many finished jobs to remember.
 *
 * Finished jobs are kept so a page opened after the work ended still shows what
 * happened rather than an empty screen. Everything durable is on disk, so this
 * only has to outlive a page refresh.
 */
const KEEP_FINISHED = 50;

class JobRegistry extends EventEmitter {
  private jobs = new Map<string, Job>();
  private running = new Map<string, Promise<void>>();

  /** Run ids with work in flight, which is what makes a run show as running. */
  liveRunIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const [id, job] of this.jobs) {
      if (this.running.has(id)) ids.add(job.runId);
      for (const produced of job.produced) if (this.running.has(id)) ids.add(produced);
    }
    return ids;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** The job working on a run, if any, so a page can find its own progress. */
  forRun(runId: string): Job | undefined {
    const all = [...this.jobs.values()].filter((j) => j.runId === runId);
    return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  /**
   * Start work, and return immediately with something to watch.
   *
   * REFUSES TO START A SECOND JOB ON THE SAME RUN. Two pipelines writing one
   * run's artifacts would interleave stages and produce a directory that is
   * internally inconsistent in a way nothing downstream would detect - and the
   * obvious way to do it is a double click on a button.
   */
  start(input: {
    id: string;
    kind: JobKind;
    runId: string;
    work: (report: (stage: string, message: string) => void) => Promise<string[]>;
  }): Job {
    const existing = [...this.jobs.values()].find(
      (j) => j.runId === input.runId && this.running.has(j.id)
    );
    if (existing) return existing;

    const job: Job = {
      id: input.id,
      kind: input.kind,
      runId: input.runId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      events: [],
      error: null,
      produced: [],
    };
    this.jobs.set(job.id, job);

    const spent = (): number => {
      try {
        return Run.open(input.runId).manifest.spentPence;
      } catch {
        return 0;
      }
    };

    const report = (stage: string, message: string): void => {
      const event: JobEvent = {
        at: new Date().toISOString(),
        stage,
        message,
        spentPence: spent(),
      };
      job.events.push(event);
      this.emit(job.id, event);
    };

    const work = input
      .work(report)
      .then((produced) => {
        job.produced = produced;
      })
      .catch((err: unknown) => {
        // KEPT, NOT RETHROWN. Nobody is awaiting this promise - the request that
        // started it returned long ago - so a rethrow would become an unhandled
        // rejection and take the server down with it, which is a poor way to
        // report that one run failed.
        job.error = (err as Error)?.message ?? String(err);
        report('failed', job.error);
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        this.running.delete(job.id);
        this.emit(job.id, null);
        this.prune();
      });

    this.running.set(job.id, work);
    return job;
  }

  /** Listen to a job. Returns the unsubscribe. */
  watch(id: string, onEvent: (event: JobEvent | null) => void): () => void {
    this.on(id, onEvent);
    return () => this.off(id, onEvent);
  }

  private prune(): void {
    const finished = [...this.jobs.values()]
      .filter((j) => j.finishedAt)
      .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''));

    for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
      this.jobs.delete(job.id);
    }
  }
}

export const jobs = new JobRegistry();

/**
 * A job id that is unique without being opaque.
 *
 * The run id is in it on purpose: when something goes wrong the first question
 * is which run, and an answer that needs a lookup is an answer nobody reads.
 */
export const jobId = (kind: JobKind, runId: string): string =>
  `${kind}:${runId}:${Date.now().toString(36)}`;
