import { scaleBeatMap } from '../publishRun';

describe('scaleBeatMap', () => {
  it('moves every chapter earlier in proportion when the episode is sped up', () => {
    const map = [
      { id: 'a', type: 'hook', startS: 0, endS: 50 },
      { id: 'b', type: 'story', startS: 50, endS: 140 },
    ];
    expect(scaleBeatMap(map, 1.25)).toEqual([
      { id: 'a', type: 'hook', startS: 0, endS: 40 },
      { id: 'b', type: 'story', startS: 40, endS: 112 },
    ]);
    expect(scaleBeatMap(map, 1)).toBe(map);
  });
});
