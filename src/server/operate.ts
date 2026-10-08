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
import { platformUrl, repoRoot } from '../config';
import { suppliedArt } from '../art/supplied';
import { setUpChannel } from '../pipeline/channel';
import { AudioVibeClient } from '../publish/ingest';
import {
  accountsPath,
  loadAccounts,
  publishTokenFor,
  saveAccounts,
} from '../publish/account';
import { findSeries, recordSeries, seriesKey } from '../publish/seriesRegistry';
import { blockedBy } from './holds';
import { paletteFor, renderCover, SERIES_COVER_SIZE } from '../art/cover';
import { currentPlan } from '../schedule/current';
import { dueForRelease, releaseDue } from '../publish/release';
import { releasingEnabled } from './calendar';
import { loadSchedule } from '../schedule/load';
import { PER_DAY, allocate, type ItemKind, type Taken } from '../schedule/allocate';
import { instantOfWallClock } from '../schedule/slots';
import { publishRun } from '../publish/publishRun';
import { archiveSoon } from './archiveNow';
import { regate } from '../qa/regate';
import { Run } from '../run/store';
import { loadCatalogue, saveCatalogue } from '../catalogue/covered';
import { loadFormat } from '../formats/load';
import { scriptSchema } from '../script/write';
import { HttpError } from './routes';
import { RunSummary, runs } from './catalog';
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
      // A supplied one wins, as everywhere else.
      const coverPath =
        suppliedArt(path.join(repoRoot(), 'art', persona.id), 'series') ??
        renderCover(
          { showName: persona.name, title: persona.name, palette: paletteFor(persona.id) },
          path.join(os.tmpdir(), `foundry-series-${persona.id}.png`),
          SERIES_COVER_SIZE
        );

      const client = new AudioVibeClient(platform.url!, publishTokenFor(persona.id));
      const created = await client.createSeries({
        title: persona.name,
        description: persona.thesis.trim().replace(/\s+/g, ' '),
        category: persona.category,
        contentRating: persona.contentRating,
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
  if (run.isComplete('publish')) throw new HttpError(400, 'that is already published');
  if (!run.isComplete('render') || !run.audioFile()) {
    throw new HttpError(400, 'this has not been voiced yet, so there is nothing to publish. Voice it first.');
  }
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

  // REQUESTED, not done: this is the button press. publishRun journals the outcome.
  if (who) run.journal({ stage: 'publish', event: `publish requested by ${who}` });

  const job = jobs.start({
    id,
    kind: 'publish',
    runId,
    by: who,
    work: async (report) => {
      await publishRun(run, gate, { confirmed, report: (m) => report('publish', m) });
      // Then to R2, in the background. See server/archiveNow.ts.
      archiveSoon(run);
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
 * arithmetic, done here: one short and one episode a day at most for this
 * channel, each on the earliest free day from tomorrow, rolling into the next
 * week when this one is full. See schedule/allocate.ts. Publishing now is not
 * limited by any of it.
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
  // A CHANNEL NOT IN schedule.yaml STILL GETS DAYS: the rule is the same for
  // every channel, and the cadence only supplies its hour.
  const cadence = schedule.shows[channelId] ?? {
    everyDays: 7,
    shortsPerEpisode: 0,
    autoPublish: false,
    perWeek: { episodes: 1, shorts: 7 },
  };

  const foreign = runIds.filter((id) => id.split('/')[0] !== channelId);
  if (foreign.length) {
    throw new HttpError(400, `not ${persona.name}'s runs: ${foreign.join(', ')}`);
  }

  const mine = runs({ channelId, limit: 400 });

  // ONLY WHAT IS FINISHED: voiced, gated over its audio, and passed. An
  // approved run is released without anybody present, so one with no audio
  // would only fail later, at its hour, with nobody watching.
  const unfinished = runIds
    .map((runId) => ({ runId, summary: mine.find((r) => r.id === runId) }))
    .filter(({ summary }) => !summary || summary.state !== 'ready' || summary.isSource);
  if (unfinished.length) {
    const why = (s?: RunSummary) =>
      !s ? 'not found' : s.state === 'needs-voice' ? 'not voiced yet' : s.isSource ? 'a source script' : s.state;
    throw new HttpError(
      400,
      `only finished runs can be approved: ${unfinished.map((u) => `${u.runId} (${why(u.summary)})`).join(', ')}`
    );
  }

  // BY FORMAT, not only by being cut from an episode: a short made directly
  // (a science or health short) is a short, and fills a short's slot.
  const kindOf = (runId: string): ItemKind => {
    const summary = mine.find((r) => r.id === runId);
    if (summary && summary.short !== null) return 'short';
    try {
      return loadFormat(Run.open(runId).manifest.formatId).kind === 'short' ? 'short' : 'episode';
    } catch {
      return 'episode';
    }
  };

  // Days already spoken for stay spoken for.
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

  // Only if the next two years are full. Reported rather than dropped.
  const unscheduled = runIds.filter((id) => !placed.some((p) => p.runId === id));

  return {
    approved: placed.map((p) => ({ runId: p.runId, releaseAt: p.at.toISOString(), kind: p.kind })),
    unscheduled,
    perDay: { episodes: PER_DAY, shorts: PER_DAY },
    timezone: schedule.timezone,
  };
};

/**
 * Move an approved run to another day and time, from the calendar.
 *
 * THE WALL CLOCK, IN THE SCHEDULE'S ZONE. "Thursday 18:00" means 18:00 where the
 * calendar says it is, so it is converted here rather than trusting whatever
 * zone the browser happens to be in. The approval stands: moving a day is not
 * a new decision about whether it goes out.
 */
export const rescheduleRelease = (runId: string, body: unknown, now: Date = new Date()) => {
  const { wall } = z
    .object({ wall: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'a date and time, like 2026-10-08T18:00') })
    .parse(body ?? {});
  const run = Run.open(runId);
  if (run.isComplete('publish')) throw new HttpError(400, 'that is already published');
  if (!run.manifest.releaseAt) throw new HttpError(400, 'that is not scheduled; approve it first');

  const at = instantOfWallClock(`${wall}:00`, loadSchedule().timezone);
  if (at.getTime() <= now.getTime()) throw new HttpError(400, 'that time has already passed');

  run.setReleaseAt(at);
  run.journal({ stage: 'publish', event: `moved to ${at.toISOString()}` });
  return { ok: true as const, runId, releaseAt: at.toISOString() };
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
 * File an episode under a series, or move it to another, before it is
 * published. After that its shelf on the platform is fixed.
 */
export const setRunSeries = (runId: string, body: unknown) => {
  const { seriesTitle } = z
    .object({ seriesTitle: z.string().trim().min(1, 'name the series').max(80) })
    .parse(body ?? {});
  const run = Run.open(runId);
  if (run.isComplete('publish')) throw new HttpError(400, 'that is already published, so its series is fixed');
  if (loadFormat(run.manifest.formatId).kind === 'short') {
    throw new HttpError(400, 'shorts are not filed under a series');
  }
  run.setSeriesTitle(seriesTitle);
  run.journal({ stage: 'publish', event: `filed under the series "${seriesTitle}"` });
  return { ok: true as const, runId, seriesTitle };
};

/** A short description: the most words one may have (owner, 2026-10-06). */
export const DESCRIPTION_MAX_WORDS = 50;

/**
 * The title and description a listener sees, before or after publishing.
 *
 * AFTER PUBLISHING, AUDIOVIBE FIRST: the change goes to the platform, and only
 * once it has accepted it is it saved here, so the studio and the app never
 * disagree about what an episode is called. The script's words are untouched
 * either way, so the voiced audio stays.
 */
export const setListing = async (runId: string, body: unknown) => {
  const { title, description } = z
    .object({
      title: z.string().trim().min(1, 'give it a title').max(100, 'a title is at most 100 characters'),
      description: z.string().trim().min(1, 'give it a description'),
    })
    .parse(body ?? {});
  const words = description.split(/\s+/).filter(Boolean).length;
  if (words > DESCRIPTION_MAX_WORDS) {
    throw new HttpError(400, `the description is ${words} words; keep it to ${DESCRIPTION_MAX_WORDS}`);
  }

  const run = Run.open(runId);
  const script = run.readArtifact('script', scriptSchema);
  if (run.isComplete('publish')) {
    const published = run.readArtifact('publish', z.object({ audioId: z.string() }).passthrough());
    try {
      await new AudioVibeClient(platformUrl().url, publishTokenFor(run.manifest.personaId)).updateListing(
        published.audioId,
        { title, description }
      );
    } catch (e) {
      throw new HttpError(502, `AudioVibe did not take the change, so nothing was saved: ${(e as Error).message}`);
    }
  }
  run.writeArtifact('script', { ...script, title, description });
  run.journal({ stage: 'publish', event: `title and description edited${run.isComplete('publish') ? ' on AudioVibe too' : ''}` });
  return { ok: true as const, title, description };
};

/**
 * Rename a series on every episode filed under it, and move its cover with it
 * (owner, 2026-10-05). Only BEFORE it exists on AudioVibe: once created there,
 * its name is the platform's, and renaming it here would file later episodes
 * into a second, new series.
 */
export const renameSeries = (channelId: string, body: unknown, who: string | null = null) => {
  const { from, to } = z
    .object({ from: z.string().trim().min(1), to: z.string().trim().min(1).max(80) })
    .parse(body ?? {});
  if (from === to) return { ok: true as const, renamed: 0 };

  const fromKey = seriesKey(channelId, from);
  if (findSeries(fromKey, platformUrl().url)) {
    throw new HttpError(400, `"${from}" is already on AudioVibe, so its name is fixed there`);
  }

  const episodes = Run.list()
    .filter((id) => id.startsWith(`${channelId}/`))
    .map((id) => Run.open(id))
    .filter((r) => r.manifest.seriesTitle === from);
  const held = episodes.map((r) => ({ r, by: who ? blockedBy(r.id, who) : null })).find((x) => x.by);
  if (held) throw new HttpError(423, `${held.by} is working on ${held.r.id}; rename it when they leave`);
  if (episodes.some((r) => r.isComplete('publish'))) {
    throw new HttpError(400, `an episode of "${from}" is already published, so the series name is fixed`);
  }

  for (const r of episodes) {
    r.setSeriesTitle(to);
    r.journal({ stage: 'publish', event: `series renamed from "${from}" to "${to}"` });
  }

  // The cover moves with the name, unless the new name already has one.
  const dir = path.join(repoRoot(), 'art', channelId);
  const slug = (title: string) => `series-${seriesKey(channelId, title).split('#')[1]}`;
  const old = suppliedArt(dir, slug(from));
  if (old && !suppliedArt(dir, slug(to))) {
    fs.renameSync(old, path.join(dir, `${slug(to)}.supplied${path.extname(old)}`));
  }
  return { ok: true as const, renamed: episodes.length };
};

/**
 * Who a run is for, before it goes out. Null goes back to the channel's rating.
 * LOCKED ONCE PUBLISHED: the platform owns the rating then, and an upgrade
 * there is a moderation decision rather than a studio setting.
 */
export const setContentRating = (runId: string, body: unknown) => {
  const { rating } = z.object({ rating: z.enum(['general', 'mature']).nullable() }).parse(body ?? {});
  const run = Run.open(runId);
  if (run.isComplete('publish')) throw new HttpError(400, 'that is already published');
  run.setContentRating(rating);
  return { ok: true as const, runId, rating };
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
  // A published run's folder is the only record of what went out and its id.
  if (Run.open(id).isComplete('publish')) {
    throw new HttpError(400, 'that is already published; take it down in the app instead');
  }

  fs.rmSync(dir, { recursive: true, force: true });

  // FREE THE SUBJECT. A discarded run never went out, so its topic must not
  // keep blocking the same subject on this or any other channel.
  const catalogue = loadCatalogue();
  const kept = catalogue.entries.filter((e) => e.runId !== id);
  if (kept.length !== catalogue.entries.length) saveCatalogue({ ...catalogue, entries: kept });
  return { ok: true as const };
};
