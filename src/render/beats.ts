/**
 * The beat library: synthesised loops made once by hand, then reused.
 *
 * WHY THIS EXISTS. `mixBed` synthesises its phrase from scratch every time it
 * is called, which is once PER PART, so a three-part episode builds the same
 * twenty-four second orchestral phrase three times and throws all three away.
 * That is slow, and worse, it means nobody can hear what a show's music sounds
 * like without making an episode. There was no way to audition a bed, and no
 * way to keep one you liked.
 *
 * A beat here is made deliberately, listened to, named, and then used by name.
 * A show gets a sound instead of a style setting.
 *
 * RECIPE COMMITTED, AUDIO NOT. The JSON is a few hundred bytes and regenerates
 * the audio exactly, because synthesis here is deterministic: the same style
 * and the same root produce the same phrase on any machine with the same
 * ffmpeg. So the repo carries the recipe and `beds/*.mp3` is gitignored, the
 * same bargain runs/ makes. Delete the audio and the next use rebuilds it.
 *
 * WHAT A BEAT IS NOT. A composition. It is one loopable phrase, four chords,
 * of a style that already exists in bed.ts. The point is reuse and auditioning,
 * not a step sequencer.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { repoRoot } from '../config';
import { BED_STYLES, BedDeps, BedStyle, renderPhrase } from './bed';

/**
 * The eight roots a bed may sit on, by name.
 *
 * THE SAME EIGHT `keyFor` PICKS FROM, deliberately, so a hand-made beat and a
 * seeded one are the same kind of object. A1 up to E2: low, because this sits
 * under a speaking voice and anything higher competes with it.
 */
export const KEYS: Record<string, number> = {
  a: 55.0,
  'a#': 58.27,
  b: 61.74,
  c: 65.41,
  'c#': 69.3,
  d: 73.42,
  'd#': 77.78,
  e: 82.41,
};

export const isKey = (k: string): boolean =>
  Object.prototype.hasOwnProperty.call(KEYS, k.toLowerCase());

export const beatRecipeSchema = z.object({
  /** How it is asked for. Lowercase and hyphenated so it is safe as a filename. */
  name: z.string().regex(/^[a-z0-9-]+$/, 'lowercase, digits and hyphens only'),
  style: z.enum(BED_STYLES),
  /** Key name, not the frequency, so the file reads as music rather than physics. */
  key: z.string().refine(isKey, 'not one of the eight keys'),
  /** One line from whoever made it, for choosing between two later. */
  note: z.string().default(''),
  madeAt: z.string().min(1),
});

export type BeatRecipe = z.infer<typeof beatRecipeSchema>;

export const bedsDir = (): string => {
  const configured = process.env.FOUNDRY_BEDS_DIR || 'beds';
  return path.isAbsolute(configured) ? configured : path.join(repoRoot(), configured);
};

export const recipePath = (name: string, dir?: string): string =>
  path.join(dir ?? bedsDir(), `${name}.json`);

/** Where the rendered loop is cached. Gitignored; rebuilt on demand. */
export const audioPath = (name: string, dir?: string): string =>
  path.join(dir ?? bedsDir(), `${name}.mp3`);

export const loadBeat = (name: string, dir?: string): BeatRecipe | null => {
  const file = recipePath(name, dir);
  if (!fs.existsSync(file)) return null;
  return beatRecipeSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
};

export const saveBeat = (recipe: BeatRecipe, dir?: string): string => {
  const target = dir ?? bedsDir();
  fs.mkdirSync(target, { recursive: true });
  const file = recipePath(recipe.name, target);
  fs.writeFileSync(file, `${JSON.stringify(beatRecipeSchema.parse(recipe), null, 2)}\n`, 'utf8');
  return file;
};

export const listBeats = (dir?: string): BeatRecipe[] => {
  const target = dir ?? bedsDir();
  if (!fs.existsSync(target)) return [];

  return fs
    .readdirSync(target)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return beatRecipeSchema.parse(
          JSON.parse(fs.readFileSync(path.join(target, f), 'utf8'))
        );
      } catch {
        // A hand-edited recipe that no longer parses should not take the whole
        // listing down with it. It simply does not appear, and the render of
        // that one beat reports the real error.
        return null;
      }
    })
    .filter((r): r is BeatRecipe => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
};

export interface BeatBuild {
  ok: boolean;
  /** Where the audio is, whether it was just built or already there. */
  file: string;
  /** False when a cached file was reused. */
  rendered: boolean;
  reason?: string;
}

/**
 * The audio for a beat, building it if it is not already on disk.
 *
 * CACHE BY EXISTENCE, NOT BY HASH. The recipe fully determines the audio, so
 * the only way a stale file survives is if somebody edits a recipe without
 * deleting the mp3 beside it. `--force` covers that, and the alternative -
 * hashing the recipe into the filename - would leave the directory full of
 * files nobody can identify by looking at it.
 */
export const buildBeat = async (
  recipe: BeatRecipe,
  opts: { force?: boolean; dir?: string } = {},
  deps: BedDeps = {}
): Promise<BeatBuild> => {
  const file = audioPath(recipe.name, opts.dir);

  if (!opts.force && fs.existsSync(file) && fs.statSync(file).size > 0) {
    return { ok: true, file, rendered: false };
  }

  if (recipe.style === 'none') {
    return { ok: false, file, rendered: false, reason: 'style "none" makes no sound' };
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });

  const root = KEYS[recipe.key.toLowerCase()];
  if (root === undefined) {
    return { ok: false, file, rendered: false, reason: `unknown key "${recipe.key}"` };
  }

  const built = await renderPhrase(recipe.style as BedStyle, root, file, deps);
  return built.ok
    ? { ok: true, file, rendered: true }
    : { ok: false, file, rendered: false, reason: built.reason };
};
