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
import { ignoreFinding, unignoreFinding, withOverrides } from '../qa/overrides';
import { finalAudioFor } from '../render/backing';
import { runProcess } from '../render/assemble';
import { musicLock } from '../render/backing';
import { syncTakes, takesView } from '../render/takes';
import { ELEVENLABS_PENCE_PER_1K_CHARS } from '../render/tts';
import { PENCE_PER_MCHAR as OPENAI_PENCE_PER_MCHAR } from '../render/openaiTts';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { loadPersona } from '../canon/load';
import { loadFormat } from '../formats/load';
import {
  episodeBudgetPence,
  episodeTargetPence,
  shortBudgetPence,
  shortTargetPence,
  writerConfig,
} from '../config';
import { AnthropicClient } from '../models/client';
import { buildDeps, buildTts, priorEpisodeTexts } from '../deps';
import { runLane } from '../pipeline/runLane';
import { PipelineDeps } from '../pipeline/episode';
import { budgetFor, targetFor } from '../pipeline/budget';
import { channelVoice } from '../canon/voiceMaster';
import { tagPass } from '../script/tagPass';
import { cutStories } from '../pipeline/anthology';
import { regate } from '../qa/regate';
import { Run, runLabel, stopRequests } from '../run/store';
import { readArchive } from '../archive/record';
import { COUNTRIES, MAX_COUNTRIES, countriesByName } from '../news/countries';
import { startHandwritten } from '../pipeline/handwritten';
import { loadTopics } from '../schedule/load';
import { blocking, findCovered, loadCatalogue, recordMade, refusal } from '../catalogue/covered';
import { hasNewsDesk, ROUNDUP_FORMAT, loadDesk, newsFormatFor } from '../news/desk';
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
    // A news channel takes an empty topic: today's rapid-fire roundup.
    newsRoundup: hasNewsDesk(id) && !!loadDesk(id).roundup,
    /** What the three country boxes offer. */
    countries: COUNTRIES.map((x) => x.name),
    // BOTH QUEUES, because they are different kinds of thing and the interface
    // has to offer the right one for the route being taken.
    topics: queue.topics,
    sets: queue.sets,
    runs: runs({ channelId: id, limit: 50, live: jobs.liveRunIds() }),
    budgetPence: episodeBudgetPence(),
    // BOTH NUMBERS, for both kinds: what each is meant to cost (a warning) and
    // the hard ceiling that stops it. The start form shows the one it will use.
    budgets: {
      short: { targetPence: shortTargetPence(), ceilingPence: shortBudgetPence() },
      episode: { targetPence: episodeTargetPence(), ceilingPence: episodeBudgetPence() },
    },
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
    gate: (() => {
      const g = read('qa', loose) as { passed: boolean; findings: Array<{ check: string; detail: string; blocking: boolean }> } | null;
      return g ? withOverrides(run, g) : null;
    })(),
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
    hasAudio: run.audioFile() !== null, // archive-aware: see archive/record.ts
    // WHERE IT WILL SIT ON THE APP, so the page can name its picture right: an
    // episode of a series, or a loose audiocard. Shorts are always cards.
    inSeries: inSeriesFor(run),
    /** Long form: belongs to a series. */
    long: loadFormat(run.manifest.formatId).kind !== 'short',
    voiceEstimate: voiceEstimateFor(read('script', scriptSchema)),
    takes: takesView(run),
  };
};

/**
 * Roughly what voicing the script costs on each engine, in pence, so the
 * button that spends can say so - and say whether it fits under the ceiling -
 * before it is pressed. Characters times each engine's own rate.
 */
const voiceEstimateFor = (script: Script | null): { chars: number; openai: number; elevenlabs: number } | null => {
  if (!script) return null;
  const chars = script.beats.reduce((n, b) => n + b.turns.reduce((m, t) => m + t.text.length, 0), 0);
  return {
    chars,
    openai: (chars / 1_000_000) * OPENAI_PENCE_PER_MCHAR,
    elevenlabs: (chars / 1000) * ELEVENLABS_PENCE_PER_1K_CHARS,
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
/**
 * The FINAL audio: exactly what publishing will send - the chosen music
 * version, or the voice alone. Every page plays this, so choosing music on one
 * page is what every other page hears.
 */
export const audioPath = (id: string): string => {
  const final = finalAudioFor(openRun(id));
  if (!final) throw new HttpError(404, `run "${id}" has no audio yet`);
  return final.file;
};

/** A name worth saving the final file under. */
export const audioDownloadName = (id: string): string => {
  const run = openRun(id);
  const m = run.manifest;
  let title = m.topic;
  try {
    title = run.readArtifact('script', scriptSchema).title;
  } catch {
    // No script title yet; the topic will do.
  }
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  const num = runLabel(run.id);
  const music = finalAudioFor(run)?.music ? '-with-music' : '';
  return `${m.personaId}-${num}-${slug}${music}.mp3`;
};

/**
 * The final audio as an MP3, for downloading.
 *
 * Encoded from the final WAV on request, at 192 kbps, and CACHED BY ITS KEY in
 * media/: a second download of the same audio is instant, and choosing other
 * music changes the key, so a stale MP3 is never handed out.
 */
export const audioDownloadFile = async (id: string): Promise<string> => {
  const run = openRun(id);
  // ARCHIVED: the MP3 was made before the audio went to R2.
  const archivedDownload = readArchive(run.dir)?.download;
  if (archivedDownload) return path.join(run.dir, archivedDownload);
  const final = finalAudioFor(run);
  if (!final) throw new HttpError(404, `run "${id}" has no audio yet`);

  const media = path.dirname(final.file);
  const out = path.join(media, `download-${final.key.replace(/[^a-z0-9-]/gi, '')}.mp3`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;

  const tmp = `${out}.${Date.now()}.part.mp3`;
  const res = await runProcess(process.env.FFMPEG_PATH ?? 'ffmpeg', [
    '-y', '-loglevel', 'error', '-i', final.file,
    '-codec:a', 'libmp3lame', '-b:a', '192k', tmp,
  ]);
  if (res.code !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
    fs.rmSync(tmp, { force: true });
    throw new HttpError(500, `could not make the MP3: ${res.stderr.slice(0, 200) || `ffmpeg exited ${res.code}`}`);
  }
  fs.renameSync(tmp, out);

  // Earlier downloads of audio that has since changed: tidy, quietly.
  for (const name of fs.readdirSync(media)) {
    if (name.startsWith('download-') && path.join(media, name) !== out) {
      try {
        fs.rmSync(path.join(media, name), { force: true });
      } catch {
        // Still being sent somewhere. Next time.
      }
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export const startRunSchema = z.object({
  channelId: z.string().min(1),
  formatId: z.string().min(1),
  /** Empty only on a news channel, where it means today's rapid fire. */
  topic: z.string(),
  /** Off by default here, unlike the command line: a web button is easy to press. */
  renderNow: z.boolean().default(false),
  /** The interface's `--again`. Off by default, for the same reason. */
  again: z.boolean().default(false),
  /** The interface's `--series`: the series a long episode is filed into. */
  seriesTitle: z.string().trim().min(1).optional(),
  /** A blank template to fill in by hand, instead of paying for research and writing. */
  blank: z.boolean().default(false),
  /** A rapid fire's countries, up to three. None: the desk's own regions. */
  countries: z.array(z.string().min(1)).max(MAX_COUNTRIES).default([]),
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

  // NEWS: no topic means the desk's beat, which is the rapid-fire roundup; a
  // topic is the in-depth short on that one story. See news/desk.ts.
  const desk = hasNewsDesk(persona.id) ? loadDesk(persona.id) : null;
  if (desk && !input.topic.trim()) input.topic = desk.beat;
  if (!input.topic.trim()) throw new HttpError(400, 'give it a topic');
  const format = loadFormat(desk ? newsFormatFor(desk, input.topic, input.formatId) : input.formatId);

  const countries = [...new Set(input.countries)];
  if (countries.length && format.id !== ROUNDUP_FORMAT) {
    throw new HttpError(400, 'countries are for the rapid fire: leave the topic empty');
  }
  try {
    countriesByName(countries);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }

  if (format.id !== ROUNDUP_FORMAT && !persona.formats.includes(format.id)) {
    throw new HttpError(400, `${persona.name} does not make "${format.id}"`);
  }
  // EVERY EPISODE BELONGS TO A SERIES (owner, 2026-10-05), so a listener who
  // finishes one finds the next. Shorts and news reports stay loose.
  if (format.kind !== 'short' && !format.sourceOnly && !input.seriesTitle?.trim()) {
    throw new HttpError(400, 'an episode needs a series: choose one, or name a new one');
  }

  if (input.blank && format.sourceOnly) {
    throw new HttpError(400, 'a set is cut into shorts; write the shorts instead');
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
    holdForApproval: input.blank || (!input.renderNow && !format.sourceOnly),
    seriesTitle: format.kind === 'short' ? undefined : input.seriesTitle,
    handwritten: input.blank,
    countries,
  });

  // Recorded at creation rather than on success, as the command line does: a
  // subject recorded only when a run finishes means a failing show retries it
  // forever, spending money each time.
  if (deduped) recordMade(persona.id, input.topic, run.id);

  // WHO ASKED FOR IT. A studio several people can reach needs its journal to
  // say which of them started something that costs money.
  if (who) run.journal({ stage: 'pipeline', event: `started by ${who}` });

  // A BLANK IS MADE HERE AND NOW: there is nothing to run, so no job.
  if (input.blank) {
    startHandwritten(run);
    return { runId: run.id, jobId: null };
  }

  return runLaneJob(run, who);
};

/**
 * Run (or carry on) a run's own lane as a studio job. Every stage is
 * checkpointed, so on a run that already has work it picks up where it stopped.
 */
/**
 * The optional tag pass, once, before the voice: only on ElevenLabs, only when
 * asked, only on a script not yet voiced. See script/tagPass.ts.
 */
const tagPassIfAsked = async (run: Run, deps: PipelineDeps, say: (m: string) => void) => {
  const m = run.manifest;
  if (m.voiceEngine !== 'elevenlabs' || !m.tagPass || m.tagPassAt) return;
  if (!run.hasArtifact('script') || run.isComplete('render')) return;
  const sound = channelVoice(m.personaId);
  if (!sound) {
    say('tag pass skipped: this channel is not in voice-master.yaml');
    return;
  }

  let pence = 0;
  const before = run.readArtifact('script', scriptSchema);
  const result = await tagPass(before, sound, deps.clerk ?? deps.writer, (p) => (pence += p));
  run.spend(pence, budgetFor(run), targetFor(run));
  run.writeArtifact('script', result.script);
  run.setTagPass(true, new Date());
  const detail =
    `${result.tagged} lines tagged, ${result.unchanged} left as written` +
    (result.rejected ? `, ${result.rejected} rejected because a word changed (originals kept)` : '');
  run.journal({ stage: 'script', event: 'tag pass', detail, pence });
  say(`tag pass: ${detail} (${pence.toFixed(1)}p)`);
};

// Refused before anything starts, so the button says why instead of a run that
// is approved, starts, and dies on its first voice call.
const assertEngineReady = (engine: 'openai' | 'elevenlabs') => {
  if (engine === 'elevenlabs' && !process.env.ELEVENLABS_API_KEY?.trim()) {
    throw new HttpError(400, 'ElevenLabs is not set up: ELEVENLABS_API_KEY is empty on this studio');
  }
};

/**
 * AT ITS HARD CEILING, NOTHING MORE IS SPENT ON A RUN (owner, 2026-10-08). A
 * voicing in progress is allowed to finish past it; after that every button
 * that would spend again (approve, voice, resume, regenerate) is refused here
 * and greyed on the page.
 */
export const assertUnderCeiling = (run: Run): void => {
  const ceiling = budgetFor(run);
  if (run.manifest.spentPence >= ceiling) {
    throw new HttpError(
      400,
      `this run has reached its hard ceiling (${run.manifest.spentPence.toFixed(1)}p of ${ceiling}p), ` +
        'so nothing more can be spent on it. Its takes can still be chosen and published.'
    );
  }
};

/** Stop the job working on a run, after the paid call it is in. */
export const stopRun = (id: string, who: string | null = null) => {
  const run = openRun(id);
  const job = jobs.forRun(run.id);
  if (!job || !jobs.isRunning(job.id)) throw new HttpError(409, 'nothing is working on this run');
  stopRequests.set(run.id, who ?? 'somebody');
  run.journal({ stage: 'pipeline', event: `stop requested${who ? ` by ${who}` : ''}` });
  return { ok: true as const, jobId: job.id };
};

const runLaneJob = (run: Run, who: string | null = null) => {
  assertEngineReady(run.manifest.voiceEngine);
  const job = jobs.start({
    id: jobId('run', run.id),
    kind: 'run',
    runId: run.id,
    by: who,
    work: async (report) => {
      const deps = buildDeps({
        log: (message, stage) => report(stage ?? 'pipeline', message),
        next: (lines) => lines.forEach((line) => report('next', line)),
        tts: buildTts(run.manifest.voiceEngine),
      });
      deps.priorTexts = priorEpisodeTexts(run.id);

      await tagPassIfAsked(run, deps, (m) => report('script', m));

      // The channel's own lane, as the command line runs it. See runLane.ts.
      await runLane(run, deps);
      // Every finished voicing is kept as a take. See render/takes.ts.
      syncTakes(run, who);
      return [run.id];
    },
  });

  return { runId: run.id, jobId: job.id };
};

/**
 * Carry on a run that stopped partway: the studio was closed, the machine
 * slept, a call failed. Same as the command line's `resume`, from a button.
 */
export const voiceEngineSchema = z
  .object({
    engine: z.enum(['openai', 'elevenlabs']).optional(),
    /** ElevenLabs only: add tags with one cheap call before voicing. */
    tagPass: z.boolean().optional(),
  })
  .default({});

/**
 * Switch the engine a run will be voiced on.
 *
 * NEVER TWO ENGINES IN ONE EPISODE. Beats already rendered are reused on a
 * resume, so a run that half-rendered on one engine and finished on the other
 * would change voice mid-episode. Changing the engine therefore deletes the
 * other engine's beats and discards any finished render.
 */
export const applyVoiceEngine = (run: Run, body: unknown, who: string | null) => {
  const { engine, tagPass } = voiceEngineSchema.parse(body ?? {});
  assertEngineReady(engine ?? run.manifest.voiceEngine);
  // THE TICK IS THE WHOLE ANSWER (owner, 2026-10-08). Unticked: voice the
  // script exactly as it is. Ticked: run the tag pass first, even if one ran
  // before - a box that greyed out once a pass had run could never be used
  // again on that run.
  if (tagPass !== undefined) {
    run.setTagPass(tagPass);
    if (tagPass && run.manifest.tagPassAt) run.forgetTagPass();
  }
  if (!engine || engine === run.manifest.voiceEngine) return;

  const media = path.join(run.dir, 'media');
  if (fs.existsSync(media)) {
    for (const name of fs.readdirSync(media)) {
      if (/^\d{2}-.+\.mp3(\.key)?$/.test(name)) fs.rmSync(path.join(media, name), { force: true });
    }
  }
  if (run.hasArtifact('render')) {
    fs.rmSync(path.join(run.dir, 'render.json'), { force: true });
    run.uncomplete('render');
    run.uncomplete('qa');
    run.noteRevoicing();
  }
  run.journal({
    stage: 'render',
    event: `voice engine set to ${engine}${who ? ` by ${who}` : ''}`,
  });
  run.setVoiceEngine(engine);
};

export const resumeRun = (id: string, who: string | null = null, body: unknown = {}) => {
  const run = openRun(id);
  if (jobs.isRunning(jobs.forRun(run.id)?.id ?? '')) {
    throw new HttpError(409, `run "${id}" is already working`);
  }
  if (run.isComplete('publish')) throw new HttpError(400, 'that is already published');
  if (run.manifest.abandoned) throw new HttpError(400, 'that run was discarded');
  assertUnderCeiling(run);
  applyVoiceEngine(run, body, who);
  run.journal({ stage: 'pipeline', event: who ? `resumed in the studio by ${who}` : 'resumed in the studio' });
  return runLaneJob(run, who);
};

/**
 * Release a held run, then carry on into the render.
 *
 * The approval and the work are one request because they are one intention.
 * Splitting them would leave a run approved but not started, which looks
 * finished in a listing and has no audio.
 */
export const approveRun = (id: string, who: string | null = null, body: unknown = {}) => {
  const run = openRun(id);

  if (!run.manifest.holdForApproval) throw new HttpError(400, `run "${id}" was not held`);
  if (jobs.isRunning(jobs.forRun(run.id)?.id ?? '')) {
    throw new HttpError(409, `run "${id}" is already working`);
  }
  if (!run.hasArtifact('script')) throw new HttpError(400, `run "${id}" has no script to approve`);
  assertUnderCeiling(run);

  applyVoiceEngine(run, body, who);
  if (!run.manifest.approvedAt) {
    run.approve();
    run.journal({
      stage: 'pipeline',
      event: who ? `approved in the studio by ${who}` : 'approved in the studio',
    });
  }

  return runLaneJob(run, who);
};

/**
 * Voice the same saved script again from nothing, as a new take.
 *
 * NEVER REPLACES: the current voice is kept as a take first, and the new one
 * is recorded beside it for a person to choose between (render/takes.ts).
 * Every beat is synthesised fresh - the files and their keys are deleted, or
 * the renderer would reuse them and "regenerate" the same audio for nothing.
 * Asked twice in the page; the server wants `confirm: true` as well.
 */
export const regenerateRun = (id: string, who: string | null = null, body: unknown = {}) => {
  const run = openRun(id);
  const { confirm } = z.object({ confirm: z.literal(true) }).passthrough().parse(body ?? {});
  void confirm;
  if (jobs.isRunning(jobs.forRun(run.id)?.id ?? '')) throw new HttpError(409, `run "${id}" is already working`);
  if (run.manifest.abandoned) throw new HttpError(400, 'that run was discarded');
  const lock = musicLock(run);
  if (lock) throw new HttpError(400, lock.replace('to change its music', 'to regenerate it'));
  if (!run.isComplete('render') || !run.isComplete('qa')) {
    throw new HttpError(400, 'there is no finished voice to regenerate yet: voice it first');
  }
  assertUnderCeiling(run);

  syncTakes(run, who); // the current voice is a take before anything changes
  applyVoiceEngine(run, body, who);

  const media = path.join(run.dir, 'media');
  if (fs.existsSync(media)) {
    for (const name of fs.readdirSync(media)) {
      if (/^\d{2}-.+\.mp3(\.key|\.retry)?$/.test(name)) fs.rmSync(path.join(media, name), { force: true });
    }
  }
  fs.rmSync(path.join(run.dir, 'render.json'), { force: true });
  run.uncomplete('render');
  run.uncomplete('qa');
  run.noteRegeneration();
  run.journal({ stage: 'render', event: `regenerating as a new take${who ? `, asked by ${who}` : ''}` });

  return runLaneJob(run, who);
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
    by: who,
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
  // WHAT WENT OUT IS FIXED: a title edited after publishing would never reach
  // the platform, and the studio would then disagree with the app.
  if (run.isComplete('publish')) throw new HttpError(400, 'that is already published, so its script and title are fixed');
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
  // the run honest about that. The beat files are left alone: renderScript
  // reuses one only when its `.key` (engine, voice and exact text) still
  // matches, so the unchanged beats cost nothing and the edited ones are made
  // again. (Until 2026-10-08 it reused by file name alone, and this comment
  // claimed otherwise.)
  if (changed && run.hasArtifact('render')) {
    fs.rmSync(path.join(run.dir, 'render.json'), { force: true });
    run.uncomplete('render');
    run.uncomplete('qa');
    run.noteRevoicing();
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

const findingBody = z.object({ check: z.string().min(1), detail: z.string().min(1) });

/**
 * Ignore one blocking gate finding, or stop ignoring it. A person's ruling,
 * recorded with who and when; refused once the run has gone out, because a
 * published episode's record is settled.
 */
export const setOverride = (id: string, body: unknown, ignore: boolean, who: string | null) => {
  const run = openRun(id);
  if (run.manifest.completed.includes('publish')) {
    throw new HttpError(409, 'this is already published, so its checks are settled');
  }
  const finding = findingBody.parse(body);
  if (ignore) ignoreFinding(run, finding, who);
  else unignoreFinding(run, finding, who);
  return { ok: true as const, run: runSummary(run, jobs.liveRunIds()) };
};
