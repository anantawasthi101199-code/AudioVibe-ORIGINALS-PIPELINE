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
import {
  audioPath,
  buildBeat,
  listBeats,
  loadBeat,
  saveBeat,
  settingsFor,
} from '../render/beats';
import { CONTROLS, DEFAULTS, describe as describeSynth, synthSchema } from '../render/synth';
import { suggestSynth } from '../render/synthSuggest';
import { AnthropicClient } from '../models/client';
import { clerkConfig } from '../config';
import { loadBible } from '../fiction/bible';
import { checkPlan, loadPlan, planDrift, renderPlan } from '../fiction/season';
import { findCovered, loadCatalogue } from '../catalogue/covered';
import { HttpError } from './routes';

/**
 * Every beat, and every knob the page needs to draw a form.
 *
 * THE CONTROLS COME FROM THE ENGINE, NOT FROM THE PAGE. `CONTROLS` is the one
 * definition of what a knob is, what it ranges over and what it does, and it is
 * sent down the wire so the interface cannot hold a second copy that drifts. A
 * control added in synth.ts appears in the form without the page being touched.
 */
export const getBeats = () => ({
  controls: CONTROLS,
  defaults: DEFAULTS,
  beats: listBeats().map((b) => {
    const settings = settingsFor(b);
    return {
      name: b.name,
      note: b.note,
      madeAt: b.madeAt,
      settings,
      summary: describeSynth(settings),
      rendered: fs.existsSync(audioPath(b.name)),
    };
  }),
});

export const makeBeatSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and hyphens only'),
  note: z.string().max(200).default(''),
  /** Every knob. Absent means start from the defaults. */
  settings: synthSchema.optional(),
});

export const suggestBeatSchema = z.object({
  describe: z.string().min(3).max(500),
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
  const existing = loadBeat(input.name);

  const recipe = {
    name: input.name,
    note: input.note,
    // Kept from the original, so re-rendering a beat does not make it look new.
    madeAt: existing?.madeAt ?? new Date().toISOString(),
    settings: input.settings ?? (existing ? settingsFor(existing) : DEFAULTS),
  };

  saveBeat(recipe);

  // Always forced. The cache is keyed by the audio existing rather than by the
  // settings, so changing a knob and keeping the old file is the one stale
  // result this design can produce.
  const built = await buildBeat(recipe, { force: true });
  if (!built.ok) throw new HttpError(500, built.reason ?? 'could not synthesise it');

  return {
    beat: {
      ...recipe,
      summary: describeSynth(recipe.settings),
      rendered: true,
    },
  };
};

/**
 * Settings for a description, without making anything.
 *
 * SUGGESTING AND MAKING ARE TWO REQUESTS ON PURPOSE. The suggestion fills the
 * form in and stops, so whoever asked can see what it chose, change it, and
 * only then press the button. A single call that went straight to audio would
 * make the model the author rather than a starting point, and would hide which
 * of the two dozen values it actually picked.
 */
export const suggestBeat = async (body: unknown) => {
  const input = suggestBeatSchema.parse(body);
  const cfg = clerkConfig();
  let pence = 0;

  const suggestion = await suggestSynth(
    input.describe,
    new AnthropicClient(cfg.model, cfg.apiKey),
    (p) => {
      pence += p;
    }
  );

  return { ...suggestion, pence, summary: describeSynth(suggestion.settings) };
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
