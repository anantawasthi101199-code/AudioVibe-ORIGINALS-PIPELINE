/**
 * The studio server: an API, a live progress stream, and the built interface.
 *
 * NODE'S OWN HTTP MODULE AND NOTHING ELSE. A framework here would buy routing
 * for eighteen endpoints and a middleware chain for one concern, and cost a
 * dependency tree larger than the rest of this repo combined. The router below
 * is forty lines and does exactly what eighteen endpoints need.
 *
 * BOUND TO LOOPBACK BY DEFAULT, and that is a security decision rather than a
 * default nobody thought about. Every button in this interface spends money and
 * the whole thing is guarded by one password, so it must not be reachable from
 * the network unless somebody says so out loud - and when they do, it says what
 * that means.
 *
 * SERVER-SENT EVENTS FOR PROGRESS, not websockets. The traffic is one-way, the
 * messages are lines of text, and EventSource reconnects on its own. A
 * websocket would add a protocol to get a feature this does not need.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { URL } from 'url';
import {
  SESSION_COOKIE,
  AuthNotConfigured,
  identify,
  issueSession,
  operators,
  noteFailure,
  noteSuccess,
  readCookie,
  sessionCookie,
  sessionUser,
  tooManyAttempts,
} from './auth';
import {
  loopPreview,
  makeMix,
  musicDefaults,
  setMusicDefault,
  useMusicDefault,
  mixedFile,
  musicLibrary,
  readTrack,
  removeMix,
  removeTrack,
  runMixState,
  setTrackLoop,
  trackFileFor,
  uploadTrack,
  useMix,
  voiceOnly,
} from './music';
import { jobs } from './jobs';
import {
  HttpError,
  approveRun,
  resumeRun,
  audioDownloadFile,
  audioDownloadName,
  audioPath,
  cutShorts,
  getCatalogue,
  getChannel,
  getJob,
  getRun,
  getRuns,
  saveScript,
  setOverride,
  startRun,
  suggest,
} from './routes';
import {
  beatAudioPath,
  getBeats,
  getCovered,
  getSeason,
  makeBeat,
  suggestBeat,
} from './beats';
import { getQueue } from './queue';
import { getCalendar, releasingEnabled } from './calendar';
import { freshness } from './freshness';
import { blockedBy, heartbeat, release } from './holds';
import { archivedOwner } from '../archive/record';
import { repoRoot, runsDir } from '../config';
import { backUpRecords, r2Store, runKey, sweepArchive } from '../archive/r2';
import { archiveDownload } from './archiveNow';
import { releaseDue } from '../publish/release';
import {
  createSeriesJob,
  discardRun,
  getPlatform,
  nextDue,
  publishRunJob,
  approveForRelease,
  cancelRelease,
  recheckChannel,
  recordToken,
  releaseNow,
  releaseStatus,
  setContentRating,
  setRunSeries,
  rescheduleRelease,
  setHold,
  setUpChannelJob,
  verifyPublished,
} from './operate';
import {
  MAX_UPLOAD_BYTES,
  artKind,
  channelArtFile,
  channelArtState,
  removeChannelArt,
  removeRunArt,
  removeRunSeriesArt,
  runSeriesArtFile,
  runSeriesArtState,
  saveRunSeriesArt,
  runArtFile,
  runArtState,
  saveChannelArt,
  saveRunArt,
} from './art';

/** Where the built interface lives, when it has been built. */
const webRoot = (): string => path.join(__dirname, '..', '..', 'web', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  // The beat library, which the interface plays in an audio element. Served as
  // octet-stream a browser is entitled to offer it as a download instead, and
  // the whole point of the library is that somebody LISTENS before choosing.
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  // Artwork, which this server now serves back as a preview. Without these a
  // supplied JPEG goes out as octet-stream and some browsers offer to download
  // the studio's own page furniture instead of drawing it.
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
};

const readBody = async (req: http.IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A script is a few thousand words. Anything past a megabyte is a mistake
    // or an attack, and either way is better refused than buffered.
    if (size > 1_000_000) throw new HttpError(413, 'that is too large to be a script');
    chunks.push(chunk as Buffer);
  }

  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'the body was not JSON');
  }
};

/**
 * The bytes of a picture somebody picked.
 *
 * SEPARATE FROM readBody, AND NOT JUST FOR THE LIMIT. That one parses JSON and
 * caps at a megabyte because a script is words; this one must not parse
 * anything, because a PNG put through JSON.parse is a 400 that says the body
 * was not JSON, which is true and useless.
 *
 * RAW BYTES RATHER THAN multipart/form-data. A multipart parser is a
 * surprising amount of code to get right and this server has no dependency
 * that brings one. A browser can send a File as a request body directly, and
 * the one thing multipart would have carried that this does not - the original
 * filename - is not something the studio keeps: art/supplied.ts names the file
 * after what its header says it is.
 */
const readImage = async (req: http.IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_UPLOAD_BYTES) {
      throw new HttpError(
        413,
        `that image is over ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB, which is larger ` +
          `than anything the app will ever show. Export it smaller.`
      );
    }
    chunks.push(chunk as Buffer);
  }

  if (!chunks.length) throw new HttpError(400, 'there was no image in that request');
  return Buffer.concat(chunks);
};

/**
 * Stream a job's progress, and keep streaming after it ends.
 *
 * REPLAYS WHAT IT MISSED FIRST. A page opened halfway through a run, or
 * reopened after a refresh, gets every line so far and then the live ones. The
 * alternative is a progress view that is empty until the next thing happens,
 * which on the verification stage can be forty seconds of nothing.
 */
const streamJob = (req: http.IncomingMessage, res: http.ServerResponse, id: string): void => {
  const job = jobs.get(id);
  if (!job) {
    send(res, 404, { error: `no job "${id}"` });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });

  const write = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  for (const event of job.events) write('progress', event);
  if (job.finishedAt) {
    write('done', { error: job.error, produced: job.produced });
    res.end();
    return;
  }

  const stop = jobs.watch(id, (event) => {
    if (event) write('progress', event);
    else {
      const finished = jobs.get(id);
      write('done', { error: finished?.error ?? null, produced: finished?.produced ?? [] });
      res.end();
    }
  });

  // A heartbeat, because a proxy or a sleeping laptop will drop a connection
  // that says nothing for a minute, and the verification stage can.
  const beat = setInterval(() => res.write(': beat\n\n'), 20_000);

  req.on('close', () => {
    clearInterval(beat);
    stop();
  });
};

/**
 * How long the browser may keep a file.
 *
 * THE BUILD HASHES ITS ASSETS, so `index-D4nK2p.js` can never change meaning
 * and is safe to keep forever. `index.html` is the file that names them, so it
 * must never be kept: a cached one points at the previous build's assets, and
 * a rebuild appears to do nothing until somebody thinks to hard-reload. That
 * happened, and the first guess was that the change had not been saved.
 */
const cacheFor = (file: string): string =>
  /[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2?)$/.test(file)
    ? 'public, max-age=31536000, immutable'
    : 'no-store';

const serveFile = (
  res: http.ServerResponse,
  file: string,
  download?: string,
  attachment = false
): void => {
  // MOVED TO R2 (an archived run's audio): a private link, valid for an hour.
  // A redirect rather than streaming it through here, so seeking and the
  // download's speed are R2's, and the server's bandwidth is not spent on it.
  if (!fs.existsSync(file)) {
    const owner = archivedOwner(file);
    const store = owner ? r2Store() : null;
    if (!owner || !store) {
      send(res, 404, { error: 'that file is not here' });
      return;
    }
    void store
      .url(
        owner.record.prefix
          ? `${owner.record.prefix}/${owner.rel}`
          : runKey(path.relative(runsDir(), owner.runDir).split(path.sep).join('/'), owner.rel),
        attachment ? download : undefined
      )
      .then((url) => {
        res.writeHead(302, { location: url, 'cache-control': 'no-store' });
        res.end();
      })
      .catch((e: Error) => send(res, 502, { error: `could not reach the archive: ${e.message}` }));
    return;
  }
  const stat = fs.statSync(file);
  const headers = {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': cacheFor(file),
    'accept-ranges': 'bytes',
    ...(download
      ? { 'content-disposition': `${attachment ? 'attachment' : 'inline'}; filename="${download}"` }
      : {}),
  };

  // PARTIAL REQUESTS, which audio players use to start and to seek. Without
  // them the studio sent the whole file every time, and a mixed short (a 27MB
  // WAV) sat silent in the player until it gave up (2026-10-05).
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(res.req?.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, 'content-length': stat.size });
  fs.createReadStream(file).pipe(res);
};

/**
 * The interface, or an honest page explaining that it has not been built.
 *
 * A SERVER THAT 404s ON ITS OWN FRONT PAGE teaches nothing. Somebody who has
 * just cloned this and run the command needs to be told the one thing they are
 * missing, on the page they are already looking at.
 */
const serveWeb = (res: http.ServerResponse, pathname: string): void => {
  const root = webRoot();
  const index = path.join(root, 'index.html');

  if (!fs.existsSync(index)) {
    const body = `<!doctype html><meta charset="utf-8"><title>Foundry studio</title>
<style>body{font:15px/1.6 ui-monospace,monospace;max-width:40rem;margin:6rem auto;padding:0 1.5rem}
code{background:#eee;padding:.15rem .35rem;border-radius:3px}</style>
<h1>The interface has not been built yet.</h1>
<p>The API is running and answering on <code>/api</code>. What is missing is the
page that talks to it.</p>
<pre><code>cd web
npm install
npm run build</code></pre>
<p>Then reload. During development, <code>npm run dev</code> in that folder
serves the interface on its own port and proxies the API back here.</p>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }

  // A single-page app owns its own routing, so anything that is not a real file
  // is the app being asked for one of its own paths.
  const asked = path.join(root, pathname.replace(/^\/+/, ''));
  const file = asked.startsWith(root) && fs.existsSync(asked) && fs.statSync(asked).isFile() ? asked : index;
  serveFile(res, file);
};

export interface ServeOptions {
  port?: number;
  /** Loopback unless somebody explicitly asks otherwise. See the note above. */
  host?: string;
}

export const createServer = (): http.Server =>
  http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    const id = url.searchParams.get('id');

    // SHOWN INSIDE THE ADMIN DASHBOARD AND NOWHERE ELSE (2026-10-05). A page
    // that can publish to production must not be framable by any site, or a
    // stranger's page could dress it up and borrow a teammate's click.
    res.setHeader(
      'content-security-policy',
      `frame-ancestors 'self' ${process.env.FOUNDRY_FRAME_ANCESTORS ?? 'https://admin.audiovibe.co'}`
    );

    // WHAT REACHED US, for the "Failed to fetch" with the studio up (2026-10-05):
    // every upload, any error status, and any connection that dropped before the
    // answer was sent. A request missing here never arrived.
    const started = Date.now();
    let received = 0;
    req.on('data', (chunk: Buffer) => (received += chunk.length));
    res.on('close', () => {
      const upload = req.method === 'POST' && /\/art$|^\/api\/music$/.test(pathname);
      const dropped = !res.writableFinished;
      if (!upload && !dropped && res.statusCode < 400) return;
      console.log(
        `  ${new Date().toISOString().slice(11, 19)} ${req.method} ${pathname} -> ` +
          `${dropped ? 'DROPPED before answering' : res.statusCode} ` +
          `(${Math.round(received / 1024)}KB in, ${Date.now() - started}ms)`
      );
    });

    try {
      if (!pathname.startsWith('/api/')) {
        serveWeb(res, pathname);
        return;
      }

      // --- Anything before a session --------------------------------------
      if (pathname === '/api/session' && req.method === 'POST') {
        // Behind a tunnel the socket address is the tunnel, so the forwarded
        // header is the only thing that distinguishes one guesser from another.
        const source =
          (req.headers['cf-connecting-ip'] as string) ??
          (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
          req.socket.remoteAddress ??
          'unknown';

        if (tooManyAttempts(source)) {
          send(res, 429, { error: 'too many attempts; wait a few minutes' });
          return;
        }

        const body = (await readBody(req)) as { password?: string } | null;
        const who = identify(body?.password ?? '');

        if (!who) {
          noteFailure(source);
          // One message for a wrong password and a missing one. Distinguishing
          // them tells somebody guessing which half they got right.
          send(res, 401, { error: 'that is not the password' });
          return;
        }

        noteSuccess(source);
        console.log(`  signed in: ${who} from ${source}`);
        send(res, 200, { ok: true, name: who }, { 'set-cookie': sessionCookie(issueSession(who)) });
        return;
      }

      // WHO, not just whether. Every act that spends money or publishes is
      // recorded against this name, which is the whole reason the studio has
      // named people rather than one shared password.
      const user = sessionUser(readCookie(req.headers.cookie, SESSION_COOKIE));
      const signedIn = user !== null;

      if (pathname === '/api/me') {
        send(res, signedIn ? 200 : 401, signedIn ? { signedIn: true, name: user } : { error: 'sign in' });
        return;
      }

      if (pathname === '/api/session' && req.method === 'DELETE') {
        send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(null) });
        return;
      }

      if (!signedIn) {
        send(res, 401, { error: 'sign in' });
        return;
      }

      // --- Holds: who is working on which run. See holds.ts. ---------------
      if (pathname === '/api/run/hold' && req.method === 'POST') {
        const { active } = (await readBody(req)) as { active?: boolean };
        return send(res, 200, heartbeat(id ?? '', user!, active !== false));
      }
      // POST, so the page can send it as a beacon while it is closing.
      if (pathname === '/api/run/release' && req.method === 'POST') {
        release(id ?? '', user!);
        return send(res, 200, { ok: true });
      }
      // THE SERVER REFUSES, not only the page: any change to a run somebody
      // else is holding. Reads (GET) stay open to everybody.
      if (pathname.startsWith('/api/run') && req.method !== 'GET' && id) {
        const holder = blockedBy(id, user!);
        if (holder) {
          send(res, 423, { error: `${holder} is working on this right now. It opens up when they leave it.` });
          return;
        }
      }

      // --- Reading ----------------------------------------------------------
      //
      // EVERY ROUTE HERE THAT ALSO HAS A WRITE MUST SAY `req.method === 'GET'`.
      // These are matched in file order, so an unguarded read sitting above a
      // POST for the same path answers the POST with the read's body and a 200,
      // and the write below it never runs. It looks exactly like success.
      // Three routes were broken this way at once - starting a run, deleting a
      // run, and making a beat - and routes.test.ts now fails if it recurs.
      if (pathname === '/api/catalogue') return send(res, 200, getCatalogue());
      if (pathname === '/api/queue') return send(res, 200, getQueue());
      if (pathname === '/api/platform') return send(res, 200, getPlatform());
      if (pathname === '/api/freshness') return send(res, 200, freshness());
      if (pathname === '/api/calendar') {
        return send(res, 200, getCalendar(url.searchParams.get('month') ?? undefined));
      }
      if (pathname === '/api/release') return send(res, 200, releaseStatus());
      if (pathname === '/api/run/verify') return send(res, 200, await verifyPublished(id ?? ''));
      if (pathname === '/api/next') return send(res, 200, nextDue());
      if (pathname === '/api/channel') return send(res, 200, getChannel(id ?? ''));
      if (pathname === '/api/runs' && req.method === 'GET') {
        return send(res, 200, getRuns(url.searchParams.get('channel')));
      }
      if (pathname === '/api/run' && req.method === 'GET') return send(res, 200, getRun(id ?? ''));

      // --- The library: beats, season plans, and what has been covered ------
      if (pathname === '/api/beats' && req.method === 'GET') return send(res, 200, getBeats());
      if (pathname === '/api/beats/audio') {
        serveFile(res, beatAudioPath(url.searchParams.get('name') ?? ''));
        return;
      }
      if (pathname === '/api/season') {
        const season = Number(url.searchParams.get('season') ?? '1');
        return send(res, 200, getSeason(id ?? '', Number.isFinite(season) ? season : 1));
      }
      if (pathname === '/api/covered') {
        return send(
          res,
          200,
          getCovered(url.searchParams.get('channel'), url.searchParams.get('topic'))
        );
      }
      if (pathname === '/api/job') return send(res, 200, getJob(id ?? ''));

      if (pathname === '/api/job/events') {
        streamJob(req, res, id ?? '');
        return;
      }

      if (pathname === '/api/run/audio') {
        // The final audio. `download=1` saves it under a real name.
        // `download=1` saves it as an MP3 under a real name; playing stays WAV.
        if (url.searchParams.get('download') === '1') {
          serveFile(res, await audioDownloadFile(id ?? ''), audioDownloadName(id ?? ''), true);
        } else {
          serveFile(res, audioPath(id ?? ''), 'episode.wav');
        }
        return;
      }

      // --- Artwork ----------------------------------------------------------
      //
      // The picture itself and the fact of it are two routes, because the page
      // wants the second in JSON beside everything else it loads and the first
      // only as the src of an img.
      if (pathname === '/api/channel/art/state') {
        return send(res, 200, channelArtState(id ?? ''));
      }
      if (pathname === '/api/run/art/state') {
        return send(res, 200, runArtState(id ?? ''));
      }

      if (pathname === '/api/channel/art' && req.method === 'GET') {
        const file = channelArtFile(id ?? '', artKind(url.searchParams.get('kind')));
        if (!file) return send(res, 404, { error: 'this channel has no artwork yet' });
        serveFile(res, file);
        return;
      }
      if (pathname === '/api/run/art' && req.method === 'GET') {
        const file = runArtFile(id ?? '');
        if (!file) return send(res, 404, { error: 'this run has no cover yet' });
        serveFile(res, file);
        return;
      }
      if (pathname === '/api/channel/art' && req.method === 'POST') {
        const kind = artKind(url.searchParams.get('kind'));
        return send(res, 200, saveChannelArt(id ?? '', kind, await readImage(req)));
      }
      if (pathname === '/api/channel/art' && req.method === 'DELETE') {
        return send(res, 200, removeChannelArt(id ?? '', artKind(url.searchParams.get('kind'))));
      }
      if (pathname === '/api/run/art' && req.method === 'POST') {
        return send(res, 200, saveRunArt(id ?? '', await readImage(req)));
      }
      if (pathname === '/api/run/art' && req.method === 'DELETE') {
        return send(res, 200, removeRunArt(id ?? ''));
      }
      if (pathname === '/api/run/series-art/state') return send(res, 200, runSeriesArtState(id ?? ''));
      if (pathname === '/api/run/series-art' && req.method === 'GET') {
        const file = runSeriesArtFile(id ?? '');
        if (!file) return send(res, 404, { error: 'no cover chosen for this series' });
        serveFile(res, file);
        return;
      }
      if (pathname === '/api/run/series-art' && req.method === 'POST') {
        return send(res, 200, await saveRunSeriesArt(id ?? '', await readImage(req)));
      }
      if (pathname === '/api/run/series-art' && req.method === 'DELETE') {
        return send(res, 200, removeRunSeriesArt(id ?? ''));
      }

      // --- Music: your own tracks, mixed under a finished episode ------------
      if (pathname === '/api/music' && req.method === 'GET') return send(res, 200, musicLibrary());
      if (pathname === '/api/music' && req.method === 'POST') {
        return send(res, 200, await uploadTrack(url.searchParams.get('name'), await readTrack(req)));
      }
      if (pathname === '/api/music' && req.method === 'DELETE') {
        return send(res, 200, removeTrack(url.searchParams.get('name')));
      }
      if (pathname === '/api/music/loop' && req.method === 'PUT') {
        return send(res, 200, await setTrackLoop(url.searchParams.get('name'), await readBody(req)));
      }
      if (pathname === '/api/music/preview') {
        const { file } = await loopPreview(url.searchParams.get('name'), url.searchParams);
        serveFile(res, file);
        return;
      }
      if (pathname === '/api/music/file') {
        const file = trackFileFor(url.searchParams.get('name'));
        if (!file) return send(res, 404, { error: 'no such track' });
        serveFile(res, file);
        return;
      }
      if (pathname === '/api/run/mix' && req.method === 'GET') return send(res, 200, runMixState(id ?? ''));
      if (pathname === '/api/run/mix' && req.method === 'POST') {
        return send(res, 200, await makeMix(id ?? '', await readBody(req)));
      }
      if (pathname === '/api/run/mix' && req.method === 'DELETE') return send(res, 200, await removeMix(id ?? ''));
      if (pathname === '/api/music/defaults' && req.method === 'GET') return send(res, 200, musicDefaults());
      if (pathname === '/api/channel/music-default' && req.method === 'PUT') {
        return send(res, 200, await setMusicDefault(id ?? '', await readBody(req)));
      }
      if (pathname === '/api/run/mix/default' && req.method === 'POST') {
        return send(res, 200, await useMusicDefault(id ?? ''));
      }
      if (pathname === '/api/run/mix/use' && req.method === 'POST') return send(res, 200, await useMix(id ?? ''));
      if (pathname === '/api/run/mix/use' && req.method === 'DELETE') return send(res, 200, await voiceOnly(id ?? ''));
      if (pathname === '/api/run/mix/audio') {
        const file = mixedFile(id ?? '', url.searchParams.get('which'));
        if (!file) return send(res, 404, { error: 'this run has no mix yet' });
        serveFile(res, file, 'episode-with-music.wav');
        return;
      }

      // --- Writing ----------------------------------------------------------
      if (pathname === '/api/beats' && req.method === 'POST') {
        return send(res, 200, await makeBeat(await readBody(req)));
      }
      // Suggesting and making are separate calls so the form can be filled in,
      // looked at and changed before anything is synthesised. See beats.ts.
      if (pathname === '/api/beats/suggest' && req.method === 'POST') {
        return send(res, 200, await suggestBeat(await readBody(req)));
      }
      if (pathname === '/api/runs' && req.method === 'POST') {
        return send(res, 201, startRun(await readBody(req), user));
      }
      if (pathname === '/api/run/script' && req.method === 'PUT') {
        return send(res, 200, saveScript(id ?? '', await readBody(req)));
      }
      if (pathname === '/api/run/override' && req.method === 'POST') {
        return send(res, 200, setOverride(id ?? '', await readBody(req), true, user));
      }
      if (pathname === '/api/run/override' && req.method === 'DELETE') {
        return send(res, 200, setOverride(id ?? '', await readBody(req), false, user));
      }
      if (pathname === '/api/run/resume' && req.method === 'POST') {
        return send(res, 202, resumeRun(id ?? '', user));
      }
      if (pathname === '/api/run/approve' && req.method === 'POST') {
        return send(res, 202, approveRun(id ?? '', user));
      }
      if (pathname === '/api/run/shorts' && req.method === 'POST') {
        return send(res, 202, cutShorts(id ?? '', await readBody(req), user));
      }
      if (pathname === '/api/release/now' && req.method === 'POST') {
        return send(res, 200, await releaseNow());
      }
      if (pathname === '/api/channel/recheck' && req.method === 'POST') {
        return send(res, 200, recheckChannel(id ?? ''));
      }
      if (pathname === '/api/channel/approve' && req.method === 'POST') {
        const body = await readBody(req);
        const held = ((body as { runIds?: string[] })?.runIds ?? [])
          .map((r) => ({ r, holder: blockedBy(r, user!) }))
          .find((x) => x.holder);
        if (held) {
          return send(res, 423, { error: `${held.holder} is working on ${held.r} right now.` });
        }
        return send(res, 200, approveForRelease(id ?? '', body, user));
      }
      if (pathname === '/api/run/reschedule' && req.method === 'POST') {
        return send(res, 200, rescheduleRelease(id ?? '', await readBody(req)));
      }
      if (pathname === '/api/run/cancel' && req.method === 'POST') {
        return send(res, 200, cancelRelease(id ?? ''));
      }
      if (pathname === '/api/run/series' && req.method === 'PUT') {
        return send(res, 200, setRunSeries(id ?? '', await readBody(req)));
      }
      if (pathname === '/api/run/rating' && req.method === 'POST') {
        return send(res, 200, setContentRating(id ?? '', await readBody(req)));
      }
      if (pathname === '/api/run/hold' && req.method === 'POST') {
        return send(res, 200, setHold(id ?? '', await readBody(req)));
      }
      if (pathname === '/api/run/publish' && req.method === 'POST') {
        return send(res, 200, publishRunJob(id ?? '', await readBody(req), user));
      }
      if (pathname === '/api/run' && req.method === 'DELETE') {
        return send(res, 200, discardRun(id ?? ''));
      }
      if (pathname === '/api/channel/setup' && req.method === 'POST') {
        return send(res, 200, setUpChannelJob(id ?? '', await readBody(req)));
      }
      if (pathname === '/api/channel/token' && req.method === 'POST') {
        return send(res, 200, recordToken(id ?? '', await readBody(req)));
      }
      if (pathname === '/api/channel/series' && req.method === 'POST') {
        return send(res, 200, createSeriesJob(id ?? ''));
      }
      if (pathname === '/api/channel/suggest' && req.method === 'POST') {
        return send(res, 200, await suggest(id ?? '', await readBody(req)));
      }

      send(res, 404, { error: `no route for ${req.method} ${pathname}` });
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }

      const status = err instanceof HttpError ? err.status : err instanceof AuthNotConfigured ? 500 : 400;
      const message = (err as Error)?.message ?? 'something went wrong';

      // The message goes to the browser AND to the terminal. A studio running
      // on somebody's own machine has its logs on screen already, and an error
      // that only one of them sees is an error somebody debugs twice.
      if (status >= 500) console.error(message);
      send(res, status, { error: message });
    }
  });

export const serve = async (opts: ServeOptions = {}): Promise<http.Server> => {
  const port = opts.port ?? Number(process.env.FOUNDRY_PORT ?? 4317);
  const host = opts.host ?? process.env.FOUNDRY_HOST ?? '127.0.0.1';

  // FAIL NOW, NOT ON THE FIRST REQUEST. A server that starts and then rejects
  // every sign-in is a server somebody debugs for ten minutes. This also
  // refuses a short password on an exposed host, which is the moment it stops
  // being theatre and starts mattering.
  const people = operators();

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, host, resolve));

  // A DEPLOY WAITS FOR WORK IN PROGRESS (2026-10-05). A push to main replaced
  // the studio mid-write and a teammate's short lost its paid-for script. On
  // the stop signal: take no new requests, let running jobs finish (up to
  // FOUNDRY_DRAIN_MS), then exit. Railway must allow at least that long:
  // RAILWAY_DEPLOYMENT_DRAINING_SECONDS on the service.
  process.once('SIGTERM', () => {
    const deadline = Date.now() + Number(process.env.FOUNDRY_DRAIN_MS ?? 270_000);
    console.log(`  stopping: waiting for ${jobs.liveRunIds().size} job(s) to finish first`);
    server.close();
    const wait = () => {
      if (jobs.liveRunIds().size === 0 || Date.now() > deadline) process.exit(0);
      else setTimeout(wait, 2_000);
    };
    wait();
  });

  console.log('');
  console.log(`  Foundry studio on http://${host}:${port}`);
  console.log(
    `  ${people.length === 1 ? 'One person' : `${people.length} people`} can sign in: ` +
      people.map((p) => p.name).join(', ')
  );

  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log('');
    console.log(`  NOT ON LOOPBACK. Anybody who can reach ${host}:${port} can reach this,`);
    console.log('  and every button in it spends money and publishes to production.');
    console.log('  Put it behind a tunnel with its own access control rather than');
    console.log('  opening a port: see docs/REMOTE.md.');
  }
  // THE ROLLING ARCHIVE: published runs to R2, on start-up and every 30
  // minutes, so one whose archive failed is never forgotten. See archive/r2.ts.
  const archive = r2Store();
  if (archive) {
    const sweep = () =>
      void sweepArchive({ store: archive, makeDownload: archiveDownload }, (m) => console.log(`  ${m}`))
        .then(() => backUpRecords(archive, repoRoot()))
        .catch((e: Error) => console.log(`  archive sweep failed: ${e.message}`));
    sweep();
    setInterval(sweep, 30 * 60_000).unref();
    console.log(`  Archive ON: published runs move to R2 bucket ${archive.bucket}.`);
  } else {
    console.log('  Archive off: FOUNDRY_ARCHIVE_* are not set, so everything stays on this disk.');
  }

  if (releasingEnabled()) {
    startReleasing();
    console.log(`  Releasing is ON. Approved episodes publish themselves at their time,`);
    console.log(`  checked every ${RELEASE_EVERY_MS / 60000} minutes, while this is running.`);
  } else {
    console.log('  Releasing is off. Nothing publishes unless you press publish.');
    console.log('  FOUNDRY_RELEASE=on turns it on.');
  }

  console.log('');
  return server;
};

/**
 * How often to look for something due.
 *
 * FIVE MINUTES, because the thing being scheduled is an episode on a given
 * morning and nobody can tell 08:00 from 08:04. Polling a handful of files
 * more often than that buys nothing.
 */
const RELEASE_EVERY_MS = 5 * 60_000;

/**
 * The clock that publishes approved episodes.
 *
 * IT ONLY RUNS WHILE THE STUDIO IS OPEN, and that is a real limitation rather
 * than a detail: close the terminal and nothing goes out. A backlog is not
 * lost - a run stays due until it is published, so the next time the studio is
 * open it catches up, one per tick, oldest first. For a studio that publishes
 * whether or not somebody's laptop is on, point Task Scheduler or cron at
 * `foundry release` instead; it is the same code.
 *
 * ONE AT A TIME, so a week of backlog does not arrive in one minute - which is
 * the burst the whole scheduling design exists to prevent.
 */
const startReleasing = (): void => {
  let working = false;

  const tick = async (): Promise<void> => {
    // A slow publish must not overlap the next tick and send the same episode
    // twice.
    if (working) return;
    working = true;

    try {
      const result = await releaseDue(new Date(), {
        report: (m) => console.log(`  [release] ${m}`),
      });

      for (const held of result.held) {
        console.log(`  [release] holding ${held.runId}: ${held.reason}`);
      }
      if (result.remaining > 0) {
        console.log(`  [release] ${result.remaining} more due, next in ${RELEASE_EVERY_MS / 60000}m`);
      }
    } catch (err) {
      // A failure here must not stop the timer: the next tick tries again, and
      // a studio that silently stopped releasing is worse than a noisy one.
      console.error(`  [release] ${(err as Error).message}`);
    } finally {
      working = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), RELEASE_EVERY_MS);

  // Never hold the process open on its own account.
  timer.unref?.();
};
