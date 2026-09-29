/**
 * The beat library, the season plans and the covered ledger, for the interface.
 *
 * THIN, LIKE THE REST OF routes.ts. Every function here loads something the
 * command line already loads, calls something that already existed, and
 * serialises the answer. Nothing decides anything. The moment one of these
 * looks like it is about to enforce a rule, the rule belongs in the module the
 * command line also goes through, or the two front ends have started
 * disagreeing about what the studio does.
 *
 * WHY THE BEAT ROUTES MATTER MORE THAN THEY LOOK. A beat is the one artifact in
 * the studio whose whole value is that somebody LISTENED to it before choosing
 * it. On the command line that means finding the file and opening it yourself.
 * In a browser it is an audio element, which is the difference between a
 * feature that gets used and one that does not.
 */
import fs from 'fs';
import { z } from 'zod';
import { loadPersona } from '../canon/load';
import { BED_STYLES, isBedStyle } from '../render/bed';
import {
  KEYS,
  audioPath,
  buildBeat,
  isKey,
  listBeats,
  loadBeat,
  saveBeat,
} from '../render/beats';
import { loadBible } from '../fiction/bible';
import { checkPlan, loadPlan, planDrift, renderPlan } from '../fiction/season';
import { findCovered, loadCatalogue } from '../catalogue/covered';
import { HttpError } from './routes';

/** Every beat, with whether its audio is on disk and can be played. */
export const getBeats = () => ({
  styles: BED_STYLES.filter((s) => s !== 'none'),
  keys: Object.keys(KEYS),
  beats: listBeats().map((b) => ({
    ...b,
    rendered: fs.existsSync(audioPath(b.name)),
  })),
});

export const makeBeatSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and hyphens only'),
  style: z.string(),
  key: z.string(),
  note: z.string().max(200).default(''),
});

/**
 * Make or replace one beat, synchronously.
 *
 * NOT A JOB, UNLIKE STARTING A RUN, and the difference is what is at stake. A
 * run spends money and takes minutes, so it has to be watchable and cancellable.
 * Synthesising a phrase is a few seconds of local ffmpeg and costs nothing, so
 * a job would add a state machine to a thing that finishes before the spinner
 * is worth drawing.
 */
export const makeBeat = async (body: unknown) => {
  const input = makeBeatSchema.parse(body);
  const key = input.key.toLowerCase();

  if (!isBedStyle(input.style) || input.style === 'none') {
    throw new HttpError(400, `style must be one of: ${BED_STYLES.filter((s) => s !== 'none').join(', ')}`);
  }
  if (!isKey(key)) {
    throw new HttpError(400, `key must be one of: ${Object.keys(KEYS).join(', ')}`);
  }

  const existing = loadBeat(input.name);
  const recipe = {
    name: input.name,
    style: input.style,
    key,
    note: input.note,
    // Kept from the original, so re-rendering a beat does not make it look new.
    madeAt: existing?.madeAt ?? new Date().toISOString(),
  };

  saveBeat(recipe);

  // Always forced. The cache is keyed by the audio file existing rather than by
  // the recipe's contents, so changing the key and keeping the old mp3 is the
  // one stale result this design can produce.
  const built = await buildBeat(recipe, { force: true });
  if (!built.ok) throw new HttpError(500, built.reason ?? 'could not synthesise it');

  return { beat: { ...recipe, rendered: true } };
};

/** The rendered loop, for an audio element to play. */
export const beatAudioPath = (name: string): string => {
  if (!/^[a-z0-9-]+$/.test(name)) throw new HttpError(400, 'not a beat name');

  const file = audioPath(name);
  if (!fs.existsSync(file)) throw new HttpError(404, `"${name}" has not been rendered`);
  return file;
};

/**
 * A show's season plan, its free checks, and where it has drifted.
 *
 * Returns a null plan rather than a 404 for a show that has not been broken
 * yet, because "no season planned" is a state the page has something to say
 * about rather than an error.
 */
export const getSeason = (showId: string, season: number) => {
  const persona = loadPersona(showId);
  if (!persona.fiction) {
    throw new HttpError(400, `${persona.name} is not a fiction show, so it has no season plan`);
  }

  const plan = loadPlan(showId, season);
  if (!plan) return { show: persona.name, season, plan: null };

  const bible = loadBible(showId);

  return {
    show: persona.name,
    season,
    plan,
    rendered: renderPlan(plan),
    problems: checkPlan(plan, persona.hosts.map((h) => h.name)),
    drift: planDrift(plan, bible),
    /** Which episode the next run would write, so the page can point at a card. */
    nextEpisode: bible.episodes.length + 1,
  };
};

/**
 * What a show has already covered, and optionally whether one topic clashes.
 *
 * The clash check is the same call `make` makes before it spends anything, so
 * the page can warn while somebody is still typing rather than after they have
 * pressed the button.
 */
export const getCovered = (showId: string | null, topic: string | null) => {
  const catalogue = loadCatalogue();
  const entries = catalogue.entries
    .filter((e) => !showId || e.showId === showId)
    .sort((a, b) => b.madeAt.localeCompare(a.madeAt));

  return {
    entries,
    matches: topic && showId ? findCovered(catalogue, showId, topic) : [],
  };
};
