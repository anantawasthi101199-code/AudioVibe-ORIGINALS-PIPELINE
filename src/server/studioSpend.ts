/**
 * Money spent outside any run (owner, 2026-10-09): topic suggestions on a
 * channel page and beat suggestions in the Beats tab each call a model, and
 * that cost used to go nowhere. Every such call is appended here, one JSON line
 * each, and summed back for the page that made it.
 *
 * A FILE BESIDE THE RUNS, not inside one: these calls belong to no run, and
 * Run.list only reads directories, so a file at the top of runs/ is never
 * mistaken for one.
 */
import fs from 'fs';
import path from 'path';
import { runsDir } from '../config';

export interface StudioSpend {
  at: string;
  /** The channel it was for, or null (the beat library). */
  channelId: string | null;
  /** What was paid for: "suggest topics", "suggest a beat". */
  what: string;
  pence: number;
  who: string | null;
}

const ledger = (): string => path.join(runsDir(), 'studio-spend.jsonl');

export const recordStudioSpend = (entry: Omit<StudioSpend, 'at'>, at = new Date()): void => {
  try {
    fs.mkdirSync(runsDir(), { recursive: true });
    fs.appendFileSync(ledger(), `${JSON.stringify({ at: at.toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    // Never let the record of a cost fail the thing that cost it.
  }
};

const readAll = (): StudioSpend[] => {
  if (!fs.existsSync(ledger())) return [];
  return fs
    .readFileSync(ledger(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as StudioSpend];
      } catch {
        return [];
      }
    });
};

/** What a channel has spent outside its runs: everything, and the last 30 days. */
export const studioSpendFor = (channelId: string | null, now = new Date()) => {
  const mine = readAll().filter((e) => e.channelId === channelId);
  const since = now.getTime() - 30 * 86_400_000;
  const sum = (xs: StudioSpend[]) => Math.round(xs.reduce((n, e) => n + e.pence, 0) * 10) / 10;
  return {
    totalPence: sum(mine),
    last30Pence: sum(mine.filter((e) => Date.parse(e.at) >= since)),
    calls: mine.length,
  };
};
