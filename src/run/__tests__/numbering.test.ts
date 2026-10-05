import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run, runLabel } from '../store';

describe('shorts and episodes are numbered apart', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'num-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const make = (formatId: string, topic: string) =>
    Run.create({ personaId: 'mythic-archives', formatId, topic }, { root });

  it('gives shorts s001, s002 and episodes e001, e002, each counted on its own', () => {
    expect(runLabel(make('myth-short', 'Maui').id)).toBe('s001');
    expect(runLabel(make('myth-story', 'Hero Twins').id)).toBe('e001');
    expect(runLabel(make('myth-short', 'Thor').id)).toBe('s002');
    expect(runLabel(make('myth-story', 'Perseus').id)).toBe('e002');
  });

  it('keeps a short cut from an episode under that episode', () => {
    const ep = make('myth-story', 'Hero Twins');
    const cut = Run.create(
      { personaId: 'mythic-archives', formatId: 'myth-short', topic: 'Hero Twins', parentEpisode: ep.manifest.episode },
      { root }
    );
    expect(runLabel(cut.id)).toBe('e001-s01');
  });
});
