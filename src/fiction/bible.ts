/**
 * The series bible: what a fiction show has already established.
 *
 * THIS IS THE FICTION LANE'S EVIDENCE LEDGER, and the parallel is exact rather
 * than decorative. A factual episode may not say anything it cannot bind to a
 * quote in a fetched source; a fiction episode may not say anything that
 * contradicts what earlier episodes established. Both are the same discipline -
 * the prose is answerable to something outside itself - pointed at a different
 * ground truth.
 *
 * WHY FICTION NEEDS THIS AT ALL, given nothing in it is true. Because serial
 * fiction written one episode at a time by a model with no memory drifts, and
 * the drift is invisible from inside any single episode. A brother becomes a
 * cousin. A shop that closed in episode two is open in episode five. The town
 * is two hours from the city, then twenty minutes. Each episode reads fine and
 * the series falls apart, and it falls apart for exactly the listeners who
 * stayed - the ones worth keeping.
 *
 * WHAT IS NOT IN HERE. Plot. The bible records what is ESTABLISHED, not what is
 * planned: facts a listener could already have heard. Storing intentions here
 * would make the continuity check enforce an outline rather than a history, and
 * an outline is a thing a writer should be allowed to abandon.
 *
 * WHY A FILE PER SHOW RATHER THAN PER RUN. A run is one episode; continuity is
 * the property that spans them. The bible lives with the persona, is read at
 * the start of an episode and appended to at the end, and is the one artifact
 * in this repo that is deliberately mutable.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { biblesDir } from '../config';

/**
 * What kind of thing an entity is.
 *
 * A closed set, for the same reason beat types are closed: the continuity
 * check asks type-specific questions - a person can be somewhere, a place
 * cannot - and free text would make that unanswerable.
 */
export const entityKindSchema = z.enum(['character', 'place', 'object', 'organisation']);

export type EntityKind = z.infer<typeof entityKindSchema>;

export const establishedFactSchema = z.object({
  /** The fact, as a listener would have heard it. */
  text: z.string().min(1),
  /** The episode that established it, so a contradiction is traceable. */
  episodeId: z.string().min(1),
  /**
   * Whether a later episode may contradict this.
   *
   * Most facts are fixed: a character's sister does not become their aunt. But
   * fiction turns on things being revealed as untrue, so a fact a character
   * BELIEVED, or that the narration presented as true and later overturns, has
   * to be markable. Without this the continuity check would forbid the twist,
   * which is a check that has started working against the thing it protects.
   */
  revisable: z.boolean().default(false),
});

export type EstablishedFact = z.infer<typeof establishedFactSchema>;

export const entitySchema = z.object({
  /** Stable id, referenced by claims and by other entities. */
  id: z.string().regex(/^[a-z0-9-]+$/, 'lowercase, digits and hyphens only'),
  kind: entityKindSchema,
  /** What a listener hears them called. */
  name: z.string().min(1),
  /** One line, so the writer can be handed a cast without the whole history. */
  summary: z.string().min(1),
  facts: z.array(establishedFactSchema).default([]),
  /** Episode this first appeared in. */
  introducedIn: z.string().min(1),
});

export type Entity = z.infer<typeof entitySchema>;

export const bibleSchema = z.object({
  personaId: z.string().min(1),
  entities: z.array(entitySchema).default([]),
  /**
   * Episodes in the order they were published, which is the order a listener
   * hears them and therefore the order continuity is measured in.
   *
   * Not the order they were written. A show that releases out of order is a
   * different problem and this design does not pretend to solve it.
   */
  episodes: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        /** What happened, in a few lines. The writer's memory of the series. */
        synopsis: z.string().min(1),
      })
    )
    .default([]),
});

export type Bible = z.infer<typeof bibleSchema>;

export class BibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BibleError';
  }
}

const biblePath = (personaId: string, dir?: string): string =>
  path.join(dir ?? biblesDir(), `${personaId}.json`);

/**
 * Read a show's bible, or an empty one for a show that has not run yet.
 *
 * An absent bible is a first episode, not an error. Requiring one to be
 * hand-written before anything could run would mean inventing a cast in a JSON
 * file, which is the worst place to invent a cast.
 */
export const loadBible = (personaId: string, dir?: string): Bible => {
  const file = biblePath(personaId, dir);
  if (!fs.existsSync(file)) return { personaId, entities: [], episodes: [] };

  try {
    return bibleSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    // Loud, because the alternative is starting a fresh bible over the top of
    // one that already had thirty episodes of history in it.
    throw new BibleError(`${file} is not a readable series bible: ${(err as Error).message}`);
  }
};

export const saveBible = (bible: Bible, dir?: string): string => {
  const file = biblePath(bible.personaId, dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(bibleSchema.parse(bible), null, 2)}\n`, 'utf8');
  return file;
};

/** Every fact on record, flattened, with the entity it belongs to. */
export const allFacts = (
  bible: Bible
): Array<{ entity: Entity; fact: EstablishedFact }> =>
  bible.entities.flatMap((entity) => entity.facts.map((fact) => ({ entity, fact })));

/**
 * The cast, as the writer should see it: names, one line each, and the facts
 * that are fixed.
 *
 * Revisable facts are deliberately omitted. Handing the writer "she believes
 * her brother is dead" alongside the fixed facts invites it to treat the belief
 * as background rather than as the thing the series is going to turn over.
 */
export const castBrief = (bible: Bible): string => {
  if (!bible.entities.length) return '(nothing established yet - this is the first episode)';

  return bible.entities
    .map((e) => {
      const fixed = e.facts.filter((f) => !f.revisable).map((f) => `    - ${f.text}`);
      return [`  ${e.name} (${e.kind}): ${e.summary}`, ...fixed].join('\n');
    })
    .join('\n');
};

/** What has happened so far, in the order a listener heard it. */
export const storySoFar = (bible: Bible, limit = 6): string => {
  if (!bible.episodes.length) return '(this is the first episode)';

  // The most recent few, not all of them. A twenty-episode synopsis is context
  // rot: the writer reads a wall of text and remembers the start and the end.
  const recent = bible.episodes.slice(-limit);
  const skipped = bible.episodes.length - recent.length;

  return [
    skipped > 0 ? `(${skipped} earlier episode(s) omitted)` : null,
    ...recent.map((e) => `  ${e.title}: ${e.synopsis}`),
  ]
    .filter(Boolean)
    .join('\n');
};
