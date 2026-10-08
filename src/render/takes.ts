/**
 * Takes: every finished voicing of a run, kept, and one chosen to publish
 * (owner, 2026-10-08).
 *
 * REGENERATING DOES NOT REPLACE. A voicing is a performance, and the second
 * one is not always better than the first. So each finished voicing is copied
 * into `takes/` with the render record and gate report that belong to it, and
 * a person picks the one that goes out. The chosen take is copied back into
 * `media/episode.wav` (with its render.json and qa.json), so everything that
 * publishes, mixes music or plays audio keeps reading the one place it always
 * has, and needs to know nothing about takes.
 *
 * A TAKE OF EARLIER WORDS CANNOT BE CHOSEN. Each take records a hash of the
 * script it voiced; once the script is edited, older takes are shown as from an
 * earlier script and are kept only to listen to.
 *
 * ONCE PUBLISHED, OR APPROVED FOR A DAY, THE CHOICE IS FIXED: the same lock as
 * the music (musicLock), and the other takes stay as drafts.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { Run } from '../run/store';
import { musicLock } from './backing';

export class TakeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TakeRefused';
  }
}

const takeSchema = z.object({
  id: z.number().int().positive(),
  /** Relative to the run directory. */
  file: z.string(),
  render: z.string().nullable(),
  qa: z.string().nullable(),
  createdAt: z.string(),
  engine: z.string(),
  durationS: z.number().nullable(),
  by: z.string().nullable().default(null),
  /** Hash of the script's words this take voiced. */
  scriptHash: z.string(),
  /** The episode.wav this take is, by size and modified time, to recognise it. */
  sig: z.object({ bytes: z.number(), mtimeMs: z.number() }),
});
export type Take = z.infer<typeof takeSchema>;

const recordSchema = z.object({
  takes: z.array(takeSchema).default([]),
  chosen: z.number().int().positive().nullable().default(null),
});
type TakeRecord = z.infer<typeof recordSchema>;

const recordFile = (run: Run) => path.join(run.dir, 'takes.json');

export const readTakes = (run: Run): TakeRecord => {
  try {
    return recordSchema.parse(JSON.parse(fs.readFileSync(recordFile(run), 'utf8')));
  } catch {
    return { takes: [], chosen: null };
  }
};

const writeTakes = (run: Run, record: TakeRecord): void => {
  fs.writeFileSync(recordFile(run), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
};

/** The words a take voiced, as a hash: speaker and text of every turn. */
export const scriptHashOf = (run: Run): string | null => {
  const file = path.join(run.dir, 'script.json');
  if (!fs.existsSync(file)) return null;
  try {
    const script = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      beats?: Array<{ turns?: Array<{ speaker?: string; text?: string }> }>;
    };
    const words = (script.beats ?? []).map((b) => (b.turns ?? []).map((t) => [t.speaker, t.text]));
    return crypto.createHash('sha256').update(JSON.stringify(words)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
};

const voicePath = (run: Run) => path.join(run.dir, 'media', 'episode.wav');

const signature = (file: string) => {
  const st = fs.statSync(file);
  return { bytes: st.size, mtimeMs: Math.round(st.mtimeMs) };
};

const sameSig = (a: Take['sig'], b: Take['sig']) => a.bytes === b.bytes && a.mtimeMs === b.mtimeMs;

/** A run whose current voice is finished: voiced and gated over its audio. */
const voicedNow = (run: Run): boolean =>
  run.isComplete('render') && run.isComplete('qa') && fs.existsSync(voicePath(run));

/**
 * Record the current voice as a take if it is new, and keep the choice right.
 *
 * Called after every voicing and whenever a run is read, so a voicing made from
 * the command line is recorded too. A NEW TAKE DOES NOT TAKE OVER: when the
 * previously chosen take voiced the same words, that one is put back and stays
 * chosen. When it voiced earlier words (the script was edited), the new take is
 * chosen, because the old one no longer says what the script says.
 */
export const syncTakes = (run: Run, by: string | null = null, now = new Date()): TakeRecord => {
  const record = readTakes(run);
  if (!voicedNow(run)) return record;
  if (run.isComplete('publish') && record.takes.length) return record;

  const sig = signature(voicePath(run));
  const known = record.takes.find((t) => sameSig(t.sig, sig));
  if (known) {
    if (record.chosen === null) {
      record.chosen = known.id;
      writeTakes(run, record);
    }
    return record;
  }

  const id = Math.max(0, ...record.takes.map((t) => t.id)) + 1;
  const dir = path.join(run.dir, 'takes');
  fs.mkdirSync(dir, { recursive: true });
  const name = `take-${String(id).padStart(2, '0')}`;
  const copy = (from: string, to: string): string | null => {
    if (!fs.existsSync(from)) return null;
    fs.copyFileSync(from, path.join(dir, to));
    return path.join('takes', to);
  };

  let durationS: number | null = null;
  let engine: string = run.manifest.voiceEngine;
  try {
    const render = JSON.parse(fs.readFileSync(path.join(run.dir, 'render.json'), 'utf8')) as {
      durationS?: number;
      provider?: string;
    };
    durationS = render.durationS ?? null;
    engine = render.provider ?? engine;
  } catch {
    // No record: the duration is shown as unknown.
  }

  const take: Take = {
    id,
    file: copy(voicePath(run), `${name}.wav`)!,
    render: copy(path.join(run.dir, 'render.json'), `${name}.render.json`),
    qa: copy(path.join(run.dir, 'qa.json'), `${name}.qa.json`),
    createdAt: now.toISOString(),
    engine,
    durationS,
    by,
    scriptHash: scriptHashOf(run) ?? '',
    sig,
  };
  record.takes.push(take);

  const previous = record.takes.find((t) => t.id === record.chosen);
  const keepPrevious = previous && previous.scriptHash === take.scriptHash && !musicLock(run);
  if (keepPrevious) {
    writeTakes(run, record);
    run.journal({ stage: 'render', event: `take ${id} kept as a draft; take ${previous.id} still publishes` });
    return restore(run, record, previous.id);
  }
  record.chosen = id;
  writeTakes(run, record);
  run.journal({ stage: 'render', event: `take ${id} recorded and chosen` });
  return record;
};

/** Copy a take back into place: the voice, its render record and its gate report. */
const restore = (run: Run, record: TakeRecord, id: number): TakeRecord => {
  const take = record.takes.find((t) => t.id === id);
  if (!take) throw new TakeRefused(`there is no take ${id}`);
  const src = path.join(run.dir, take.file);
  if (!fs.existsSync(src)) throw new TakeRefused(`take ${id}'s audio is missing`);

  fs.mkdirSync(path.dirname(voicePath(run)), { recursive: true });
  fs.copyFileSync(src, voicePath(run));
  if (take.render) fs.copyFileSync(path.join(run.dir, take.render), path.join(run.dir, 'render.json'));
  if (take.qa) fs.copyFileSync(path.join(run.dir, take.qa), path.join(run.dir, 'qa.json'));
  run.markComplete('render');
  run.markComplete('qa');

  // The compressed copy players get is keyed on the WAV's modified time, which
  // the copy above just changed, so it is remade on the next play.
  take.sig = signature(voicePath(run));
  record.chosen = id;
  writeTakes(run, record);
  return record;
};

/** Choose which take publishes. */
export const chooseTake = (run: Run, id: number, who: string | null = null): TakeRecord => {
  const lock = musicLock(run);
  if (lock) throw new TakeRefused(lock.replace('its music', 'which take goes out'));
  const record = syncTakes(run);
  const take = record.takes.find((t) => t.id === id);
  if (!take) throw new TakeRefused(`there is no take ${id}`);
  const current = scriptHashOf(run);
  if (current && take.scriptHash !== current) {
    throw new TakeRefused(`take ${id} voiced an earlier version of the script, so it cannot be published`);
  }
  if (record.chosen === id && voicedNow(run)) return record;
  const out = restore(run, record, id);
  run.journal({ stage: 'render', event: `take ${id} chosen to publish${who ? ` by ${who}` : ''}` });
  return out;
};

/** A take's audio file, for the player. */
export const takeFile = (run: Run, id: number): string | null => {
  const take = readTakes(run).takes.find((t) => t.id === id);
  return take ? path.join(run.dir, take.file) : null;
};

/** What the page shows. */
export const takesView = (run: Run) => {
  const record = syncTakes(run);
  const current = scriptHashOf(run);
  const lock = musicLock(run);
  return {
    chosen: record.chosen,
    locked: lock,
    takes: record.takes.map((t) => ({
      id: t.id,
      createdAt: t.createdAt,
      engine: t.engine,
      durationS: t.durationS,
      by: t.by,
      earlierScript: Boolean(current && t.scriptHash !== current),
      audioKey: `${t.id}-${t.sig.mtimeMs}`,
    })),
  };
};
