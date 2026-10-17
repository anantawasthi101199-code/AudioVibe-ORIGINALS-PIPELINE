/**
 * A parsed YAML file, kept until any file it was built from changes on disk.
 * The channel page summarises every run, and each summary loads its persona and
 * format: re-parsing voice-master.yaml (70 KB) for each of them made the page
 * take 6 seconds (2026-10-16). An edit is still seen on the next read, because
 * the key is each file's modified time and size.
 */
import fs from 'fs';

const cache = new Map<string, { stamp: string; value: unknown }>();

const stampOf = (files: string[]): string =>
  files
    .map((f) => {
      try {
        const s = fs.statSync(f);
        return `${s.mtimeMs}:${s.size}`;
      } catch {
        return '-';
      }
    })
    .join('|');

/** A copy each time, so a caller that changes what it got cannot change the cache. */
export const cachedByFiles = <T>(key: string, files: string[], build: () => T): T => {
  const stamp = stampOf(files);
  const hit = cache.get(key);
  if (hit?.stamp !== stamp) cache.set(key, { stamp, value: build() });
  return structuredClone(cache.get(key)!.value as T);
};
