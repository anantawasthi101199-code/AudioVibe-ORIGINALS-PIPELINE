/**
 * The season plan: what a serial intends to do, before it does any of it.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE BIBLE. bible.ts records what a
 * listener has already HEARD, and refuses to hold plot on purpose: "storing
 * intentions here would make the continuity check enforce an outline, and an
 * outline is a thing a writer should be allowed to abandon." That is right, and
 * this file is the other half of the same thought. History lives there,
 * intention lives here, and the two are compared only to REPORT drift.
 *
 * THE PROBLEM IT SOLVES. A serial written one episode at a time from a summary
 * of the last one cannot foreshadow, because nothing knows where episode eight
 * ends. Everything the form is actually good at - a line in episode two that
 * only detonates in episode seven, a character whose first scene reads
 * differently once you know - requires the writer to know the destination while
 * writing the departure. Forward-only generation cannot plant.
 *
 * THE OTHER OPTION WAS WORSE. Generate sixty minutes of continuous story and
 * cut it at the tense moments. A cliffhanger is not a place you stop, it is a
 * thing you build toward, and the minutes before it exist to make it land.
 * Chopping continuous prose puts the break where the scissors fell rather than
 * where it was earned, gives episode four no hook of its own, and makes fixing
 * episode six a reason to regenerate all sixty minutes.
 *
 * So: plan the season once, cheaply, then write each episode against the plan.
 * This is what a writers' room calls breaking the season, and it is also what
 * the research converged on independently. Dramatron and Re3 both found flat
 * sequential generation loses the plot, and both fixed it with hierarchy.
 *
 * PROMISES ARE THE LOAD-BEARING PART. Every card names what it PLANTS and what
 * it PAYS OFF, by id. That turns the vaguest thing about serial writing into
 * arithmetic: a promise planted and never paid is a detectable bug, found for
 * free, before a single episode is written or a single penny spent on prose.
 * Nothing else in this repo can check that, and no model needs to.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { seasonsDir } from '../config';
import { Bible, castBrief, storySoFar } from './bible';

/**
 * How many people a listener can hold.
 *
 * FIVE, AND IT IS A PROPERTY OF THE EAR RATHER THAN OF THE STORY. Audio has one
 * channel to tell characters apart with, and the craft writing on sound-only
 * drama is consistent that a scene tops out around three or four speakers
 * before a listener stops tracking who is who. Across a whole series the number
 * carried without effort is not much larger.
 *
 * This caps the carry tier only. A season may name as many people as it likes
 * in passing; what it may not do is ask the listener to REMEMBER more than
 * this. The distinction is the same carry-versus-texture split the myth lane
 * uses, and it exists here for the identical reason.
 */
export const MAX_CARRY_CAST = 5;

/** Fewer than this is an anthology; more, and the spine sags in the middle. */
export const SEASON_EPISODES: readonly [number, number] = [5, 10];

/**
 * A thread the season opens and must close.
 *
 * WHY IT IS A FIRST-CLASS OBJECT rather than something the prose implies. An
 * unpaid promise is the commonest way a serial disappoints, and it is invisible
 * from inside any one episode: every episode reads fine and the season still
 * owes the listener four answers it never gives. Naming them makes the debt
 * countable, and a countable debt can be checked for nothing.
 */
export const promiseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'lowercase, digits and hyphens only'),
  /** What the listener is made to wonder, in their words rather than the plot's. */
  text: z.string().min(1),
});

export type SeasonPromise = z.infer<typeof promiseSchema>;

export const episodeCardSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  /**
   * Where we come in. Not a summary of the episode, the first image of it.
   *
   * A serial episode opens INSIDE something already happening, so this is
   * written as a moment rather than as a situation.
   */
  opens: z.string().min(1),
  /** What happens, in a paragraph. */
  story: z.string().min(1),
  /**
   * What is irreversibly different by the end.
   *
   * THE FIELD THAT STOPS A SEASON IDLING. An episode where nothing changes is a
   * connective episode, and a run of them is how a serial loses people. If this
   * is hard to fill in, that is the plan telling you something while it is
   * still free to listen.
   */
  changes: z.string().min(1),
  /**
   * The last thing the listener hears.
   *
   * Empty on the finale alone, which is the one episode allowed to close rather
   * than open.
   */
  cliffhanger: z.string(),
  /** Promise ids this episode opens. */
  plants: z.array(z.string()).default([]),
  /** Promise ids this episode closes. */
  paysOff: z.array(z.string()).default([]),
});

export type EpisodeCard = z.infer<typeof episodeCardSchema>;

export const seasonPlanSchema = z.object({
  personaId: z.string().min(1),
  seasonNumber: z.number().int().positive(),
  title: z.string().min(1),
  /** The season in one sentence, as a listener would describe it to a friend. */
  premise: z.string().min(1),
  /**
   * The one thing the season is about, and how it settles.
   *
   * Written down at the start so every episode can be aimed at it. This is the
   * series question that individual episodes deliberately do not answer.
   */
  spine: z.string().min(1),
  /** The rules of the place. Short, and only what the story leans on. */
  world: z.array(z.string()).default([]),
  /**
   * Who the listener is asked to remember. Capped at MAX_CARRY_CAST.
   *
   * Names with one line each. The full entity record is the bible's job, and it
   * is written from what the episodes actually established rather than from
   * what was planned here.
   */
  carryCast: z
    .array(z.object({ name: z.string().min(1), who: z.string().min(1) }))
    .default([]),
  promises: z.array(promiseSchema).default([]),
  episodes: z.array(episodeCardSchema).min(1),
});

export type SeasonPlan = z.infer<typeof seasonPlanSchema>;

export class SeasonPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeasonPlanError';
  }
}

const planPath = (personaId: string, season: number, dir?: string): string =>
  path.join(dir ?? seasonsDir(), `${personaId}-s${season}.json`);

export const loadPlan = (
  personaId: string,
  season: number,
  dir?: string
): SeasonPlan | null => {
  const file = planPath(personaId, season, dir);
  if (!fs.existsSync(file)) return null;
  return seasonPlanSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
};

export const savePlan = (plan: SeasonPlan, dir?: string): string => {
  const target = dir ?? seasonsDir();
  fs.mkdirSync(target, { recursive: true });
  const file = planPath(plan.personaId, plan.seasonNumber, target);
  fs.writeFileSync(file, `${JSON.stringify(seasonPlanSchema.parse(plan), null, 2)}\n`, 'utf8');
  return file;
};

/**
 * A ceiling on the season scan, so a missing plan cannot loop forever.
 *
 * Nothing here is a real limit on how long a show may run. It is the number of
 * seasons this will look through before deciding a show has not planned that
 * far, and fifty is far past any serial this studio will make.
 */
const MAX_SEASONS_SCANNED = 50;

export interface EpisodeLocation {
  plan: SeasonPlan;
  /** Which episode of THAT season, one-based. */
  number: number;
}

/**
 * Which season an episode belongs to, given how many the show has made.
 *
 * WHY THIS IS ARITHMETIC AND NOT A FIELD. The bible counts every episode a show
 * has ever published, and a season counts from one. Storing the season on a run
 * would mean two records of the same fact that can disagree, and the one that
 * disagreed would be discovered at the worst moment: episode nine written
 * against season one's card nine, which does not exist.
 *
 * Returns null when the show has not planned that far, which is not an error.
 * It is a show that needs its next season broken, and the pipeline says so.
 */
export const locateEpisode = (
  personaId: string,
  overallNumber: number,
  dir?: string
): EpisodeLocation | null => {
  let remaining = overallNumber;

  for (let season = 1; season <= MAX_SEASONS_SCANNED; season += 1) {
    const plan = loadPlan(personaId, season, dir);
    // A gap in the seasons is the same as the end of them. A show with season
    // one and season three planned has not planned season two, and guessing
    // which card episode nine wants is exactly the guess this file exists to
    // stop anybody making.
    if (!plan) return null;
    if (remaining <= plan.episodes.length) return { plan, number: remaining };
    remaining -= plan.episodes.length;
  }

  return null;
};

/**
 * Everything wrong with a plan that can be found without a model.
 *
 * FREE, AND IT RUNS BEFORE ANY EPISODE IS WRITTEN. That ordering is the whole
 * value. A season whose finale owes the listener three unanswered questions
 * costs pennies to detect here and several pounds of generated prose to detect
 * by listening. Every check below is arithmetic over a small JSON object.
 *
 * Returns human sentences rather than codes, because the audience for this is a
 * person deciding whether to approve the plan.
 */
export const checkPlan = (plan: SeasonPlan, hostNames: string[] = []): string[] => {
  const problems: string[] = [];
  const known = new Set(plan.promises.map((p) => p.id));

  // THE SHOW'S OWN PEOPLE, AND THIS IS THE MOST EXPENSIVE THING ON THE LIST TO
  // GET WRONG. A host is a bought, registered voice that a listener has already
  // heard; the voice registry refuses to let one change mid-series precisely
  // because a serial is where that hurts most. A season planned around somebody
  // else cannot be recorded at all, and the first place anybody would notice is
  // the render, after every episode had been written and paid for.
  const carried = new Set(plan.carryCast.map((c) => c.name.toLowerCase()));
  for (const host of hostNames) {
    if (!carried.has(host.toLowerCase())) {
      problems.push(
        `the show's own ${host} is not in the season's cast. A host is a registered voice, ` +
          `so a season without them is a season that cannot be recorded.`
      );
    }
  }

  const [minEps, maxEps] = SEASON_EPISODES;
  if (plan.episodes.length < minEps || plan.episodes.length > maxEps) {
    problems.push(
      `the season has ${plan.episodes.length} episodes, outside the ${minEps} to ${maxEps} a spine holds`
    );
  }

  if (plan.carryCast.length > MAX_CARRY_CAST) {
    problems.push(
      `${plan.carryCast.length} people to remember, and a listener holds about ${MAX_CARRY_CAST}. ` +
        `Someone has to become a name said once where they act, rather than a name carried.`
    );
  }

  // Numbering. A gapped or reordered season breaks the brief assembly, which
  // reads "the next card" by number.
  plan.episodes.forEach((ep, i) => {
    if (ep.number !== i + 1) {
      problems.push(`the episode at position ${i + 1} is numbered ${ep.number}`);
    }
  });

  const plantedIn = new Map<string, number>();
  const paidIn = new Map<string, number>();

  for (const ep of plan.episodes) {
    for (const id of ep.plants) {
      if (!known.has(id)) {
        problems.push(`episode ${ep.number} plants "${id}", which is not in the promise list`);
        continue;
      }
      if (plantedIn.has(id)) {
        problems.push(
          `"${id}" is planted twice, in episodes ${plantedIn.get(id)} and ${ep.number}. ` +
            `A promise made twice was not made clearly the first time.`
        );
        continue;
      }
      plantedIn.set(id, ep.number);
    }

    for (const id of ep.paysOff) {
      if (!known.has(id)) {
        problems.push(`episode ${ep.number} pays off "${id}", which is not in the promise list`);
        continue;
      }
      if (paidIn.has(id)) {
        problems.push(`"${id}" is paid off twice, in episodes ${paidIn.get(id)} and ${ep.number}`);
        continue;
      }
      paidIn.set(id, ep.number);
    }
  }

  for (const promise of plan.promises) {
    const planted = plantedIn.get(promise.id);
    const paid = paidIn.get(promise.id);

    if (planted === undefined) {
      problems.push(`"${promise.id}" is paid off but never planted: ${promise.text}`);
    }
    if (paid === undefined) {
      // THE CHECK THIS FILE EXISTS FOR.
      problems.push(`"${promise.id}" is never paid off: ${promise.text}`);
      continue;
    }
    if (planted !== undefined && paid <= planted) {
      problems.push(
        `"${promise.id}" is paid off in episode ${paid}, at or before the episode ${planted} that plants it. ` +
          `A promise closed in the episode that opens it is a scene, not a thread.`
      );
    }
  }

  plan.episodes.forEach((ep, i) => {
    const isFinale = i === plan.episodes.length - 1;
    const has = ep.cliffhanger.trim().length > 0;
    if (!isFinale && !has) {
      problems.push(
        `episode ${ep.number} has no cliffhanger, so nothing makes the next one necessary`
      );
    }
    if (isFinale && has) {
      problems.push(
        `the finale has a cliffhanger. A season that does not land is a season nobody recommends.`
      );
    }
  });

  return problems;
};

/**
 * The plan as a person reads it, for the approval stop.
 *
 * THIS IS THE CHEAPEST CONTROL POINT IN THE LANE. A season rejected here costs
 * the price of one small call; the same season rejected after generation costs
 * every episode in it. So this is built for reading and deciding rather than
 * for completeness.
 */
export const renderPlan = (plan: SeasonPlan): string => {
  const promiseText = new Map(plan.promises.map((p) => [p.id, p.text]));
  const lines: string[] = [];

  lines.push(`${plan.title}  (season ${plan.seasonNumber}, ${plan.episodes.length} episodes)`);
  lines.push('');
  lines.push(plan.premise);
  lines.push('');
  lines.push('THE SPINE');
  lines.push(`  ${plan.spine}`);

  if (plan.carryCast.length) {
    lines.push('');
    lines.push('WHO YOU ARE ASKED TO REMEMBER');
    for (const c of plan.carryCast) lines.push(`  ${c.name}: ${c.who}`);
  }

  if (plan.world.length) {
    lines.push('');
    lines.push('THE WORLD');
    for (const w of plan.world) lines.push(`  - ${w}`);
  }

  for (const ep of plan.episodes) {
    lines.push('');
    lines.push(`--- ${ep.number}. ${ep.title} ---`);
    lines.push(`  OPENS ON    ${ep.opens}`);
    lines.push(`  STORY       ${ep.story}`);
    lines.push(`  CHANGES     ${ep.changes}`);
    lines.push(`  ENDS ON     ${ep.cliffhanger || '(the finale, which lands rather than opens)'}`);
    for (const id of ep.plants) lines.push(`  PLANTS      ${promiseText.get(id) ?? id}`);
    for (const id of ep.paysOff) lines.push(`  PAYS OFF    ${promiseText.get(id) ?? id}`);
  }

  return lines.join('\n');
};

/**
 * What the writer of one episode is shown.
 *
 * THE NEXT CARD IS IN HERE ON PURPOSE, and it is the single thing separating a
 * cliffhanger aimed at from a cliffhanger arrived at. A writer who knows what
 * the following episode opens on can end this one so that it is necessary; a
 * writer who does not can only stop somewhere tense.
 *
 * WHAT IS DELIBERATELY WITHHELD: every card after the next one. A writer shown
 * the whole season writes towards the finale from episode two, and the planting
 * stops being planting and becomes announcing.
 */
export const briefForEpisode = (
  plan: SeasonPlan,
  bible: Bible,
  number: number
): string => {
  const card = plan.episodes.find((e) => e.number === number);
  if (!card) throw new SeasonPlanError(`season ${plan.seasonNumber} has no episode ${number}`);

  const next = plan.episodes.find((e) => e.number === number + 1);
  const promiseText = new Map(plan.promises.map((p) => [p.id, p.text]));

  // Threads the listener is currently holding: planted at or before this
  // episode and not yet paid. The writer needs these, because a scene that
  // ignores an open question the listener is carrying reads as a scene that
  // forgot about it.
  const open: string[] = [];
  for (const p of plan.promises) {
    const planted = plan.episodes.find((e) => e.plants.includes(p.id));
    const paid = plan.episodes.find((e) => e.paysOff.includes(p.id));
    if (planted && planted.number <= number && (!paid || paid.number > number)) {
      open.push(p.text);
    }
  }

  const parts = [
    `THE SEASON: ${plan.premise}`,
    `THE SPINE, which this episode does not settle: ${plan.spine}`,
    '',
    `THE STORY SO FAR, as a listener heard it:\n${storySoFar(bible)}`,
    '',
    `THE CAST, as established:\n${castBrief(bible)}`,
    '',
    `THIS EPISODE (${card.number}. ${card.title})`,
    `  Open on: ${card.opens}`,
    `  What happens: ${card.story}`,
    `  What is different by the end: ${card.changes}`,
    card.cliffhanger
      ? `  End on: ${card.cliffhanger}`
      : `  This is the finale. It lands. No cliffhanger.`,
  ];

  if (card.paysOff.length) {
    parts.push(
      '',
      'ANSWER THESE, properly, in this episode:',
      ...card.paysOff.map((id) => `  - ${promiseText.get(id) ?? id}`)
    );
  }

  if (card.plants.length) {
    parts.push(
      '',
      'PLANT THESE. Lay them down so they read as ordinary now and matter later.',
      'Do not flag them. A planted thing that announces itself has been spent.',
      ...card.plants.map((id) => `  - ${promiseText.get(id) ?? id}`)
    );
  }

  if (open.length) {
    parts.push(
      '',
      'STILL OPEN for the listener, and not answered here:',
      ...open.map((t) => `  - ${t}`)
    );
  }

  if (next) {
    parts.push(
      '',
      `WHERE THE NEXT EPISODE PICKS UP: ${next.opens}`,
      'End this one so that is necessary rather than merely next.'
    );
  }

  return parts.join('\n');
};

/**
 * Where the season has drifted from its plan.
 *
 * ADVISORY, ALWAYS, AND NEVER BLOCKING. The plan is intention and the bible is
 * history, and when they disagree the history is what happened. An episode that
 * came out better than its card is a good outcome, not a fault. What this
 * catches is the other case: a later card assuming something the episodes no
 * longer support, which is a plan going quietly stale while every individual
 * episode still passes its own checks.
 */
export const planDrift = (plan: SeasonPlan, bible: Bible): string[] => {
  const notes: string[] = [];
  const written = bible.episodes.length;
  if (written === 0) return notes;

  const known = new Set(bible.entities.map((e) => e.name.toLowerCase()));
  for (const c of plan.carryCast) {
    // Only complain once the season is far enough in that a carry character
    // should have appeared. Somebody introduced in episode four is not missing
    // in episode two.
    if (written >= 2 && !known.has(c.name.toLowerCase())) {
      notes.push(
        `the plan carries ${c.name}, but ${written} episodes in the bible has never recorded them`
      );
    }
  }

  return notes;
};
