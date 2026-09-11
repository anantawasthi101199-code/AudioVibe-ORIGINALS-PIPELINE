/**
 * Reading show bibles off disk.
 *
 * Personas are YAML rather than TypeScript so that tuning a show is not a code
 * change. That is the whole reason they live in `personas/`: whoever is
 * adjusting how a show sounds should be editing content, not shipping a deploy,
 * and should not need to read TypeScript to do it.
 *
 * The cost of that is that a bad file is a runtime problem rather than a
 * compile-time one, which is exactly what the schema is for. Validation happens
 * once, at load, and fails LOUDLY: a persona that is half-parsed produces an
 * episode that is subtly not the show, which is far harder to notice than a
 * crash.
 */
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { Persona, personaSchema } from './schema';
import { isKnownCategory, nearestCategory } from './categories';

export class PersonaLoadError extends Error {
  constructor(
    readonly file: string,
    readonly problems: string[]
  ) {
    super(`${file} is not a valid persona:\n  - ${problems.join('\n  - ')}`);
    this.name = 'PersonaLoadError';
  }
}

/** Parse and validate one persona from YAML text. */
export const parsePersona = (source: string, label = '<inline>'): Persona => {
  let raw: unknown;
  try {
    raw = YAML.parse(source);
  } catch (err) {
    throw new PersonaLoadError(label, [`invalid YAML: ${(err as Error).message}`]);
  }

  const result = personaSchema.safeParse(raw);
  if (!result.success) {
    // Flattened to "field: message" so a broken file tells you which line to
    // open rather than making you read a nested Zod tree.
    const problems = result.error.issues.map((i) => {
      const at = i.path.length ? i.path.join('.') : '(root)';
      return `${at}: ${i.message}`;
    });
    throw new PersonaLoadError(label, problems);
  }

  return result.data;
};

export const personasDir = (): string =>
  path.resolve(__dirname, '..', '..', 'personas');

/** Load one show by its id, which is also its filename. */
export const loadPersona = (id: string, dir = personasDir()): Persona => {
  const file = path.join(dir, `${id}.yaml`);
  if (!fs.existsSync(file)) {
    throw new PersonaLoadError(file, ['no such persona file']);
  }
  const persona = parsePersona(fs.readFileSync(file, 'utf8'), file);

  // The id is the filename, and disagreement between them is the kind of thing
  // that produces run artifacts filed under a show that does not exist.
  if (persona.id !== id) {
    throw new PersonaLoadError(file, [`id is "${persona.id}" but the file is named "${id}.yaml"`]);
  }

  // A WARNING, NOT A FAILURE, and the distinction is the whole point.
  //
  // The platform resolves a category name to an id at publish time, so a name
  // it does not have fails there - at the last command, after the research,
  // the writing, the voicing and the gate have all been paid for. Night Shift
  // shipped with "Fiction", which is not a category, and would have done
  // exactly that.
  //
  // It cannot be a hard failure, because the list here is a copy and the live
  // one is the authority. If the platform adds a category, publishing works and
  // this is merely stale - and being stale must never stop a show the platform
  // would accept.
  if (!isKnownCategory(persona.category)) {
    const near = nearestCategory(persona.category);
    console.warn(
      `${persona.name}: "${persona.category}" is not a category AudioVibe has, so publishing ` +
        `will fail on the last call.${near ? ` Did you mean "${near}"?` : ''}`
    );
  }

  return persona;
};

/** Every show on disk, sorted by id so output is stable. */
export const loadAllPersonas = (dir = personasDir()): Persona[] => {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''))
    .sort()
    .map((id) => loadPersona(id, dir));
};
