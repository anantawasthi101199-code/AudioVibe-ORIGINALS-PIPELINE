/**
 * The API the studio interface talks to.
 *
 * DELIBERATELY THIN. Every route here loads something, calls something that
 * already existed, and serialises the answer. There is no rule in this file
 * that is not already enforced somewhere the command line also goes through -
 * which is the only way the two front ends can stay honest about the same
 * pipeline. When a route looks like it is about to make a decision, the
 * decision belongs further down.
 *
 * RUN IDS CONTAIN A SLASH, so they travel as a query parameter rather than in
 * the path. `/api/run?id=root-health/e001-...` is unambiguous;
 * `/api/runs/root-health/e001-.../script` needs a parser that guesses where
 * the id stops, and the guess is wrong the first time a channel is called
 * "script".
 *
 * NOTHING HERE SPENDS WITHOUT SAYING SO. The two routes that cost money - start
 * a run, approve a run - are POSTs that return a job to watch, and both are
 * refused if one is already in flight for that run.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { loadPersona } from '../canon/load';
import { loadFormat } from '../formats/load';
import { episodeBudgetPence, writerConfig } from '../config';
import { AnthropicClient } from '../models/client';
import { buildDeps, priorEpisodeTexts } from '../deps';
import { runEpisode } from '../pipeline/episode';
import { runFiction } from '../pipeline/fiction';
import { cutStories } from '../pipeline/anthology';
import { regate } from '../qa/regate';
import { Run } from '../run/store';
import { loadTopics } from '../schedule/load';
import { blocking, findCovered, loadCatalogue, recordMade, refusal } from '../catalogue/covered';
import { hasNewsDesk } from '../news/desk';
import { Script, scriptBeatSchema, scriptSchema } from '../script/write';
import { catalogue, channel, runs, runSummary } from './catalog';
import { jobs, jobId } from './jobs';
import { suggestTopics } from './suggest';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const openRun = (id: string | null): Run => {
  if (!id) throw new HttpError(400, 'a run id is required');
  try {
    return Run.open(id);
  } catch {
    throw new HttpError(404, `no run "${id}"`);
  }
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const getCatalogue = () => ({ lanes: catalogue() });

export const getChannel = (id: string) => {
  const summary = channel(id);
  if (!summary) throw new HttpError(404, `no channel "${id}"`);

  const queue = loadTopics(id);
  return {
    channel: summary,
    // BOTH QUEUES, because they are different kinds of thing and the interface
    // has to offer the right one for the route being taken.
    topics: queue.topics,
    sets: queue.sets,
    runs: runs({ channelId: id, limit: 50, live: jobs.liveRunIds() }),
    budgetPence: episodeBudgetPence(),
  };
};

export const getRuns = (channelId: string | null) => ({
  runs: runs({ channelId: channelId ?? undefined, limit: 200, live: jobs.liveRunIds() }),
});

/**
 * One run, with everything a detail page needs in a single request.
 *
 * ONE REQUEST ON PURPOSE. A page that fetches the manifest, then the script,
 * then the gate, then the claims shows four loading states and can render three
 * of them against a run that has moved on since the first. The whole thing is
 * small - a script is a few thousand words - and it is read off local disk.
 */
export const getRun = (id: string) => {
  const run = openRun(id);
  const job = jobs.forRun(run.id);

  const read = <T>(stage: Parameters<Run['hasArtifact']>[0], schema: z.ZodType<T, z.ZodTypeDef, unknown>): T | null => {
    try {
      return run.hasArtifact(stage) ? run.readArtifact(stage, schema) : null;
    } catch {
      return null;
    }
  };

  const loose = z.record(z.unknown());

  return {
    run: runSummary(run, jobs.liveRunIds()),
    manifest: run.manifest,
    script: read('script', scriptSchema),
    gate: read('qa', loose),
    brief: read('brief', loose),
    claims: read('claims', z.object({ claims: z.array(loose).default([]) }).passthrough()),
    corpus: read(
      'corpus',
      z
        .object({
          sources: z
            .array(z.object({ id: z.string(), url: z.string(), title: z.string().optional(), tier: z.string().optional() }).passthrough())
            .default([]),
          rejected: z.array(loose).default([]),
        })
        .passthrough()
    ),
    render: read('render', loose),
    // The shorts cut from this run, so a source run's page can list its output.
    cuts: Run.derivedFrom(run.id).map((r) => runSummary(r, jobs.liveRunIds())),
    // WHETHER THIS IS A SOURCE, decided here rather than guessed in the
    // browser. A cut short carries its source's formatId, so anything matching
    // on the format alone calls every short a source and offers to cut it into
    // ten more. What separates them is `story`: a source has none, and every
    // run cut out of one has its own.
    isSource: loadFormat(run.manifest.formatId).sourceOnly && run.manifest.story === undefined,
    job: job ?? null,
    hasAudio: fs.existsSync(path.join(run.dir, 'media', 'episode.wav')),
    // WHERE IT WILL SIT ON THE APP, so the page can name its picture right: an
    // episode of a series, or a loose audiocard. Shorts are always cards.
    inSeries: inSeriesFor(run),
  };
};

const inSeriesFor = (run: Run): boolean => {
  if (loadFormat(run.manifest.formatId).kind === 'short') return false;
  if (run.manifest.seriesTitle) return true;
  try {
    return Boolean(loadPersona(run.manifest.personaId).publishesAsSeries);
  } catch {
    // A run from a channel that no longer exists: it is not going anywhere.
    return false;
  }
};

export const getJob = (id: string) => {
  const job = jobs.get(id);
  if (!job) throw new HttpError(404, `no job "${id}"`);
  return { job };
};

/** The rendered episode, streamed, so a page can put it in an audio element. */
export const audioPath = (id: string): string => {
  const run = openRun(id);
  const file = path.join(run.dir, 'media', 'episode.wav');
  if (!fs.existsSync(file)) throw new HttpError(404, `run "${id}" has no audio yet`);
  return file;
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export const startRunSchema = z.object({
  channelId: z.string().min(1),
  formatId: z.string().min(1),
  topic: z.string().min(1),
  /** Off by default here, unlike the command line: a web button is easy to press. */
  renderNow: z.boolean().default(false),
  /** The interface's `--again`. Off by default, for the same reason. */
  again: z.boolean().default(false),
  /** The interface's `--series`: the series a long episode is filed into. */
  seriesTitle: z.string().trim().min(1).optional(),
});

/**
 * Start a run and return immediately with a job to watch.
 *
 * HELD BEFORE THE RENDER unless somebody explicitly asked otherwise, which is
 * the same rule the command line follows and for the same reason: rendering is
 * the only irreversible spend, and a button is easier to press than a command
 * is to type.
 */
export const startRun = (body: unknown, who: string | null = null) => {
  const input = startRunSchema.parse(body);
  const persona = loadPersona(input.channelId);
  const format = loadFormat(input.formatId);

  if (!persona.formats.includes(format.id)) {
    throw new HttpError(400, `${persona.name} does not make "${format.id}"`);
  }

  // THE SAME REFUSAL THE COMMAND LINE MAKES, and it has to be here rather than
  // only in the page. A check that lives in one front end is a rule the other
  // does not have, and the interface would then warn about a duplicate while
  // happily making it. Skipped for fiction and news for the reason covered.ts
  // gives: both reuse one topic string for every episode they ever make.
  const deduped = !persona.fiction && !hasNewsDesk(persona.id);
  if (deduped && !input.again) {
    const blocked = blocking(findCovered(loadCatalogue(), persona.id, input.topic));
    if (blocked.length) throw new HttpError(409, refusal(persona.id, input.topic, blocked));
  }

  const run = Run.create({
    personaId: persona.id,
    formatId: format.id,
    topic: input.topic,
    onePass: true,
    holdForApproval: !input.renderNow && !format.sourceOnly,
    seriesTitle: format.kind === 'short' ? undefined : input.seriesTitle,
  });

  // Recorded at creation rather than on success, as the command line does: a
  // subject recorded only when a run finishes means a failing show retries it
  // forever, spending money each time.
  if (deduped) recordMade(persona.id, input.topic, run.id);

  // WHO ASKED FOR IT. A studio several people can reach needs its journal to
  // say which of them started something that costs money.
  if (who) run.journal({ stage: 'pipeline', event: `started by ${who}` });

  const job = jobs.start({
    id: jobId('run', run.id),
    kind: 'run',
    runId: run.id,
    work: async (report) => {
      const deps = buildDeps({
        log: (message, stage) => report(stage ?? 'pipeline', message),
        next: (lines) => lines.forEach((line) => report('next', line)),
      });
      deps.priorTexts = priorEpisodeTexts(run.id);

      if (persona.fiction) await runFiction({ run }, deps);
      else await runEpisode(run, deps);
      return [run.id];
    },
  });

  return { runId: run.id, jobId: job.id };
};

/**
 * Release a held run, then carry on into the render.
 *
 * The approval and the work are one request because they are one intention.
 * Splitting them would leave a run approved but not started, which looks
 * finished in a listing and has no audio.
 */
export const approveRun = (id: string, who: string | null = null) => {
  const run = openRun(id);

  if (!run.manifest.holdForApproval) throw new HttpError(400, `run "${id}" was not held`);
  if (jobs.isRunning(jobs.forRun(run.id)?.id ?? '')) {
    throw new HttpError(409, `run "${id}" is already working`);
  }
  if (!run.hasArtifact('script')) throw new HttpError(400, `run "${id}" has no script to approve`);

  if (!run.manifest.approvedAt) {
    run.approve();
    run.journal({
      stage: 'pipeline',
      event: who ? `approved in the studio by ${who}` : 'approved in the studio',
    });
  }

  const persona = loadPersona(run.manifest.personaId);
  const job = jobs.start({
    id: jobId('run', run.id),
    kind: 'run',
    runId: run.id,
    work: async (report) => {
      const deps = buildDeps({
        log: (message, stage) => report(stage ?? 'pipeline', message),
        next: (lines) => lines.forEach((line) => report('next', line)),
      });
      deps.priorTexts = priorEpisodeTexts(run.id);

      if (persona.fiction) await runFiction({ run }, deps);
      else await runEpisode(run, deps);
      return [run.id];
    },
  });

  return { runId: run.id, jobId: job.id };
};

/** Cut every story out of a source run, each into its own run. */
export const cutShorts = (id: string, body: unknown, who: string | null = null) => {
  const run = openRun(id);
  const only = z
    .object({ only: z.array(z.number().int().positive()).default([]) })
    .parse(body ?? {}).only;

  if (!run.hasArtifact('script')) throw new HttpError(400, `run "${id}" has no script to cut`);

  if (who) run.journal({ stage: 'shorts', event: `cut by ${who}` });

  const job = jobs.start({
    id: jobId('shorts', run.id),
    kind: 'shorts',
    runId: run.id,
    work: async (report) => {
      const results = await cutStories(
        { source: run, only },
        buildDeps({ log: (message, stage) => report(stage ?? 'shorts', message) })
      );
      return results.map((r) => r.run.id);
    },
  });

  return { runId: run.id, jobId: job.id };
};

export const saveScriptSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  beats: z.array(scriptBeatSchema).min(1),
});

/**
 * Save an edited script, and re-gate it immediately.
 *
 * RE-GATING IS FREE AND RE-RENDERING IS NOT, which is the whole shape of this.
 * The gate is deterministic arithmetic over the script and the ledger, so it
 * costs nothing and can run on every save; audio costs money, so it stays an
 * explicit act.
 *
 * WHICH MEANS A SAVED EDIT INVALIDATES THE AUDIO, and saying so is this
 * function's real job. A run whose script has changed since it was voiced has a
 * gate report about words nobody will hear. The render artifact is dropped so
 * the run reads as needing one, rather than silently keeping a duration
 * measured from a file that no longer matches.
 */
export const saveScript = (id: string, body: unknown) => {
  const run = openRun(id);
  const edited = saveScriptSchema.parse(body);

  const before = run.readArtifact('script', scriptSchema);
  const script: Script = { ...before, ...edited };

  const changed =
    JSON.stringify(before.beats.map((b) => b.turns)) !==
    JSON.stringify(script.beats.map((b) => b.turns));

  run.writeArtifact('script', script);
  run.journal({
    stage: 'script',
    event: changed ? 'edited in the studio' : 'saved in the studio, prose unchanged',
  });

  // The audio is now about different words. Dropping the artifact is what makes
  // the run honest about that; the media file is left alone, because
  // renderScript compares the script before reusing it.
  if (changed && run.hasArtifact('render')) {
    fs.rmSync(path.join(run.dir, 'render.json'), { force: true });
    run.uncomplete('render');
    run.uncomplete('qa');
    run.journal({ stage: 'render', event: 'discarded: the script changed under it' });
  }

  return { run: runSummary(run, jobs.liveRunIds()), gate: regate(run, script), audioStale: changed };
};

/**
 * Run the gate over what is on disk now, spending nothing.
 *
 * Returns null where a run genuinely cannot be gated yet - a script with no
 * verification behind it has no ledger to check - rather than inventing a
 * passing report, which would be the most dangerous possible default.
 */
export const suggest = async (channelId: string, body: unknown) => {
  const input = z
    .object({ formatId: z.string().min(1), count: z.number().int().min(1).max(10).default(6) })
    .parse(body ?? {});

  const persona = loadPersona(channelId);
  const format = loadFormat(input.formatId);
  const queue = loadTopics(channelId);

  const writer = writerConfig();
  const made = runs({ channelId }).map((r) => r.topic);

  const { suggestions } = await suggestTopics(
    {
      persona,
      format,
      queued: format.sourceOnly ? queue.sets : queue.topics,
      made: [...new Set(made)].slice(0, 30),
      count: input.count,
    },
    new AnthropicClient(writer.model, writer.apiKey)
  );

  return { suggestions };
};
