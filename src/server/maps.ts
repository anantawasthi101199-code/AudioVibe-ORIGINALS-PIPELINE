/**
 * Content maps: a planned run of series and episodes, made strictly in order
 * (owner, 2026-10-12).
 *
 * A map is a hand-editable JSON file in `maps/`, written once from whatever
 * free-form plan the owner hands over (the first is Hindu Mythology, 10 series,
 * 108 episodes). The studio then offers ONE item at a time: the first one that
 * has not been published. The one after it is not offered until this one is
 * out, so the order the map promises listeners is the order they get.
 *
 * NOTHING IS STORED ABOUT PROGRESS. A run started from the map carries the
 * item's key (`mapItem` on its manifest) and an item's state is read off those
 * runs every time: published, being made, or failed and waiting to be made
 * again. Discard the run and the item is simply next again. A progress file
 * would be a second record that disagrees with the runs the first time somebody
 * deletes one by hand.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { repoRoot } from '../config';
import { TITLE_MAX } from '../script/titleRule';
import { runs, RunSummary } from './catalog';

const episodeSchema = z.object({
  /** Numbered across the whole map, not within its series: the key is `<map>/<number>`. */
  number: z.number().int().positive(),
  title: z.string().min(1),
  covers: z.string().min(1),
  /** The text the research binds to. The factual lane abandons without one. */
  source: z.string().min(1),
  /**
   * A script already written for this item (owner, 2026-10-13). A blank made
   * from the item opens with it filled in, instead of one empty box per part.
   * `file` is relative to the repo, in the whole-script format: a `## <part>`
   * line before each of the format's parts.
   */
  script: z
    .object({
      file: z.string().min(1),
      title: z.string().min(1).max(TITLE_MAX),
      description: z.string().min(1),
    })
    .optional(),
  /**
   * What the business lane searches for ("Tata Group"). It reads the subject
   * off the topic otherwise, and a map's long topic reads as nonsense.
   */
  subject: z.string().min(1).optional(),
});

const mapSchema = z.object({
  id: z.string().min(1),
  channelId: z.string().min(1),
  title: z.string().min(1),
  /** Every item is made in this format. A long format, so each lands in its series. */
  formatId: z.string().min(1),
  series: z.array(
    z.object({
      number: z.number().int().positive(),
      title: z.string().min(1).max(80),
      note: z.string().default(''),
      episodes: z.array(episodeSchema).min(1),
    })
  ),
});

export type ContentMap = z.infer<typeof mapSchema>;

/**
 * Where an item is, as the track bar draws it (owner, 2026-10-13): a written
 * script is an outline, audio fills it, publishing turns it green.
 *   making    a run is researching or writing, with no script to read yet
 *   scripted  a run holds a script, not voiced yet
 *   voiced    a run has audio, not published yet
 */
export type ItemState = 'published' | 'voiced' | 'scripted' | 'making' | 'retry' | 'todo';

/** A run exists for the item and is still going somewhere. */
export const IN_HAND: ReadonlySet<ItemState> = new Set(['making', 'scripted', 'voiced']);

export interface MapItem {
  key: string;
  number: number;
  title: string;
  covers: string;
  source: string;
  seriesNumber: number;
  seriesTitle: string;
  /** Where it sits in its own series, from 1. */
  position: number;
  seriesSize: number;
  /** A script is already written: a blank made from this item opens filled in. */
  scripted: boolean;
  /** What goes in the topic box: the subject, what it covers, and its text. */
  topic: string;
  state: ItemState;
  /** The newest run made from this item, if any. */
  runId: string | null;
  runState: RunSummary['state'] | null;
}

export interface MapView {
  id: string;
  title: string;
  formatId: string;
  total: number;
  published: number;
  /** The one item that may be made now. Null when the whole map is out. */
  next: MapItem | null;
  items: MapItem[];
}

const mapsDir = (): string => path.join(repoRoot(), 'maps');

export const loadAllMaps = (dir = mapsDir()): ContentMap[] => {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => mapSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));
};

export const loadMaps = (channelId: string, dir = mapsDir()): ContentMap[] =>
  loadAllMaps(dir).filter((m) => m.channelId === channelId);

/** The search subject a map item names, for a run started from it; null if none. */
export const mapSubject = (key: string | undefined, dir = mapsDir()): string | null => {
  if (!key) return null;
  const [mapId, num] = key.split('/');
  const map = loadAllMaps(dir).find((m) => m.id === mapId);
  return map?.series.flatMap((s) => s.episodes).find((e) => e.number === Number(num))?.subject ?? null;
};

export const topicFor = (ep: z.infer<typeof episodeSchema>): string =>
  `${ep.title.replace(/[.?!]?$/, (p) => p || '.')} ${ep.covers} Sources: ${ep.source}.`;

/** Pure, so the ordering rule can be checked without a run store. */
type Made = Pick<RunSummary, 'id' | 'state' | 'createdAt'> & { mapItem: string | null; hasAudio?: boolean };

export const viewOf = (map: ContentMap, made: Made[]): MapView => {
  const items: MapItem[] = map.series.flatMap((s) =>
    s.episodes.map((ep, i) => {
      const key = `${map.id}/${ep.number}`;
      const mine = made.filter((r) => r.mapItem === key).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const live = mine.find((r) => r.state !== 'failed' && r.state !== 'abandoned');
      const state: ItemState = mine.some((r) => r.state === 'published')
        ? 'published'
        : live
          ? live.hasAudio
            ? 'voiced'
            : live.state === 'running'
              ? 'making'
              : 'scripted'
          : mine.length
            ? 'retry'
            : 'todo';
      const shown = mine.find((r) => r.state === 'published') ?? live ?? mine[0];
      return {
        key,
        number: ep.number,
        title: ep.title,
        covers: ep.covers,
        source: ep.source,
        seriesNumber: s.number,
        seriesTitle: s.title,
        position: i + 1,
        seriesSize: s.episodes.length,
        scripted: Boolean(ep.script),
        topic: topicFor(ep),
        state,
        runId: shown?.id ?? null,
        runState: shown?.state ?? null,
      };
    })
  );
  const published = items.filter((i) => i.state === 'published').length;
  return {
    id: map.id,
    title: map.title,
    formatId: map.formatId,
    total: items.length,
    published,
    next: items.find((i) => i.state !== 'published') ?? null,
    items,
  };
};

export const mapsFor = (channelId: string): MapView[] => {
  const maps = loadMaps(channelId);
  if (!maps.length) return [];
  const made = runs({ channelId });
  return maps.map((m) => viewOf(m, made));
};

/**
 * The gate, on the server so no front end can skip it: an item may be started
 * only when it is the map's next one and nothing is already being made from it.
 * Returns why not, or null when it may start.
 */
export const mapStartRefusal = (channelId: string, key: string): { status: number; message: string } | null => {
  const view = mapsFor(channelId).find((m) => key.startsWith(`${m.id}/`));
  const item = view?.items.find((i) => i.key === key);
  if (!view || !item) return { status: 400, message: `"${key}" is not on any of this channel's maps` };
  if (view.next?.key !== key) {
    return {
      status: 409,
      message: view.next ? `not its turn yet: "${view.next.title}" has to be published first` : 'this map is finished',
    };
  }
  if (IN_HAND.has(item.state)) {
    return { status: 409, message: `"${item.title}" is already being made (${item.runId}). Discard that run to start again.` };
  }
  return null;
};

export interface PreparedScript {
  text: string;
  title: string;
  description: string;
}

/** The script written for a map item, or null when it has none. */
export const preparedScriptFor = (channelId: string, key: string, root = repoRoot()): PreparedScript | null => {
  for (const m of loadMaps(channelId, path.join(root, 'maps'))) {
    for (const s of m.series) {
      const ep = s.episodes.find((e) => `${m.id}/${e.number}` === key);
      if (!ep?.script) continue;
      return {
        text: fs.readFileSync(path.join(root, ep.script.file), 'utf8'),
        title: ep.script.title,
        description: ep.script.description,
      };
    }
  }
  return null;
};
