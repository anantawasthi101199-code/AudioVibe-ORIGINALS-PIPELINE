/**
 * What reaches the calendar, and on which day.
 *
 * THE DAY IS THE WHOLE POINT. An approved episode sits on the day it is going
 * out; the moment it publishes it moves to the day it actually went, which is
 * usually today. Getting that wrong leaves something that has been published
 * drawn in the future as though it were still to come, which is the calendar
 * telling you the opposite of what happened.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import { getCalendar } from '../calendar';

const withRuns = <T>(fn: (root: string) => T): T => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-'));
  const before = process.env.FOUNDRY_RUNS_DIR;
  process.env.FOUNDRY_RUNS_DIR = root;
  try {
    return fn(root);
  } finally {
    if (before === undefined) delete process.env.FOUNDRY_RUNS_DIR;
    else process.env.FOUNDRY_RUNS_DIR = before;
    fs.rmSync(root, { recursive: true, force: true });
  }
};

/** A run of the honest-health ten-stories set, as a cut story. */
const story = (root: string, n: number): Run => {
  const run = Run.create(
    { personaId: 'honest-health', formatId: 'ten-stories', topic: 'x', story: n, short: n },
    { root }
  );
  run.writeArtifact('script', {
    personaId: 'honest-health',
    formatId: 'ten-stories',
    title: `Story ${n}`,
    description: 'd',
    beats: [],
    writerModel: 'm',
  });
  return run;
};

const day = (iso: string) => iso.slice(0, 10);

describe('getCalendar', () => {
  it('draws an approved episode on the day it is going out', () => {
    withRuns((root) => {
      const run = story(root, 1);
      run.setReleaseAt(new Date('2026-09-17T07:00:00Z'), new Date());

      const view = getCalendar('2026-09');
      const all = view.days.flatMap((d) => d.entries);

      expect(all).toHaveLength(1);
      expect(all[0]!.state).toBe('approved');
      expect(view.days[0]!.date).toBe('2026-09-17');
    });
  });

  it('IGNORES A DATE NOBODY APPROVED', () => {
    // A calendar of what is going to happen must not draw things nobody agreed
    // to, or the grid is a wish rather than a plan.
    withRuns((root) => {
      story(root, 1).setReleaseAt(new Date('2026-09-17T07:00:00Z'));

      expect(getCalendar('2026-09').days).toEqual([]);
      expect(getCalendar('2026-09').queue).toEqual([]);
    });
  });

  it('MOVES IT TO THE DAY IT ACTUALLY WENT once published', () => {
    // The thing that was broken: publishing left the entry drawn on its old
    // future date, so a calendar showed an episode as still to come hours
    // after it had gone out.
    withRuns((root) => {
      const run = story(root, 1);
      run.setReleaseAt(new Date('2026-09-30T07:00:00Z'), new Date());

      // Published early, by hand.
      run.writeArtifact('publish', {
        audioId: 'a1',
        status: 'ready',
        publishedAt: '2026-09-16T11:22:00Z',
        url: 'https://api.audiovibe.co',
      });
      run.markComplete('publish');

      const view = getCalendar('2026-09');
      const all = view.days.flatMap((d) => d.entries);

      expect(all).toHaveLength(1);
      expect(all[0]!.state).toBe('published');
      expect(day(all[0]!.at)).toBe('2026-09-16');
      expect(view.days.map((d) => d.date)).toEqual(['2026-09-16']);
    });
  });

  it('takes a published episode out of the queue', () => {
    // The queue is what is still going to happen. Something already out is not.
    withRuns((root) => {
      const a = story(root, 1);
      const b = story(root, 2);
      a.setReleaseAt(new Date('2026-09-17T07:00:00Z'), new Date());
      b.setReleaseAt(new Date('2026-09-19T07:00:00Z'), new Date());

      expect(getCalendar('2026-09').queue).toHaveLength(2);

      a.writeArtifact('publish', { audioId: 'a1', publishedAt: '2026-09-16T11:00:00Z' });
      a.markComplete('publish');

      const queue = getCalendar('2026-09').queue;
      expect(queue).toHaveLength(1);
      expect(queue[0]!.position).toBe(1);
    });
  });

  it('numbers the queue soonest first, across every channel', () => {
    withRuns((root) => {
      story(root, 1).setReleaseAt(new Date('2026-09-25T07:00:00Z'), new Date());
      story(root, 2).setReleaseAt(new Date('2026-09-17T07:00:00Z'), new Date());
      story(root, 3).setReleaseAt(new Date('2026-09-20T07:00:00Z'), new Date());

      const queue = getCalendar('2026-09').queue;
      expect(queue.map((q) => q.position)).toEqual([1, 2, 3]);
      expect(queue.map((q) => day(q.at))).toEqual(['2026-09-17', '2026-09-20', '2026-09-25']);
    });
  });

  it('keeps the queue whole when you page to another month', () => {
    // "What goes out next" does not stop being the answer because somebody
    // looked at October.
    withRuns((root) => {
      story(root, 1).setReleaseAt(new Date('2026-09-17T07:00:00Z'), new Date());
      story(root, 2).setReleaseAt(new Date('2026-10-02T07:00:00Z'), new Date());

      const october = getCalendar('2026-10');
      expect(october.days.flatMap((d) => d.entries)).toHaveLength(1);
      expect(october.queue).toHaveLength(2);
    });
  });

  it('never draws a source script', () => {
    withRuns((root) => {
      const source = Run.create(
        { personaId: 'honest-health', formatId: 'ten-stories', topic: 'x' },
        { root }
      );
      source.writeArtifact('script', {
        personaId: 'honest-health',
        formatId: 'ten-stories',
        title: 'The set',
        description: 'd',
        beats: [],
        writerModel: 'm',
      });
      source.setReleaseAt(new Date('2026-09-17T07:00:00Z'), new Date());

      expect(getCalendar('2026-09').days).toEqual([]);
    });
  });
});
