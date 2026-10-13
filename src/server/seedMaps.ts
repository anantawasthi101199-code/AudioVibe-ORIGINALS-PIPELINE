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
 */
import { loadPersona } from '../canon/load';
import { recordMade } from '../catalogue/covered';
import { startHandwritten } from '../pipeline/handwritten';
import { Run } from '../run/store';
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
        if (!ep.script || made.has(key)) continue;
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
