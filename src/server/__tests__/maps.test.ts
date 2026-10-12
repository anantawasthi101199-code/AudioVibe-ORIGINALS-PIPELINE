/**
 * Content maps release one item at a time, and only once the one before it is
 * published. The state is read off the runs, so these feed runs in directly.
 */
import path from 'path';
import { loadMaps, viewOf, ContentMap } from '../maps';

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
const run = (mapItem: string, state: string, createdAt = '2026-10-12') =>
  ({ id: `c/${mapItem}`, mapItem, state, createdAt }) as never;

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
      expect(v.next?.state).toBe('making');
    }
    expect(viewOf(map, [run('m/1', 'published')]).next?.key).toBe('m/2');
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
    const maps = loadMaps('mythic-archives', path.join(__dirname, '..', '..', '..', 'maps'));
    expect(maps.length).toBeGreaterThan(0);
    for (const m of maps) {
      const numbers = m.series.flatMap((s) => s.episodes.map((e) => e.number));
      expect(new Set(numbers).size).toBe(numbers.length);
    }
  });
});
