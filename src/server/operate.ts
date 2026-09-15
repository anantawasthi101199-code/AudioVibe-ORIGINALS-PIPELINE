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
import { loadSchedule } from '../schedule/load';
import { atHourOn, planRelease } from '../schedule/slots';
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
    .object({ adminEmail: z.string().min(1), adminPassword: z.string().min(1) })
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
export const publishRunJob = (runId: string, body: unknown) => {
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
 * Give a batch of finished runs their release times.
 *
 * WHAT IT IS FOR. Ten shorts cut in one afternoon are all finished and all
 * publishable, and publishing them together is what makes a feed look like
 * somebody emptied a bucket into it. This spreads them one a day, at a
 * different hour each day, starting tomorrow.
 *
 * IDEMPOTENT AND REVERSIBLE. Running it again reassigns the same times, because
 * the hours are derived rather than random; clearing them puts everything back
 * to publishable-now. Neither is destructive, which is why this is a button
 * rather than something the cut does silently.
 */
export const scheduleRelease = (runId: string, body: unknown) => {
  const input = z.object({ clear: z.boolean().default(false) }).parse(body ?? {});

  const source = Run.open(runId);
  // Already sorted by story number, which is the order they were written in
  // rather than the order somebody happened to cut them.
  const cuts = Run.derivedFrom(runId);
  if (!cuts.length) throw new HttpError(400, `run "${runId}" has no cuts to schedule`);

  if (input.clear) {
    for (const cut of cuts) cut.setReleaseAt(null);
    return { scheduled: 0, cleared: cuts.length };
  }

  const schedule = loadSchedule();
  const cadence = schedule.shows[source.manifest.personaId];

  /**
   * Which cuts get a day.
   *
   * ONLY THE ONES THAT COULD ACTUALLY GO OUT. A cut that is already published
   * has nothing to wait for, and one the gate rejected can never use the day it
   * was given - so including either leaves a hole in the rotation, and the
   * channel is silent on a day the schedule says it published. Seven of ten
   * stories in the first real set were gate failures, which would have been
   * seven empty days out of ten.
   */
  const publishable = (cut: Run): boolean => {
    if (cut.isComplete('publish')) return false;
    try {
      return cut.readArtifact('qa', z.object({ passed: z.boolean() }).passthrough()).passed;
    } catch {
      // No gate report yet means it has not been rendered. It is not ready to
      // be given a day, and a later re-run of this will pick it up.
      return false;
    }
  };

  const pending = cuts.filter(publishable);
  const skipped = cuts.length - pending.length;

  const times = planRelease({
    count: pending.length,
    from: new Date(),
    slotHour: cadence?.slot?.hour,
    timezone: schedule.timezone,
  });

  pending.forEach((cut, i) => cut.setReleaseAt(times[i]!));

  return {
    scheduled: pending.length,
    // NAMED RATHER THAN SILENT. "Scheduled 3" out of a set of ten is a
    // surprise worth explaining at the moment it happens.
    skipped,
    first: times[0]?.toISOString() ?? null,
    last: times[times.length - 1]?.toISOString() ?? null,
    timezone: schedule.timezone,
  };
};

/**
 * Set the publish queue: what goes out, and in what order.
 *
 * ONE ORDERED LIST ACROSS EVERY CHANNEL, which is what makes it useful. The
 * question somebody actually has is "what does this studio put out over the
 * next fortnight, in what order" - and that is a single sequence, not five
 * per-channel ones you have to hold in your head at the same time.
 *
 * THE LIST IS THE QUEUE. A run in it gets a day; a run left out has its time
 * cleared and goes back to publishable-whenever. So removing something from the
 * queue is dropping it from the list rather than a separate act, and there is
 * no way for a run to be both queued and not queued.
 *
 * THE HOUR COMES FROM THE CHANNEL. Position decides the day, the channel's own
 * slot decides the hour, so two shows on consecutive days still go out at their
 * own times rather than both at nine in the morning.
 *
 * PUBLISHED RUNS FALL OUT BY THEMSELVES. Nothing here removes them: a published
 * run is no longer `ready`, so it stops being offered and stops being counted.
 * The order that remains is still the order.
 */
export const setPublishQueue = (body: unknown) => {
  const { runIds } = z.object({ runIds: z.array(z.string()) }).parse(body ?? {});

  const schedule = loadSchedule();
  const wanted = new Set(runIds);

  // Everything that could be queued, so anything dropped from the list gets
  // its time cleared in the same pass.
  const candidates = runs({ limit: 400 }).filter(
    (r) => !r.isSource && (r.state === 'ready' || r.state === 'awaiting-approval')
  );

  for (const summary of candidates) {
    if (!wanted.has(summary.id)) Run.open(summary.id).setReleaseAt(null);
  }

  const times = planRelease({
    count: runIds.length,
    from: new Date(),
    timezone: schedule.timezone,
  });

  const queued: Array<{ runId: string; releaseAt: string }> = [];

  runIds.forEach((runId, i) => {
    const run = Run.open(runId);
    const cadence = schedule.shows[run.manifest.personaId];

    // The day from the position, the hour from the channel.
    const day = times[i]!;
    const at = cadence?.slot ? atHourOn(day, cadence.slot.hour, schedule.timezone) : day;

    run.setReleaseAt(at);
    queued.push({ runId, releaseAt: at.toISOString() });
  });

  return { queued, timezone: schedule.timezone };
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
