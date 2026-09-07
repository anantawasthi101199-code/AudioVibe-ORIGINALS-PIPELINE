/**
 * Reading beat sheets off disk.
 *
 * Same reasoning as personas: a format is content, and adjusting where the hook
 * lands should not be a deploy. Validation happens once at load and fails
 * loudly, because a format that half-parses produces an episode with a missing
 * beat, and a missing counterpoint beat is exactly the failure nobody notices.
 */
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { EpisodeFormat, formatSchema } from './schema';

export class FormatLoadError extends Error {
  constructor(
    readonly file: string,
    readonly problems: string[]
  ) {
    super(`${file} is not a valid format:\n  - ${problems.join('\n  - ')}`);
    this.name = 'FormatLoadError';
  }
}

export const parseFormat = (source: string, label = '<inline>'): EpisodeFormat => {
  let raw: unknown;
  try {
    raw = YAML.parse(source);
  } catch (err) {
    throw new FormatLoadError(label, [`invalid YAML: ${(err as Error).message}`]);
  }

  const result = formatSchema.safeParse(raw);
  if (!result.success) {
    throw new FormatLoadError(
      label,
      result.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    );
  }
  return result.data;
};

export const beatsheetsDir = (): string =>
  path.resolve(__dirname, '..', '..', 'beatsheets');

export const loadFormat = (id: string, dir = beatsheetsDir()): EpisodeFormat => {
  const file = path.join(dir, `${id}.yaml`);
  if (!fs.existsSync(file)) {
    throw new FormatLoadError(file, ['no such beat sheet']);
  }
  const format = parseFormat(fs.readFileSync(file, 'utf8'), file);
  if (format.id !== id) {
    throw new FormatLoadError(file, [`id is "${format.id}" but the file is named "${id}.yaml"`]);
  }
  return format;
};

export const loadAllFormats = (dir = beatsheetsDir()): EpisodeFormat[] => {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''))
    .sort()
    .map((id) => loadFormat(id, dir));
};
