/**
 * The things that reach the platform, driven from the studio.
 *
 * WHY THESE ARE NOT IN routes.ts. Everything there loads something, calls
 * something, and serialises the answer. Everything here changes the world
 * outside this machine: it creates an account somebody can follow, publishes
 * audio that notifies followers, or starts a run that spends money. That is a
 * different kind of thing and it is worth being able to see all of it on one
 * screen.
 *
 * EVERY ONE OF THEM IS THE SAME CODE THE COMMAND LINE RUNS. Not a re-
 * implementation: setUpChannel, the AudioVibe client, currentPlan. A studio
 * button that took a slightly different path would be a second pipeline nobody
 * tested, and the first time it differed would be in production.
 *
 * PRODUCTION IS NAMED, NEVER ASSUMED. Each of these reports which platform it
 * is about to touch, and the interface says so before the button is pressed.
 * The command line asks for --yes; the studio shows the hostname in red. Both
 * are the same rule: publishing somewhere you did not mean to cannot be undone.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { loadPersona } from '../canon/load';
import { platformUrl } from '../config';
import { setUpChannel } from '../pipeline/channel';
import { AudioVibeClient } from '../publish/ingest';
import {
  accountsPath,
  loadAccounts,
  publishTokenFor,
  saveAccounts,
} from '../publish/account';
import { findSeries, recordSeries } from '../publish/seriesRegistry';
import { paletteFor, renderCover, SERIES_COVER_SIZE } from '../art/cover';
import { currentPlan } from '../schedule/current';
import { dueForRelease, releaseDue } from '../publish/release';
import { releasingEnabled } from './calendar';
import { loadSchedule } from '../schedule/load';
import { allocate, type ItemKind, type Taken } from '../schedule/allocate';
import { publishRun } from '../publish/publishRun';
import { regate } from '../qa/regate';
import { Run } from '../run/store';
import { scriptSchema } from '../script/write';
import { HttpError } from './routes';
import { runs } from './catalog';
import { jobs } from './jobs';

/** Where this studio is pointed, and whether that is the real thing. */
export const getPlatform = () => {
  try {
    const { url, isProduction } = platformUrl();
    return { url, isProduction, configured: true };
  } catch {
    // No AUDIOVIBE_API_URL. Every button that needs one is disabled rather
    // than failing when pressed.
    return { url: null, isProduction: false, configured: false };
  }
};

/**
 * Create a channel on the platform: account, profile, avatar, cover.
 *
 * A JOB RATHER THAN A REQUEST, because it makes two HTTP calls to an image
 * model and four to the platform, and a page that showed a spinner for ninety
 * seconds with no idea which of those was happening would be worse than the
 * command line it replaces.
 */
export const setUpChannelJob = (channelId: string, body: unknown) => {
  const input = z
    .object({
      // Optional: needed only to create the account. A redraw signs in as the
      // channel with the password this studio already holds.
      adminEmail: z.string().optional(),
      adminPassword: z.string().optional(),
      redraw: z.boolean().default(false),
    })
    .parse(body ?? {});

  const persona = loadPersona(channelId);
  const id = `channel-setup:${channelId}`;

  if (jobs.isRunning(id)) throw new HttpError(409, `${persona.name} is already being set up`);

  const job = jobs.start({
    id,
    kind: 'channel',
    runId: channelId,
    work: async (report) => {
      const result = await setUpChannel(channelId, input.adminEmail, input.adminPassword, {
        redraw: input.redraw,
        log: (message, stage) => report(stage ?? 'account', message),
      });

      report('account', `@${result.account.username} is on ${getPlatform().url}`);
      if (!result.account.ingestToken) {
        // The one step this cannot do. Said here so it appears in the job log
        // beside everything that did work, rather than being something the
        // person has to know to go and look for.
        report(
          'account',
          `it cannot publish yet: mint a token on the API server with ` +
            `"node dist/scripts/mintIngestToken.js --username ${result.account.username}"`
        );
      }
      return [channelId];
    },
  });

  return { jobId: job.id };
};

/**
 * Record the publishing credential a person minted on the server.
 *
 * THE USER ID IN THE TOKEN IS CHECKED against the channel it is being filed
 * under. Pasting one show's token into another's row otherwise surfaces as a
 * month of episodes appearing in the wrong account, which is not recoverable by
 * editing a file here.
 */
export const recordToken = (channelId: string, body: unknown) => {
  const token = z.object({ token: z.string().min(1) }).parse(body ?? {}).token.trim();

  const accounts = loadAccounts();
  const account = accounts[channelId];
  if (!account) throw new HttpError(400, `no account for ${channelId}. Set the channel up first.`);

  // Read, not verified: the signing secret lives on the server and this machine
  // has no business holding it. Reading the id catches the mistake this exists
  // for.
  let claimed: { userId?: unknown; scope?: unknown };
  try {
    const payload = token.split('.')[1] ?? '';
    claimed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, 'that does not look like a token');
  }

  if (claimed.scope !== 'ingest') {
    throw new HttpError(400, `that token's scope is "${String(claimed.scope)}", not "ingest"`);
  }
  if (typeof claimed.userId === 'string' && claimed.userId !== account.userId) {
    throw new HttpError(
      400,
      `that token publishes as ${claimed.userId}, but ${channelId} is ${account.userId}`
    );
  }

  account.ingestToken = token;
  accounts[channelId] = account;
  saveAccounts(accounts);

  return { ok: true as const, handle: account.username, file: accountsPath() };
};

/**
 * Create the series a show publishes into. Once per show per platform.
 *
 * NOT IDEMPOTENT, which is why it is a button somebody presses rather than
 * something a publish does when the registry looks empty. A publish that
 * quietly created a series would fork the show across two shelves the first
 * time the registry was unreadable.
 */
export const createSeriesJob = (channelId: string) => {
  const persona = loadPersona(channelId);
  const platform = getPlatform();

  if (!platform.configured) throw new HttpError(400, 'AUDIOVIBE_API_URL is not set');
  if (!persona.publishesAsSeries) {
    throw new HttpError(400, `${persona.name} publishes loose episodes, not a series`);
  }

  const existing = findSeries(persona.id, platform.url!);
  if (existing) throw new HttpError(409, `${persona.name} already publishes into ${existing.title}`);

  const id = `series:${channelId}`;
  if (jobs.isRunning(id)) throw new HttpError(409, 'already creating it');

  const job = jobs.start({
    id,
    kind: 'series',
    runId: channelId,
    work: async (report) => {
      report('series', `creating a series for ${persona.name} on ${platform.url}`);

      // 16:9, the frame the platform crops series to. A square one would keep
      // the middle band and shave the wordmark off the top and bottom.
      const coverPath = renderCover(
        { showName: persona.name, title: persona.name, palette: paletteFor(persona.id) },
        path.join(os.tmpdir(), `foundry-series-${persona.id}.png`),
        SERIES_COVER_SIZE
      );

      const client = new AudioVibeClient(platform.url!, publishTokenFor(persona.id));
      const created = await client.createSeries({
        title: persona.name,
        description: persona.thesis.trim().replace(/\s+/g, ' '),
        category: persona.category,
        coverPath,
      });

      recordSeries(persona.id, {
        seriesId: created.seriesId,
        title: created.title,
        apiUrl: platform.url!,
        createdAt: new Date().toISOString(),
      });

      report('series', `series ${created.seriesId} - "${created.title}"`);
      return [channelId];
    },
  });

  return { jobId: job.id };
};

/**
 * Put a finished run on the platform.
 *
 * THE SAME FUNCTION THE COMMAND LINE CALLS, including every refusal in it. The
 * studio does not get a shortcut past the gate, past a human-review flag, or
 * past the production check: `confirmed` is the person pressing the second
 * button, exactly as `--yes` is the person typing it.
 */
export const publishRunJob = (runId: string, body: unknown, who: string | null = null) => {
  const confirmed = z.object({ confirmed: z.boolean().default(false) }).parse(body ?? {}).confirmed;

  const run = Run.open(runId);
  const gate = regate(run, run.readArtifact('script', scriptSchema));
  if (!gate) throw new HttpError(400, `run "${runId}" cannot be gated, so it cannot be published`);

  const id = `publish:${runId}`;
  if (jobs.isRunning(id)) throw new HttpError(409, 'already publishing');

  // CHECKED BEFORE THE JOB STARTS, not inside it. A refusal is an answer to the
  // button that was just pressed, and a person who gets a job id and then has
  // to read a log to find out their publish was declined has been told badly.
  if (!gate.passed) {
    throw new HttpError(400, 'this run did not pass the gate');
  }
  if (gate.needsHumanReview && !confirmed) {
    throw new HttpError(428, `needs a human first: ${gate.humanReviewReasons.join('; ')}`);
  }
  if (getPlatform().isProduction && !confirmed) {
    throw new HttpError(428, `${getPlatform().url} is PRODUCTION`);
  }

  if (who) run.journal({ stage: 'publish', event: `published by ${who}` });

  const job = jobs.start({
    id,
    kind: 'publish',
    runId,
    work: async (report) => {
      await publishRun(run, gate, { confirmed, report: (m) => report('publish', m) });
      return [runId];
    },
  });

  return { jobId: job.id };
};

/**
 * What the schedule says to make next, made.
 *
 * ONE ITEM, exactly as `tick` does. A button that drained the whole plan would,
 * on a studio three weeks behind, spend fifteen pounds before anybody saw the
 * first result - and if something were wrong it would be wrong fifteen times.
 */
export const nextDue = () => {
  const plan = currentPlan();
  return {
    next: plan.due[0] ?? null,
    blocked: plan.blocked,
    waiting: plan.waiting.map((w) => ({ ...w, at: w.at.toISOString() })),
  };
};

/**
 * Approve runs to go out, and give them days within what the channel can hold.
 *
 * APPROVING IS A DECISION, NOT A SCHEDULE. It says "this may go out"; when is
 * arithmetic, done here, and the answer is often "in three weeks" - because a
 * channel that publishes three shorts a week publishes three shorts a week
 * however many are approved at once.
 *
 * PER CHANNEL, AND IT REFUSES ANYTHING ELSE. Approving one show must never
 * reach into another's schedule, which an earlier version did by clearing
 * "everything not in this list" across every channel at once.
 *
 * ALREADY-APPROVED RUNS KEEP THEIR DAYS. They are counted as capacity already
 * spent, so approving two more adds two to the end rather than reshuffling a
 * fortnight somebody has already read.
 */
export const approveForRelease = (
  channelId: string,
  body: unknown,
  who: string | null = null
) => {
  const { runIds } = z.object({ runIds: z.array(z.string()).min(1) }).parse(body ?? {});

  const persona = loadPersona(channelId);
  const schedule = loadSchedule();
  const cadence = schedule.shows[channelId];

  if (!cadence) {
    throw new HttpError(400, `${persona.name} is not in schedule.yaml, so it has no cadence`);
  }

  const foreign = runIds.filter((id) => id.split('/')[0] !== channelId);
  if (foreign.length) {
    throw new HttpError(400, `not ${persona.name}'s runs: ${foreign.join(', ')}`);
  }

  const mine = runs({ channelId, limit: 400 });
  const kindOf = (runId: string): ItemKind => {
    const summary = mine.find((r) => r.id === runId);
    return summary && summary.short !== null ? 'short' : 'episode';
  };

  // Weeks already spoken for stay spoken for.
  const taken: Taken[] = mine
    .filter((r) => r.releaseAt && !runIds.includes(r.id) && r.state !== 'published')
    .map((r) => ({ kind: kindOf(r.id), at: new Date(r.releaseAt!) }));

  const placed = allocate({
    cadence,
    items: runIds.map((runId) => ({ runId, kind: kindOf(runId) })),
    taken,
    from: new Date(),
    timezone: schedule.timezone,
  });

  const approvedAt = new Date();
  for (const p of placed) {
    const run = Run.open(p.runId);
    run.setReleaseAt(p.at, approvedAt);
    // WHO SAID YES. This approval is what later lets the releaser publish
    // without anybody present, so the journal has to name the person whose
    // decision that was.
    run.journal({
      stage: 'publish',
      event: `approved for ${p.at.toISOString()}${who ? ` by ${who}` : ''}`,
    });
  }

  // A kind the channel has no capacity for gets no day at all, and saying so
  // beats leaving somebody to wonder why it never reached the calendar.
  const unscheduled = runIds.filter((id) => !placed.some((p) => p.runId === id));

  return {
    approved: placed.map((p) => ({ runId: p.runId, releaseAt: p.at.toISOString(), kind: p.kind })),
    unscheduled,
    perWeek: cadence.perWeek,
    timezone: schedule.timezone,
  };
};

/**
 * Take something off the schedule.
 *
 * FROM THE CALENDAR, AND ONLY THERE. Approving is a decision made while reading
 * one episode; cancelling is one made while looking at a month. Putting both on
 * the same control would make a tick box mean two different things depending on
 * which way it was going.
 */
export const cancelRelease = (runId: string) => {
  const run = Run.open(runId);

  if (run.isComplete('publish')) {
    throw new HttpError(400, 'that is already published, so there is nothing to cancel');
  }
  if (!run.manifest.releaseAt) throw new HttpError(400, 'that is not scheduled');

  run.setReleaseAt(null);
  return { ok: true as const, runId };
};

/**
 * Ask the platform whether an episode is really there.
 *
 * WHY NOT TRUST THE PUBLISH. The publish returns an id and this studio writes
 * it down, and that is one system's word for what another system did. Between
 * them are an upload, a transcode, a safety check and a fan-out, any of which
 * can leave a row that exists and is not playable - and the studio would go on
 * reporting it as published forever, because its own file says so.
 *
 * SO IT ASKS. One GET against the public endpoint a listener would hit, which
 * is the same question a listener asks by tapping the card.
 */
export const verifyPublished = async (runId: string) => {
  const run = Run.open(runId);

  if (!run.isComplete('publish')) {
    return { published: false as const, reason: 'this studio has not published it' };
  }

  const artifact = run.readArtifact(
    'publish',
    z.object({ audioId: z.string(), publishedAt: z.string().optional() }).passthrough()
  );

  const platform = getPlatform();
  if (!platform.configured) {
    return { published: true as const, checked: false as const, audioId: artifact.audioId };
  }

  try {
    // `/api/audios/<id>`, PLURAL. The singular form 404s for everything, so
    // this reported every healthy episode as "the platform has no such audio"
    // - a check that always fails is worse than no check, because it teaches
    // people to ignore it. The publishing routes next door are plural too.
    const res = await fetch(`${platform.url}/api/audios/${artifact.audioId}`);
    const body = (await res.json().catch(() => null)) as {
      data?: { audio?: Record<string, unknown> } | Record<string, unknown>;
    } | null;

    if (res.status === 404) {
      return {
        published: true as const,
        checked: true as const,
        live: false as const,
        audioId: artifact.audioId,
        reason: 'the platform has no such audio',
      };
    }
    if (!res.ok) {
      return {
        published: true as const,
        checked: true as const,
        live: false as const,
        audioId: artifact.audioId,
        reason: `the platform answered ${res.status}`,
      };
    }

    const audio = ((body?.data as { audio?: Record<string, unknown> })?.audio ??
      body?.data ??
      {}) as Record<string, unknown>;

    return {
      published: true as const,
      checked: true as const,
      live: true as const,
      audioId: artifact.audioId,
      publishedAt: artifact.publishedAt ?? null,
      title: typeof audio.title === 'string' ? audio.title : null,
      // The label a listener sees. Worth confirming from the platform rather
      // than assuming, since it is the one claim this studio makes to everybody.
      isAi: audio.is_ai_generated === true,
      status: typeof audio.status === 'string' ? audio.status : null,
    };
  } catch (err) {
    return {
      published: true as const,
      checked: false as const,
      audioId: artifact.audioId,
      reason: (err as Error).message,
    };
  }
};

/**
 * Park something, or take it off the shelf.
 *
 * An episode can pass every check and still not be one to publish this week.
 * Without somewhere to put those, the only choices are publish it or leave it
 * cluttering the list you are deciding from - and both are how something goes
 * out by accident.
 */
export const setHold = (runId: string, body: unknown) => {
  const { held } = z.object({ held: z.boolean() }).parse(body ?? {});
  const run = Run.open(runId);

  if (run.isComplete('publish')) throw new HttpError(400, 'that is already published');

  run.setHeld(held);
  return { ok: true as const, runId, held };
};

/**
 * Publish whatever is due right now, by hand.
 *
 * The same code the timer runs, so "why did nothing go out" can be answered by
 * pressing a button and reading the reasons rather than by reading a log.
 */
export const releaseNow = async () => {
  const result = await releaseDue(new Date());
  return result;
};

/** What is due and what is held back, costing nothing. */
export const releaseStatus = () => {
  const plan = dueForRelease();
  return {
    enabled: releasingEnabled(),
    due: plan.due.map((d) => ({ ...d, releaseAt: d.releaseAt.toISOString(), approvedAt: d.approvedAt.toISOString() })),
    held: plan.held,
  };
};

/**
 * Re-gate one channel's runs and keep the answer.
 *
 * WHY THIS IS NEEDED AT ALL. A run's state comes from the gate report stored
 * beside it, which was written the day it was made. Every time a check changes,
 * every stored report is a little more out of date - and the direction that
 * hurts is a run that passes today still reading as rejected, because nothing
 * will ever look at it again. One short sat as `failed` through the whole
 * clean-up for exactly that reason, invisible among real failures.
 *
 * SAFE TO RUN ON EVERY PAGE LOAD. The gate is deterministic arithmetic over the
 * script and the ledger with no model calls, so re-checking a channel costs
 * nothing but a few file reads. Only reports that actually changed are written.
 *
 * IT NEVER RE-RENDERS OR RE-WRITES. This settles what the current checks think
 * of what is already on disk, and nothing else.
 */
export const recheckChannel = (channelId: string) => {
  const changed: Array<{ runId: string; from: boolean; to: boolean }> = [];

  for (const summary of runs({ channelId, limit: 400 })) {
    const run = Run.open(summary.id);
    if (!run.hasArtifact('script') || !run.hasArtifact('qa')) continue;

    const before = summary.gate?.passed ?? false;
    const fresh = regate(run, run.readArtifact('script', scriptSchema));
    if (!fresh) continue;

    if (fresh.passed !== before) {
      run.writeArtifact('qa', fresh);
      changed.push({ runId: summary.id, from: before, to: fresh.passed });
    }
  }

  return { rechecked: true as const, changed };
};

/** Delete a run and everything in it. Local only: it touches no platform. */
export const discardRun = (id: string) => {
  const dir = path.join(process.env.FOUNDRY_RUNS_DIR ?? 'runs', ...id.split('/'));
  if (!fs.existsSync(dir)) throw new HttpError(404, `no run "${id}"`);
  if (jobs.isRunning(jobs.forRun(id)?.id ?? '')) {
    throw new HttpError(409, `run "${id}" is working. Let it finish first.`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true as const };
};
