/**
 * Content maps release one item at a time, and only once the one before it is
 * published. The state is read off the runs, so these feed runs in directly.
 */
import path from 'path';
import { loadAllMaps, loadMaps, mapSubject, viewOf, ContentMap } from '../maps';
import { loadPersona } from '../../canon/load';

const map: ContentMap = {
  id: 'm',
  channelId: 'c',
  title: 'M',
  formatId: 'myth-story',
  series: [
    { number: 1, title: 'One', note: '', episodes: [1, 2].map((n) => ({ number: n, title: `T${n}`, covers: 'x.', source: 's' })) },
    { number: 2, title: 'Two', note: '', episodes: [{ number: 3, title: 'T3?', covers: 'y.', source: 's' }] },
  ],
};
const run = (mapItem: string, state: string, createdAt = '2026-10-12', hasAudio = false) =>
  ({ id: `c/${mapItem}`, mapItem, state, createdAt, hasAudio }) as never;

describe('a content map', () => {
  it('offers the first item when nothing is made', () => {
    const v = viewOf(map, []);
    expect(v.next?.key).toBe('m/1');
    expect(v.total).toBe(3);
    expect(v.items[2]!.topic).toBe('T3? y. Sources: s.');
  });

  it('DOES NOT MOVE ON UNTIL THE CURRENT ONE IS PUBLISHED, however far along it is', () => {
    for (const state of ['running', 'awaiting-approval', 'ready']) {
      const v = viewOf(map, [run('m/1', state)]);
      expect(v.next?.key).toBe('m/1');
    }
    expect(viewOf(map, [run('m/1', 'published')]).next?.key).toBe('m/2');
  });

  it('READS AS PROGRESS: being made, then a script, then audio, then published', () => {
    expect(viewOf(map, [run('m/1', 'running')]).items[0]!.state).toBe('making');
    expect(viewOf(map, [run('m/1', 'awaiting-approval')]).items[0]!.state).toBe('scripted');
    expect(viewOf(map, [run('m/1', 'needs-voice')]).items[0]!.state).toBe('scripted');
    expect(viewOf(map, [run('m/1', 'ready', '2026-10-12', true)]).items[0]!.state).toBe('voiced');
    expect(viewOf(map, [run('m/1', 'published', '2026-10-12', true)]).items[0]!.state).toBe('published');
  });

  it('a failed run leaves the item to be made again', () => {
    expect(viewOf(map, [run('m/1', 'failed')]).next?.state).toBe('retry');
  });

  it('crosses into the next series and ends with nothing next', () => {
    const v = viewOf(map, [run('m/1', 'published'), run('m/2', 'published')]);
    expect(v.next).toMatchObject({ key: 'm/3', seriesTitle: 'Two', position: 1, seriesSize: 1 });
    expect(viewOf(map, ['m/1', 'm/2', 'm/3'].map((k) => run(k, 'published'))).next).toBeNull();
  });

  it('the shipped maps parse, with every episode numbered once', () => {
    const maps = loadAllMaps(path.join(__dirname, '..', '..', '..', 'maps'));
    expect(maps.length).toBeGreaterThan(0);
    for (const m of maps) {
      // A map in a format its channel does not make could never be started.
      expect(loadPersona(m.channelId).formats).toContain(m.formatId);
      const numbers = m.series.flatMap((s) => s.episodes.map((e) => e.number));
      expect(new Set(numbers).size).toBe(numbers.length);
    }
  });

  it('gives the business lane a plain subject for each company, not the long topic', () => {
    const [biz] = loadMaps('business-decoded');
    const eps = biz!.series.flatMap((s) => s.episodes);
    expect(eps).toHaveLength(70);
    expect(eps.every((e) => e.subject && e.subject.length < 30)).toBe(true);
    expect(mapSubject('business-by-country/1')).toBe('Tata Group');
    expect(mapSubject('business-by-country/40')).toBe('Sega');
    expect(mapSubject('hindu-mythology/1')).toBeNull();
    // The shorts map names its companies the same way.
    const shorts = loadMaps('business-decoded').find((m) => m.id === 'business-shorts')!;
    expect(shorts.series.flatMap((s) => s.episodes).every((e) => e.subject && e.subject.length < 30)).toBe(true);
    expect(mapSubject('business-shorts/1')).toBe('Starbucks');
    expect(mapSubject(undefined)).toBeNull();
  });
});
