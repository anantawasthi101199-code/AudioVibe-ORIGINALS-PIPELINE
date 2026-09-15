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

/**
 * Turn `repeats: 10` into ten beats, numbered.
 *
 * Deliberately before validation and deliberately dumb: it copies the beat,
 * renames it, and lets the schema judge the result. Anything clever here would
 * be a second definition of what a beat is.
 *
 * The tension curve is expanded alongside, because a curve with one entry for a
 * repeated beat is saying "flat across all of them", which is exactly right for
 * an anthology and would otherwise fail the length check.
 */
export const expandRepeats = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object') return raw;
  const format = raw as { beats?: unknown; tensionCurve?: unknown };
  if (!Array.isArray(format.beats)) return raw;

  const repeated = format.beats.some(
    (b) => typeof (b as { repeats?: number }).repeats === 'number'
  );

  // NOTHING TO EXPAND MEANS NOTHING TO TOUCH. An early version rebuilt the
  // curve for every format, padding a short one out to the beat count - which
  // silently defeated the check that a curve and its beats are in step, a check
  // that exists because a mismatched curve is somebody having edited beats and
  // forgotten the curve.
  if (!repeated) return raw;

  const beats: unknown[] = [];
  const curve: number[] = [];
  const given = Array.isArray(format.tensionCurve) ? (format.tensionCurve as number[]) : [];

  format.beats.forEach((beat, i) => {
    const b = beat as { id?: string; repeats?: number };
    const times = typeof b.repeats === 'number' && b.repeats > 1 ? b.repeats : 1;

    for (let n = 1; n <= times; n++) {
      const copy = { ...(b as Record<string, unknown>) };
      delete copy.repeats;
      if (times > 1) copy.id = `${b.id}_${String(n).padStart(2, '0')}`;
      beats.push(copy);

      // Undefined stays undefined rather than borrowing a neighbour, so a
      // format that is genuinely missing an entry still fails the length check.
      if (given[i] !== undefined) curve.push(given[i]!);
    }
  });

  return { ...(raw as object), beats, ...(curve.length ? { tensionCurve: curve } : {}) };
};

export const parseFormat = (source: string, label = '<inline>'): EpisodeFormat => {
  let raw: unknown;
  try {
    raw = YAML.parse(source);
  } catch (err) {
    throw new FormatLoadError(label, [`invalid YAML: ${(err as Error).message}`]);
  }

  // A REPEATED BEAT BECOMES REAL BEATS BEFORE VALIDATION, so every rule that
  // follows - unique ids, the tension curve matching the beat count, loops
  // opening and closing - applies to what will actually be written rather than
  // to the shorthand. See beatSchema.repeats.
  const expanded = expandRepeats(raw);
  const result = formatSchema.safeParse(expanded);
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

/**
 * One story's format, cut out of the set it belongs to.
 *
 * A CUT STORY IS A FORMAT OF ONE BEAT: that beat's job, that beat's claim
 * floor, that beat's length. Passing the whole ten-beat format to gate a
 * one-beat script makes the gate ask after nine beats that were never meant to
 * be there - "beat story_02 cites 0 claims, below its floor of 6", and the same
 * for story_03 through story_10 - and measures a two-minute story against the
 * set's thirty-minute target.
 *
 * SHARED BECAUSE TWO THINGS NARROW IT. The cut does it when it gates each story
 * as it is made, and `gate --run` does it when somebody asks the same question
 * later. Those two must agree: a re-gate that reports nine findings the real
 * gate never saw looks like news and is noise.
 *
 * An index outside the format's beats returns it unchanged, which is what a run
 * that is not one story of a set should see.
 */
export const oneBeatFormat = (format: EpisodeFormat, index: number): EpisodeFormat => {
  const beat = format.beats[index];
  if (!beat) return format;

  return {
    ...format,
    beats: [beat],
    tensionCurve:
      format.tensionCurve[index] !== undefined ? [format.tensionCurve[index]!] : format.tensionCurve,
    // The set's target belongs to the source, which is never rendered and never
    // gated as audio.
    targetSeconds: beat.seconds,
  };
};
