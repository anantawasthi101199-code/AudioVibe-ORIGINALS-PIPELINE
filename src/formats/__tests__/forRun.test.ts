import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadPersona } from '../../canon/load';
import { musicFor } from '../../render/musicFor';
import { seriesKey } from '../../publish/seriesRegistry';
import { Run } from '../../run/store';
import { formatForRun } from '../forRun';
import { loadFormat } from '../load';

describe('formatForRun: the series intro', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forrun-'));
  });

  it('opens a long episode by naming its series and the show', () => {
    const run = Run.create(
      { personaId: 'business-decoded', formatId: 'biz-episode', topic: 'Zara', seriesTitle: 'Founder Stories' },
      { root }
    );
    const first = formatForRun(run).beats[0]!;
    expect(first.constraints[0]).toContain('"This is Founder Stories, from Business Decoded."');
    // Only this run's copy: the beat sheet itself is untouched.
    expect(loadFormat('biz-episode').beats[0]!.constraints[0]).not.toContain('Founder Stories');
  });

  it('leaves a short, and a long episode with no series, exactly as written', () => {
    const short = Run.create({ personaId: 'business-decoded', formatId: 'biz-short', topic: 'A', seriesTitle: 'X' }, { root });
    const plain = Run.create({ personaId: 'business-decoded', formatId: 'biz-episode', topic: 'B' }, { root });
    expect(formatForRun(short)).toEqual(loadFormat('biz-short'));
    expect(formatForRun(plain)).toEqual(loadFormat('biz-episode'));
  });
});

describe('musicFor', () => {
  const bd = loadPersona('business-decoded');

  it('follows the channel sheet: music under shorts, none under long form', () => {
    expect(musicFor(undefined, bd, 'biz-short')).toBe(true);
    expect(musicFor(undefined, bd, 'biz-episode')).toBe(false);
    expect(musicFor(undefined, loadPersona('mythic-archives'), 'myth-short')).toBe(false);
  });

  it('lets the run override it both ways', () => {
    expect(musicFor(false, bd, 'biz-short')).toBe(false);
    expect(musicFor(true, bd, 'biz-episode')).toBe(true);
  });
});

describe('seriesKey', () => {
  it('keeps the one-per-show key, and gives each named series its own', () => {
    expect(seriesKey('crime-files')).toBe('crime-files');
    expect(seriesKey('business-decoded', 'Founder Stories')).toBe('business-decoded#founder-stories');
    expect(seriesKey('business-decoded', '  Startup School! ')).toBe('business-decoded#startup-school');
  });
});
