/**
 * Published runs, moved to Cloudflare R2 (owner, 2026-10-05).
 *
 * THE ROLLING ARCHIVE. Once a run is published, every file in its folder is
 * uploaded to a private R2 bucket under runs/<run id>/, with a metadata record
 * at index/<run id>.json (channel, title, platform audio id, when, cost).
 * Only then, once R2 confirms each file at its exact size, is the AUDIO removed
 * from the server: the text and the cover stay, so every page, list and history
 * keeps working, and the audio plays and downloads from R2 through short-lived
 * private links (see serveFile in server/index.ts).
 *
 * NEVER LOSES ANYTHING. Nothing is removed until it is confirmed in R2, a
 * failed upload leaves the run exactly as it was, and the sweep retries it.
 *
 * OFF UNLESS CONFIGURED: FOUNDRY_ARCHIVE_ENDPOINT, _BUCKET, _ACCESS_KEY_ID and
 * _SECRET_ACCESS_KEY. Without them the studio keeps everything on its volume.
 */
import fs from 'fs';
import path from 'path';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Run } from '../run/store';
import { ARCHIVE_FILE, ArchiveRecord, readArchive } from './record';
import { finalAudioFor } from '../render/backing';

/** What the archive needs from storage. A fake one in tests, R2 for real. */
export interface ArchiveStore {
  bucket: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Bytes stored at the key, or null when it is not there. */
  size(key: string): Promise<number | null>;
  /** A private link, valid for an hour. */
  url(key: string, downloadName?: string): Promise<string>;
}

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export const r2Store = (): ArchiveStore | null => {
  const { FOUNDRY_ARCHIVE_ENDPOINT: endpoint, FOUNDRY_ARCHIVE_BUCKET: bucket } = process.env;
  const accessKeyId = process.env.FOUNDRY_ARCHIVE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.FOUNDRY_ARCHIVE_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  const s3 = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey } });
  return {
    bucket,
    put: async (Key, Body, ContentType) => {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body, ContentType }));
    },
    size: async (Key) => {
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key }));
        return head.ContentLength ?? null;
      } catch {
        return null;
      }
    },
    url: (Key, downloadName) =>
      getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: bucket,
          Key,
          ...(downloadName ? { ResponseContentDisposition: `attachment; filename="${downloadName}"` } : {}),
        }),
        { expiresIn: 3600 }
      ),
  };
};

export const runKey = (runId: string, rel: string): string => `runs/${runId}/${rel}`;

/** Every file in a run folder, relative, forward slashes. */
const filesIn = (dir: string, base = dir): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return filesIn(full, base);
    return [path.relative(base, full).split(path.sep).join('/')];
  });

const isAudio = (rel: string): boolean => /\.(wav|mp3)$/i.test(rel);

export interface ArchiveDeps {
  store: ArchiveStore;
  /** Make the download MP3 before the audio goes, so a download still works. */
  makeDownload?: (run: Run) => Promise<string | null>;
  now?: () => Date;
}

/**
 * Archive one published run. Idempotent: an archived run is left alone, and a
 * run whose upload failed halfway is simply uploaded again next time.
 */
export const archiveRun = async (run: Run, deps: ArchiveDeps): Promise<ArchiveRecord | null> => {
  if (!run.isComplete('publish') || readArchive(run.dir)) return null;
  const { store } = deps;

  // Frozen BEFORE anything is removed: the final audio and its download.
  const final = finalAudioFor(run);
  const download = deps.makeDownload ? await deps.makeDownload(run) : null;

  const files = filesIn(run.dir).filter((rel) => rel !== ARCHIVE_FILE && !rel.endsWith('.part.mp3'));
  const sizes: Record<string, number> = {};
  for (const rel of files) {
    const full = path.join(run.dir, rel);
    const body = fs.readFileSync(full);
    await store.put(runKey(run.id, rel), body, MIME[path.extname(rel).toLowerCase()] ?? 'application/octet-stream');
    sizes[rel] = body.length;
  }

  // CONFIRMED, NOT ASSUMED. Every file, at its exact size, before anything goes.
  for (const [rel, bytes] of Object.entries(sizes)) {
    const stored = await store.size(runKey(run.id, rel));
    if (stored !== bytes) {
      throw new Error(`R2 has ${stored ?? 'nothing'} bytes for ${rel}, expected ${bytes}; nothing was removed`);
    }
  }

  const rel = (abs: string | null) => (abs ? path.relative(run.dir, abs).split(path.sep).join('/') : null);
  const m = run.manifest;
  let title = m.topic;
  try {
    title = (JSON.parse(fs.readFileSync(path.join(run.dir, 'script.json'), 'utf8')) as { title: string }).title;
  } catch {
    /* the topic will do */
  }
  const published = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(run.dir, 'publish.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  const archivedAt = (deps.now?.() ?? new Date()).toISOString();
  // The history entry: enough to list and find a run without opening it.
  await store.put(
    `index/${run.id}.json`,
    Buffer.from(
      JSON.stringify(
        {
          runId: run.id,
          channel: m.personaId,
          format: m.formatId,
          title,
          topic: m.topic,
          createdAt: m.createdAt,
          spentPence: m.spentPence,
          audioId: published.audioId ?? null,
          publishedAt: published.publishedAt ?? null,
          platform: published.url ?? null,
          archivedAt,
          files: sizes,
        },
        null,
        2
      )
    ),
    'application/json'
  );

  const removed = Object.keys(sizes).filter(isAudio);
  const record: ArchiveRecord = {
    archivedAt,
    bucket: store.bucket,
    prefix: `runs/${run.id}`,
    files: sizes,
    final: final
      ? { file: rel(final.file)!, key: final.key, music: final.music, speed: final.speed }
      : null,
    download: rel(download),
    removed,
  };
  // The record first, THEN the removal: a crash between the two leaves files
  // that are both here and in R2, never files that are in neither.
  fs.writeFileSync(path.join(run.dir, ARCHIVE_FILE), JSON.stringify(record, null, 2));
  for (const r of removed) fs.rmSync(path.join(run.dir, r), { force: true });
  return record;
};

/**
 * Archive every published run that is not archived yet. Run on start-up and on
 * a timer, so a publish whose archive failed (or ran from the command line,
 * which exits before it finishes) is never forgotten.
 */
export const sweepArchive = async (
  deps: ArchiveDeps,
  log: (message: string) => void = () => undefined
): Promise<{ archived: string[]; failed: Array<{ runId: string; error: string }> }> => {
  const archived: string[] = [];
  const failed: Array<{ runId: string; error: string }> = [];
  for (const id of Run.list()) {
    let run: Run;
    try {
      run = Run.open(id);
    } catch {
      continue;
    }
    if (!run.isComplete('publish') || readArchive(run.dir)) continue;
    try {
      await archiveRun(run, deps);
      archived.push(id);
      log(`archived ${id} to R2`);
    } catch (e) {
      failed.push({ runId: id, error: (e as Error).message });
      log(`could not archive ${id}: ${(e as Error).message}`);
    }
  }
  return { archived, failed };
};

/** The studio's record files, kept current in R2 beside the runs. */
export const backUpRecords = async (store: ArchiveStore, root: string): Promise<void> => {
  for (const name of ['voices.json', 'catalogue.json', 'series.json']) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) await store.put(`state/${name}`, fs.readFileSync(file), 'application/json');
  }
};
