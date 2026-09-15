/**
 * Slot arithmetic, which is where the fiddly cases live.
 *
 * Every timezone test below is against Europe/London, because that is where the
 * listeners are and because it changes its clocks twice a year - which is the
 * only reason any of this is harder than adding seven days.
 */
import {
  atHourOn,
  describeSlot,
  instantOfWallClock,
  nextSlotAfter,
  shortDueAfterDays,
  weekdayAt,
} from '../slots';

const TZ = 'Europe/London';

describe('wall clock arithmetic', () => {
  it('reads a winter time as GMT and a summer time as BST', () => {
    // The whole reason for a named zone rather than an offset. 08:00 means
    // 08:00 to a listener in both halves of the year, which is two different
    // instants in UTC.
    expect(instantOfWallClock('2026-01-15T08:00:00', TZ).toISOString()).toBe(
      '2026-01-15T08:00:00.000Z'
    );
    expect(instantOfWallClock('2026-07-15T08:00:00', TZ).toISOString()).toBe(
      '2026-07-15T07:00:00.000Z'
    );
  });

  it('gets the hour right on the day the clocks go forward', () => {
    // 2026-03-29 is when the UK springs forward. A naive offset taken from the
    // day before would put this an hour out.
    expect(instantOfWallClock('2026-03-29T08:00:00', TZ).toISOString()).toBe(
      '2026-03-29T07:00:00.000Z'
    );
  });

  it('gets the hour right on the day the clocks go back', () => {
    // 2026-10-25 is when the UK falls back.
    expect(instantOfWallClock('2026-10-25T08:00:00', TZ).toISOString()).toBe(
      '2026-10-25T08:00:00.000Z'
    );
  });

  it('knows which day it is in the zone, not in UTC', () => {
    // The same instant is Tuesday evening in New York and already Wednesday in
    // London, and a slot that used the machine's idea of the day would fire on
    // the wrong one.
    const instant = new Date('2026-09-15T23:30:00Z');
    expect(weekdayAt(instant, 'America/New_York')).toBe(2);
    expect(weekdayAt(instant, TZ)).toBe(3);
  });

  it('finds a given hour on the day an instant falls in', () => {
    const on = atHourOn(new Date('2026-07-15T22:00:00Z'), 8, TZ);
    expect(on.toISOString()).toBe('2026-07-15T07:00:00.000Z');
  });
});

describe('nextSlotAfter', () => {
  it('finds the slot later the same day', () => {
    // 2026-09-15 is a Tuesday. 06:00 UTC is 07:00 in London, so the 08:00 slot
    // is still ahead.
    const at = nextSlotAfter(new Date('2026-09-15T06:00:00Z'), { day: 'tue', hour: 8 }, TZ);
    expect(at.toISOString()).toBe('2026-09-15T07:00:00.000Z');
  });

  it('rolls to next week once the slot has passed', () => {
    const at = nextSlotAfter(new Date('2026-09-15T09:00:00Z'), { day: 'tue', hour: 8 }, TZ);
    expect(at.toISOString()).toBe('2026-09-22T07:00:00.000Z');
  });

  it('returns the slot itself when asked at exactly that moment', () => {
    // At-or-after, not strictly after. A tick that fires precisely on the hour
    // should publish, not wait a week.
    const exact = new Date('2026-09-15T07:00:00Z');
    expect(nextSlotAfter(exact, { day: 'tue', hour: 8 }, TZ).getTime()).toBe(exact.getTime());
  });

  it('crosses a clock change without drifting an hour', () => {
    // Asked on the Tuesday before the spring change for the Tuesday after it.
    const at = nextSlotAfter(new Date('2026-03-25T00:00:00Z'), { day: 'tue', hour: 8 }, TZ);
    expect(at.toISOString()).toBe('2026-03-31T07:00:00.000Z');
    expect(weekdayAt(at, TZ)).toBe(2);
  });

  it('finds every weekday from any starting point', () => {
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
    const from = new Date('2026-09-15T12:00:00Z');

    days.forEach((day, i) => {
      const at = nextSlotAfter(from, { day, hour: 9 }, TZ);
      expect(weekdayAt(at, TZ)).toBe(i);
      // Always within a week, never further.
      expect(at.getTime() - from.getTime()).toBeLessThan(8 * 86_400_000);
      expect(at.getTime()).toBeGreaterThanOrEqual(from.getTime());
    });
  });
});

describe('shortDueAfterDays', () => {
  it('spreads two shorts across a week rather than stacking them', () => {
    // THE WHOLE POINT. Both on day 1 is what a scheduler that simply publishes
    // whatever is due does, and it wastes the second one.
    expect(shortDueAfterDays(0, 2, 7)).toBe(2);
    expect(shortDueAfterDays(1, 2, 7)).toBe(5);
  });

  it('puts a single short in the middle of the gap', () => {
    expect(shortDueAfterDays(0, 1, 7)).toBe(4);
  });

  it('never lands a short on the episode it was cut from', () => {
    // A short beside its own episode competes with it, and a listener sees the
    // same story twice in one scroll.
    for (let every = 1; every <= 14; every++) {
      for (let count = 1; count <= 4; count++) {
        for (let i = 0; i < count; i++) {
          expect(shortDueAfterDays(i, count, every)).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('keeps shorts in order and inside the gap', () => {
    const days = [0, 1, 2].map((i) => shortDueAfterDays(i, 3, 7));
    expect(days).toEqual([...days].sort((a, b) => a - b));
    expect(Math.max(...days)).toBeLessThan(7);
  });
});

describe('describeSlot', () => {
  it('reads as a time somebody would say', () => {
    expect(describeSlot({ day: 'tue', hour: 8 })).toBe('Tue 08:00');
    expect(describeSlot({ day: 'fri', hour: 18 })).toBe('Fri 18:00');
  });
});
