import { IDLE_MS, STALE_MS, blockedBy, clearHolds, heartbeat, holderOf, release } from '../holds';

describe('holding a run while you work on it', () => {
  beforeEach(clearHolds);
  const T = 1_000_000;

  it('belongs to whoever opened it first, and others are told who', () => {
    expect(heartbeat('r', 'anant', true, T).mine).toBe(true);
    const devesh = heartbeat('r', 'devesh', true, T + 1000);
    expect(devesh).toMatchObject({ holder: 'anant', mine: false });
    expect(blockedBy('r', 'devesh', T + 1000)).toBe('anant');
    expect(blockedBy('r', 'anant', T + 1000)).toBeNull();
  });

  it('is released at once when they leave', () => {
    heartbeat('r', 'anant', true, T);
    release('r', 'devesh'); // not theirs to release
    expect(holderOf('r', T)).toBe('anant');
    release('r', 'anant');
    expect(heartbeat('r', 'gathra', true, T + 1).mine).toBe(true);
  });

  it('lapses when the heartbeat stops, as after a crash', () => {
    heartbeat('r', 'anant', true, T);
    expect(holderOf('r', T + STALE_MS + 1)).toBeNull();
    expect(heartbeat('r', 'devesh', true, T + STALE_MS + 1).mine).toBe(true);
  });

  it('lapses after 30 minutes idle even with the page open and heartbeating', () => {
    heartbeat('r', 'anant', true, T);
    for (let t = T; t < T + IDLE_MS; t += 20_000) heartbeat('r', 'anant', false, t);
    expect(holderOf('r', T + IDLE_MS + 1)).toBeNull();
    expect(blockedBy('r', 'devesh', T + IDLE_MS + 1)).toBeNull();
  });

  it('is not taken on behalf of somebody idle, and is picked up again on activity', () => {
    expect(heartbeat('r', 'anant', false, T).holder).toBeNull();
    expect(heartbeat('r', 'anant', true, T + 1).mine).toBe(true);
  });
});
