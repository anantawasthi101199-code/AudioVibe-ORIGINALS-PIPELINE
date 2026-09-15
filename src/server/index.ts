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
  issueSession,
  passwordMatches,
  readCookie,
  sessionCookie,
  sessionIsValid,
} from './auth';
import { jobs } from './jobs';
import {
  HttpError,
  approveRun,
  audioPath,
  cutShorts,
  getCatalogue,
  getChannel,
  getJob,
  getRun,
  getRuns,
  saveScript,
  startRun,
  suggest,
} from './routes';
import { getQueue } from './queue';
import {
  createSeriesJob,
  discardRun,
  getPlatform,
  nextDue,
  publishRunJob,
  recordToken,
  scheduleRelease,
  setPublishQueue,
  setUpChannelJob,
} from './operate';

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
  '.ico': 'image/x-icon',
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

const serveFile = (res: http.ServerResponse, file: string, download?: string): void => {
  const stat = fs.statSync(file);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    ...(download ? { 'content-disposition': `inline; filename="${download}"` } : {}),
  });
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

    try {
      if (!pathname.startsWith('/api/')) {
        serveWeb(res, pathname);
        return;
      }

      // --- Anything before a session --------------------------------------
      if (pathname === '/api/session' && req.method === 'POST') {
        const body = (await readBody(req)) as { password?: string } | null;
        if (!passwordMatches(body?.password ?? '')) {
          // One message for a wrong password and a missing one. Distinguishing
          // them tells somebody guessing which half they got right.
          send(res, 401, { error: 'that is not the password' });
          return;
        }
        send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(issueSession()) });
        return;
      }

      const signedIn = sessionIsValid(readCookie(req.headers.cookie, SESSION_COOKIE));

      if (pathname === '/api/me') {
        send(res, signedIn ? 200 : 401, signedIn ? { signedIn: true } : { error: 'sign in' });
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

      // --- Reading ----------------------------------------------------------
      if (pathname === '/api/catalogue') return send(res, 200, getCatalogue());
      if (pathname === '/api/queue') return send(res, 200, getQueue());
      if (pathname === '/api/platform') return send(res, 200, getPlatform());
      if (pathname === '/api/next') return send(res, 200, nextDue());
      if (pathname === '/api/channel') return send(res, 200, getChannel(id ?? ''));
      if (pathname === '/api/runs') return send(res, 200, getRuns(url.searchParams.get('channel')));
      if (pathname === '/api/run') return send(res, 200, getRun(id ?? ''));
      if (pathname === '/api/job') return send(res, 200, getJob(id ?? ''));

      if (pathname === '/api/job/events') {
        streamJob(req, res, id ?? '');
        return;
      }

      if (pathname === '/api/run/audio') {
        serveFile(res, audioPath(id ?? ''), 'episode.wav');
        return;
      }

      // --- Writing ----------------------------------------------------------
      if (pathname === '/api/runs' && req.method === 'POST') {
        return send(res, 201, startRun(await readBody(req)));
      }
      if (pathname === '/api/run/script' && req.method === 'PUT') {
        return send(res, 200, saveScript(id ?? '', await readBody(req)));
      }
      if (pathname === '/api/run/approve' && req.method === 'POST') {
        return send(res, 202, approveRun(id ?? ''));
      }
      if (pathname === '/api/run/shorts' && req.method === 'POST') {
        return send(res, 202, cutShorts(id ?? '', await readBody(req)));
      }
      if (pathname === '/api/schedule/order' && req.method === 'POST') {
        return send(res, 200, setPublishQueue(await readBody(req)));
      }
      if (pathname === '/api/run/schedule' && req.method === 'POST') {
        return send(res, 200, scheduleRelease(id ?? '', await readBody(req)));
      }
      if (pathname === '/api/run/publish' && req.method === 'POST') {
        return send(res, 200, publishRunJob(id ?? '', await readBody(req)));
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
  // every sign-in is a server somebody debugs for ten minutes.
  issueSession();

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, host, resolve));

  console.log('');
  console.log(`  Foundry studio on http://${host}:${port}`);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log('');
    console.log(`  NOT ON LOOPBACK. Anybody who can reach ${host}:${port} can reach this,`);
    console.log('  and every button in it spends money. One password is the only thing');
    console.log('  between them and a run.');
  }
  console.log('');
  return server;
};
