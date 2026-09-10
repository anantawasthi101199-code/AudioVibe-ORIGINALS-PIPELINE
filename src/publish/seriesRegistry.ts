/**
 * Which series on the platform each show publishes into.
 *
 * WHY THIS FILE HAS TO EXIST AND HAS TO BE COMMITTED. Series creation is not
 * idempotent - the API has no create-or-get, so calling it twice makes two
 * series and the second starts again at episode one. There is also no way to
 * look a series up by title on the ingest credential. So the id has to be
 * written down, and if it is lost the show quietly forks into two shelves that
 * both look right in isolation.
 *
 * That is a different kind of state from a run, which is reproducible from its
 * inputs and therefore ignored by git. This is a POINTER AT SOMETHING LIVE, and
 * losing it cannot be recovered by re-running anything. It goes in the repo for
 * the same reason a series bible does.
 *
 * KEYED BY ENVIRONMENT, NOT JUST BY SHOW. Staging and production hold different
 * series with different ids, and a single-keyed file would publish production
 * episodes into whichever shelf was written last - which is the sort of mistake
 * you discover from a listener rather than from a log.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { repoRoot } from '../config';

export const seriesRecordSchema = z.object({
  seriesId: z.string().min(1),
  title: z.string().min(1),
  /** Which API this id exists on. Two environments, two different series. */
  apiUrl: z.string().min(1),
  createdAt: z.string().datetime(),
});

export type SeriesRecord = z.infer<typeof seriesRecordSchema>;

/** personaId -> environment key -> record. */
export const seriesRegistrySchema = z.record(z.record(seriesRecordSchema));

export type SeriesRegistry = z.infer<typeof seriesRegistrySchema>;

export class SeriesRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeriesRegistryError';
  }
}

const registryPath = (dir?: string): string =>
  path.join(dir ?? repoRoot(), 'series.json');

/**
 * The environment an API url belongs to.
 *
 * The host, not the full url, so a trailing slash or an added path does not
 * split one environment into two entries that then create two series.
 */
export const environmentKey = (apiUrl: string): string => {
  try {
    return new URL(apiUrl).host.toLowerCase();
  } catch {
    // A malformed url is a config problem that will fail loudly at the first
    // request. Keying on the raw string keeps this function total rather than
    // making it the place that error surfaces.
    return apiUrl.trim().toLowerCase();
  }
};

export const loadRegistry = (dir?: string): SeriesRegistry => {
  const file = registryPath(dir);
  if (!fs.existsSync(file)) return {};

  try {
    return seriesRegistrySchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    // Loud. Treating an unreadable registry as empty would create a second
    // series for every show on the next publish, and nothing about the result
    // would look wrong until somebody noticed the catalogue had two of each.
    throw new SeriesRegistryError(
      `${file} is not a readable series registry: ${(err as Error).message}. ` +
        `Fix it rather than deleting it - deleting it forks every show.`
    );
  }
};

export const findSeries = (
  personaId: string,
  apiUrl: string,
  dir?: string
): SeriesRecord | null => loadRegistry(dir)[personaId]?.[environmentKey(apiUrl)] ?? null;

/**
 * Record a series, refusing to overwrite one that already exists.
 *
 * The refusal is the point. An overwrite here orphans every episode already
 * published into the old shelf: they stay on the platform, still numbered,
 * attached to a series nothing in this repo points at any more.
 */
export const recordSeries = (
  personaId: string,
  record: SeriesRecord,
  dir?: string
): SeriesRegistry => {
  const registry = loadRegistry(dir);
  const env = environmentKey(record.apiUrl);
  const existing = registry[personaId]?.[env];

  if (existing && existing.seriesId !== record.seriesId) {
    throw new SeriesRegistryError(
      `${personaId} already publishes into series ${existing.seriesId} on ${env}. ` +
        `Recording ${record.seriesId} over it would orphan every episode already ` +
        `in the first one.`
    );
  }

  const next: SeriesRegistry = {
    ...registry,
    [personaId]: { ...(registry[personaId] ?? {}), [env]: record },
  };

  fs.writeFileSync(registryPath(dir), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
};
