/**
 * Could this run be published, if somebody pressed the button now? Everything
 * a publish does except the upload, so a problem shows up here rather than on
 * the morning it was due (owner, 2026-10-05).
 *
 * WHY IT EXISTS. Two walls in one morning, both on every short of four
 * channels: the publish-time gate could not gate a run with no claim ledger,
 * then the Sources sheet could not be built without one. Each lane writes
 * different artifacts, and nothing asked "can a run from this lane actually be
 * published" until a person pressed the button. This asks, for every run, and
 * the tests ask it for every lane.
 *
 * A FAILED GATE IS NOT A PROBLEM HERE. Whether the script is good enough is a
 * person's decision; this is only whether the machinery can carry it out.
 */
import fs from 'fs';
import { loadFormat } from '../formats/load';
import { regate } from '../qa/regate';
import { renderResultSchema } from '../render/assemble';
import { mixedAudioFor } from '../render/backing';
import { Run } from '../run/store';
import { scriptSchema } from '../script/write';
import { provenanceFor } from './publishRun';

export interface Readiness {
  /** The machinery can publish it (the gate may still say no). */
  ready: boolean;
  problems: string[];
  /** The gate's answer, when it could give one. */
  gatePassed: boolean | null;
}

export const publishReadiness = (run: Run): Readiness => {
  const problems: string[] = [];
  const attempt = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      problems.push(`${what}: ${(e as Error).message}`);
    }
  };

  let gatePassed: boolean | null = null;
  attempt('format', () => {
    const format = loadFormat(run.manifest.formatId);
    if (format.sourceOnly && run.manifest.story === undefined) {
      throw new Error('a source script is cut into shorts, never published whole');
    }
  });
  attempt('audio', () => {
    const render = run.readArtifact('render', renderResultSchema);
    const file = mixedAudioFor(run) ?? run.audioFile(render.audioFile);
    if (!file || !fs.existsSync(file)) throw new Error('the voiced audio file is missing');
  });
  attempt('gate', () => {
    const gate = regate(run, run.readArtifact('script', scriptSchema));
    if (!gate) throw new Error('it cannot be gated, so it cannot be published');
    gatePassed = gate.passed;
  });
  attempt('sources', () => void provenanceFor(run, { confirmed: true }));

  return { ready: problems.length === 0, problems, gatePassed };
};
