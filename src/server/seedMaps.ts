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
 * 2026-10-13). Any edit, tag pass, approval or render freezes it.
 */
import { loadPersona } from '../canon/load';
import { recordMade } from '../catalogue/covered';
import { formatForRun } from '../formats/forRun';
import { blankScript, fillBlank, handwrittenGate, startHandwritten } from '../pipeline/handwritten';
import { Run } from '../run/store';
import { scriptSchema } from '../script/write';
import { runs } from './catalog';
import { loadAllMaps, preparedScriptFor, topicFor } from './maps';
import { topicUsed } from './topicPicks';

export interface Seeded {
  runId: string;
  mapItem: string;
}

export const seedPreparedRuns = (log: (message: string) => void = () => undefined): Seeded[] => {
  const seeded: Seeded[] = [];
  for (const map of loadAllMaps()) {
    const persona = loadPersona(map.channelId);
    const made = new Set(runs({ channelId: map.channelId }).map((r) => r.mapItem));
    for (const series of map.series) {
      for (const ep of series.episodes) {
        const key = `${map.id}/${ep.number}`;
        if (!ep.script) continue;
        if (made.has(key)) {
          refreshFromFile(map.channelId, key, log);
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
            seriesTitle: series.title,
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

const SEED_EVENT = 'blank filled with the script written for this map item; nothing was paid for';
const REFRESH_EVENT = 'script updated from its file; nothing was paid for';

/** The one seeded run for this item, refilled from the file if it is untouched and the file changed. */
const refreshFromFile = (channelId: string, key: string, log: (message: string) => void): void => {
  const mine = runs({ channelId }).filter((r) => r.mapItem === key);
  if (mine.length !== 1) return;
  try {
    const run = Run.open(mine[0]!.id);
    const untouched =
      run.manifest.handwritten &&
      !run.manifest.abandoned &&
      run.awaitingApproval &&
      !run.hasArtifact('render') &&
      run.manifest.spentPence === 0 &&
      run.readJournal().every((e) => e.stage !== 'script' || e.event === SEED_EVENT || e.event === REFRESH_EVENT) &&
      run.readJournal().every((e) => e.stage !== 'publish');
    if (!untouched) return;
    const before = run.readArtifact('script', scriptSchema);
    const prepared = preparedScriptFor(channelId, key)!;
    const after = fillBlank(blankScript(loadPersona(channelId), formatForRun(run), run.manifest.topic), prepared.text, prepared);
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    run.writeArtifact('script', after);
    run.writeArtifact('qa', handwrittenGate(run, after));
    run.journal({ stage: 'script', event: REFRESH_EVENT });
    log(`map: ${key} -> ${run.id} updated from its file`);
  } catch (e) {
    log(`map: ${key} not updated: ${(e as Error).message}`);
  }
};
