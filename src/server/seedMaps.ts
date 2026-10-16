/**
 * Every map item with a script already written gets a run, so the script is
 * in the studio's runs to read, edit and voice (owner, 2026-10-13). The
 * scripts live in the repo and the runs live on the data volume, so nothing
 * else would ever bring the two together.
 *
 * RUN WHEN THE STUDIO STARTS, which on the hosted studio is every deploy: a
 * script pushed to main is a run once the deploy is up.
 *
 * ONCE PER ITEM, EVER. An item that already has any run, discarded ones
 * included, is left alone, so discarding a seeded run does not bring it back
 * on the next deploy, and a run somebody has edited is never overwritten.
 *
 * FREE. A seeded run is a hand-written blank, filled in and held before the
 * render; the voice is paid for only after somebody approves it.
 *
 * KEPT IN STEP WITH ITS FILE while nobody has touched it: a seeded run that is
 * still held, unvoiced and unedited takes the file's current text on each
 * start, so improving a script in the repo reaches the studio (owner,
 * 2026-10-13). Saving with the prose unchanged and choosing an outro do not
 * count as touching it (the outro is carried over); a prose edit, tag pass,
 * approval or render freezes it.
 */
import { loadPersona } from '../canon/load';
import { recordMade } from '../catalogue/covered';
import { formatForRun } from '../formats/forRun';
import { blankScript, fillBlank, handwrittenGate, startHandwritten } from '../pipeline/handwritten';
import { Run } from '../run/store';
import { currentOutro, setOutro } from '../script/outro';
import { scriptSchema } from '../script/write';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { repoRoot } from '../config';
import { saveSuppliedArt, suppliedArt } from '../art/supplied';
import { seriesKey } from '../publish/seriesRegistry';
import { EPISODE_SHAPE, SHAPES } from './art';
import { runs } from './catalog';
import { loadAllMaps, preparedScriptFor, topicFor } from './maps';
import { topicUsed } from './topicPicks';

export interface Seeded {
  runId: string;
  mapItem: string;
}

export const seedPreparedRuns = (log: (message: string) => void = () => undefined): Seeded[] => {
  const seeded: Seeded[] = [];
  // ONE RUNS LIST PER CHANNEL, NOT PER ITEM (2026-10-15). Listing a channel's
  // runs takes seconds on the hosted volume, and this runs before the studio
  // listens: once per item, 130 scripts kept every deploy down for minutes.
  const listed = new Map<string, ReturnType<typeof runs>>();
  const runsOf = (channelId: string) => {
    if (!listed.has(channelId)) listed.set(channelId, runs({ channelId }));
    return listed.get(channelId)!;
  };
  for (const map of loadAllMaps()) {
    const persona = loadPersona(map.channelId);
    const made = new Set(runsOf(map.channelId).map((r) => r.mapItem));
    for (const series of map.series) {
      for (const ep of series.episodes) {
        const key = `${map.id}/${ep.number}`;
        if (!ep.script) continue;
        if (made.has(key)) {
          refreshFromFile(map.channelId, key, log, runsOf(map.channelId));
          continue;
        }
        try {
          const prepared = preparedScriptFor(map.channelId, key)!;
          const topic = topicFor(ep);
          const run = Run.create({
            personaId: persona.id,
            formatId: map.formatId,
            topic,
            onePass: true,
            holdForApproval: true,
            // Shorts are filed loose, never in a series.
            seriesTitle: map.shorts ? undefined : series.title,
            mapItem: key,
            handwritten: true,
          });
          startHandwritten(run, prepared);
          run.journal({ stage: 'pipeline', event: `made from the script written for ${key}` });
          if (!persona.fiction) recordMade(persona.id, topic, run.id);
          topicUsed(persona.id, topic);
          seeded.push({ runId: run.id, mapItem: key });
          log(`map: ${key} -> ${run.id}`);
        } catch (e) {
          // One bad script must not stop the studio starting, or the others.
          log(`map: ${key} not made: ${(e as Error).message}`);
        }
      }
    }
  }
  return seeded;
};

/**
 * PICTURES MADE FOR A MAP become the studio's art (owner, 2026-10-15): a series'
 * `cover` its series cover, an item's `image` its run's cover. Made outside the
 * studio (ChatGPT, see the foundry-scripts skill) and committed beside the
 * scripts, so a push is all it takes.
 *
 * NEVER OVER A PICTURE SOMEBODY CHOSE. Only where no supplied picture exists
 * yet; to replace one, remove it in the studio first. A series cover reaches
 * AudioVibe with the series' first episode; for a series already live, set it
 * in the studio too (the platform copy is not touched from here).
 */
const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex');

/** Placed before records were kept: the first Hindu Mythology series cover, untitled. */
const LEGACY_PLACED = new Set(['f7443a47623d2d6bb8826988ef775b5b2283ca5b']);

export const seedMapImages = (
  log: (message: string) => void = () => undefined,
  artRoot = path.join(repoRoot(), 'art'),
): number => {
  let placed = 0;
  const place = (file: string, dir: string, name: string, shape: typeof EPISODE_SHAPE, what: string) => {
    // A RECORD OF WHAT THE MAP PLACED (2026-10-16): `<name>.from-map` holds the
    // sha1 of the bytes put there. A supplied picture whose bytes still match
    // was placed from the map, so a newer map picture replaces it; one that
    // does not match (or has no record) was chosen by a person and stays.
    const record = path.join(dir, `${name}.from-map`);
    const bytes = fs.readFileSync(path.join(repoRoot(), file));
    const existing = suppliedArt(dir, name);
    if (existing) {
      const now = sha1(fs.readFileSync(existing));
      const ours = fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim() === now : LEGACY_PLACED.has(now);
      if (!ours || now === sha1(bytes)) return;
    }
    try {
      saveSuppliedArt(dir, name, bytes, shape);
      fs.writeFileSync(record, sha1(bytes));
      placed++;
      log(`map: ${what} picture from ${file}`);
    } catch (e) {
      log(`map: ${what} picture not used: ${(e as Error).message}`);
    }
  };
  for (const map of loadAllMaps()) {
    const mine = runs({ channelId: map.channelId });
    for (const series of map.series) {
      if (series.cover && !map.shorts) {
        const name = `series-${seriesKey(map.channelId, series.title).split('#')[1]}`;
        place(series.cover, path.join(artRoot, map.channelId), name, SHAPES.series, `series "${series.title}"`);
      }
      for (const ep of series.episodes) {
        if (!ep.image) continue;
        const key = `${map.id}/${ep.number}`;
        const run = mine.filter((r) => r.mapItem === key && r.state !== 'failed' && r.state !== 'abandoned')[0];
        if (!run) continue;
        place(ep.image, path.dirname(Run.open(run.id).mediaPath('cover.png')), 'cover', EPISODE_SHAPE, key);
      }
    }
  }
  return placed;
};

const SEED_EVENT = 'blank filled with the script written for this map item; nothing was paid for';
const REFRESH_EVENT = 'script updated from its file; nothing was paid for';
/** Script events that leave the prose as the file wrote it. */
const keepsProse = (event: string) =>
  event === SEED_EVENT ||
  event === REFRESH_EVENT ||
  event === 'saved in the studio, prose unchanged' ||
  /^outro (\d+ attached|removed|unchanged)/.test(event);

/** The one seeded run for this item, refilled from the file if it is untouched and the file changed. */
const refreshFromFile = (
  channelId: string,
  key: string,
  log: (message: string) => void,
  listed: ReturnType<typeof runs>,
): void => {
  const mine = listed.filter((r) => r.mapItem === key);
  if (mine.length !== 1) return;
  try {
    const run = Run.open(mine[0]!.id);
    const untouched =
      run.manifest.handwritten &&
      !run.manifest.abandoned &&
      run.awaitingApproval &&
      !run.hasArtifact('render') &&
      run.manifest.spentPence === 0 &&
      run.readJournal().every((e) => e.stage !== 'script' || keepsProse(e.event)) &&
      run.readJournal().every((e) => e.stage !== 'publish');
    if (!untouched) return;
    const before = run.readArtifact('script', scriptSchema);
    const prepared = preparedScriptFor(channelId, key)!;
    const filled = fillBlank(blankScript(loadPersona(channelId), formatForRun(run), run.manifest.topic), prepared.text, prepared);
    const after = setOutro(filled, currentOutro(before));
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    run.writeArtifact('script', after);
    run.writeArtifact('qa', handwrittenGate(run, after));
    run.journal({ stage: 'script', event: REFRESH_EVENT });
    log(`map: ${key} -> ${run.id} updated from its file`);
  } catch (e) {
    log(`map: ${key} not updated: ${(e as Error).message}`);
  }
};
