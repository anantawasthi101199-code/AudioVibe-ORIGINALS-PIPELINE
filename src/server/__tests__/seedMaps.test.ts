/**
 * Scripts written into a content map become runs when the studio starts, once
 * per item, ever.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import { scriptSchema } from '../../script/write';
import { runs } from '../catalog';
import { loadAllMaps, loadMaps, viewOf } from '../maps';
import { seedMapImages, seedPreparedRuns } from '../seedMaps';
import { suppliedArt } from '../../art/supplied';
import { currentOutro, setOutro } from '../../script/outro';

describe('seeding runs from a map', () => {
  const env = { ...process.env };
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
    process.env.FOUNDRY_RUNS_DIR = path.join(dir, 'runs');
    process.env.FOUNDRY_CATALOGUE_FILE = path.join(dir, 'catalogue.json');
    fs.mkdirSync(process.env.FOUNDRY_RUNS_DIR);
  });
  afterEach(() => {
    process.env = { ...env };
  });

  const scriptedKeys = () =>
    loadAllMaps().flatMap((m) =>
      m.series.flatMap((s) => s.episodes.filter((e) => e.script).map((e) => `${m.id}/${e.number}`)),
    );

  it('makes one held, filled-in run per scripted item, in its series', () => {
    const seeded = seedPreparedRuns();
    expect(seeded.map((s) => s.mapItem)).toEqual(scriptedKeys());

    const hindu = seeded.find((s) => s.mapItem.startsWith('hindu-mythology/'))!;
    const first = Run.open(hindu.runId);
    expect(first.manifest.mapItem).toBe(hindu.mapItem);
    expect(first.manifest.seriesTitle).toBe('The Foundations of Hindu Mythology');
    expect(first.awaitingApproval).toBe(true);
    expect(first.manifest.spentPence).toBe(0);
    expect(first.readArtifact('script', scriptSchema).beats[0]!.turns[0]!.text).not.toContain('[WRITE:');
  });

  it('shows on the map as a written script, and never seeds the same item twice', () => {
    seedPreparedRuns();
    expect(seedPreparedRuns()).toEqual([]);

    const made = runs({ channelId: 'mythic-archives' });
    const view = viewOf(loadMaps('mythic-archives')[0]!, made);
    for (const key of scriptedKeys().filter((k) => k.startsWith('hindu-mythology/'))) {
      expect(view.items.find((i) => i.key === key)!.state).toBe('scripted');
    }
  });

  it('A DISCARDED SEEDED RUN STAYS DISCARDED on the next start', () => {
    const [first] = seedPreparedRuns();
    const run = Run.open(first!.runId);
    run.abandon('discarded in the studio');
    expect(seedPreparedRuns()).toEqual([]);
  });

  it('AN UNTOUCHED SEEDED RUN FOLLOWS ITS FILE, an edited one is left alone', () => {
    const [a, b] = seedPreparedRuns();
    const stale = (id: string) => {
      const run = Run.open(id);
      const script = run.readArtifact('script', scriptSchema);
      script.beats[0]!.turns[0]!.text = 'Old text.';
      run.writeArtifact('script', script);
      return run;
    };
    stale(a!.runId).journal({ stage: 'script', event: 'saved in the studio, prose unchanged' });
    stale(b!.runId).journal({ stage: 'script', event: 'edited in the studio' });

    seedPreparedRuns();
    expect(Run.open(a!.runId).readArtifact('script', scriptSchema).beats[0]!.turns[0]!.text).not.toBe('Old text.');
    expect(Run.open(b!.runId).readArtifact('script', scriptSchema).beats[0]!.turns[0]!.text).toBe('Old text.');
  });

  it('THE OUTRO IS ON BY DEFAULT, and one somebody removed stays removed', () => {
    const [a, b] = seedPreparedRuns();
    expect(currentOutro(Run.open(a!.runId).readArtifact('script', scriptSchema))).not.toBeNull();

    // Seeded before the default: no outro and nobody chose. Removed on purpose: stays off.
    for (const id of [a!.runId, b!.runId]) {
      const run = Run.open(id);
      run.writeArtifact('script', setOutro(run.readArtifact('script', scriptSchema), null));
    }
    Run.open(b!.runId).journal({ stage: 'script', event: 'outro removed by anant' });

    seedPreparedRuns();
    expect(currentOutro(Run.open(a!.runId).readArtifact('script', scriptSchema))).not.toBeNull();
    expect(currentOutro(Run.open(b!.runId).readArtifact('script', scriptSchema))).toBeNull();
  });

  it('PUTS A MAP SERIES COVER IN PLACE, and never over one somebody chose', () => {
    const art = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-art-'));
    const name = 'series-the-foundations-of-hindu-mythology';
    expect(seedMapImages(() => undefined, art)).toBeGreaterThan(0);
    const placed = suppliedArt(path.join(art, 'mythic-archives'), name);
    expect(placed).toMatch(/\.supplied\.jpg$/);

    // A newer map picture replaces one the map placed.
    const mapCover = path.join(__dirname, '..', '..', '..', loadAllMaps().find((m) => m.id === 'hindu-mythology')!.series[0]!.cover!);
    const original = fs.readFileSync(mapCover);
    try {
      fs.writeFileSync(mapCover, Buffer.concat([original, Buffer.from('changed')]));
      expect(seedMapImages(() => undefined, art)).toBeGreaterThan(0);
    } finally {
      fs.writeFileSync(mapCover, original);
    }

    // A person's own choice stays: the next start places nothing over it.
    fs.rmSync(suppliedArt(path.join(art, 'mythic-archives'), name)!);
    fs.writeFileSync(path.join(art, 'mythic-archives', `${name}.supplied.png`), 'chosen by hand');
    seedMapImages(() => undefined, art);
    expect(fs.readFileSync(suppliedArt(path.join(art, 'mythic-archives'), name)!, 'utf8')).toBe('chosen by hand');
  });
});
