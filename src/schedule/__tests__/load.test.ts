/**
 * The schedule and the topic queues, read off disk.
 *
 * The queue behaviour is the interesting half. A topic is taken BEFORE the run
 * and put back on failure, because a topic consumed only on success means a
 * failing show retries the same subject on every tick forever, spending money
 * each time and never reaching the next one.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import YAML from 'yaml';
import {
  ScheduleLoadError,
  loadSchedule,
  loadTopics,
  returnTopic,
  takeTopic,
} from '../load';

describe('loadSchedule', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-sched-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (body: unknown) =>
    fs.writeFileSync(path.join(dir, 'schedule.yaml'), YAML.stringify(body));

  it('treats no file as nothing scheduled', () => {
    // The safe direction. A studio that publishes nothing is a problem somebody
    // notices; a studio that publishes something nobody asked for is a problem
    // somebody's followers notice.
    expect(loadSchedule(dir)).toEqual({ shows: {}, paused: false });
  });

  it('applies the defaults a terse entry leaves out', () => {
    write({ shows: { 'the-teardown': { everyDays: 7 } } });
    const cadence = loadSchedule(dir).shows['the-teardown']!;
    expect(cadence.shortsPerEpisode).toBe(0);
    expect(cadence.autoPublish).toBe(false);
  });

  it('defaults autoPublish to OFF', () => {
    // The pipeline stops at the gate exactly as it does when run by hand. The
    // two checks the gate hands to a person are the ones a loop waves through.
    write({ shows: { x: { everyDays: 1 } } });
    expect(loadSchedule(dir).shows.x!.autoPublish).toBe(false);
  });

  it('THROWS on a malformed schedule rather than reading it as empty', () => {
    // A malformed schedule reading as "nothing due" is a studio going quiet
    // with no error anywhere.
    fs.writeFileSync(path.join(dir, 'schedule.yaml'), 'shows: [this is a list]');
    expect(() => loadSchedule(dir)).toThrow(ScheduleLoadError);
  });

  it('refuses a cadence of zero days', () => {
    write({ shows: { x: { everyDays: 0 } } });
    expect(() => loadSchedule(dir)).toThrow(ScheduleLoadError);
  });

  it('reads the pause switch', () => {
    write({ paused: true, shows: {} });
    expect(loadSchedule(dir).paused).toBe(true);
  });
});

describe('the topic queue', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-topics-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (topics: string[]) =>
    fs.writeFileSync(path.join(dir, 'show.yaml'), YAML.stringify({ topics }));

  it('treats no file as an empty queue', () => {
    expect(loadTopics('show', dir).topics).toEqual([]);
  });

  it('takes from the front', () => {
    write(['first', 'second']);
    expect(takeTopic('show', dir)).toBe('first');
    expect(loadTopics('show', dir).topics).toEqual(['second']);
  });

  it('returns null on an empty queue rather than throwing', () => {
    // An empty queue is a show waiting for a person, which the plan reports.
    // It is not an error.
    expect(takeTopic('show', dir)).toBeNull();
  });

  it('does not hand out the same topic twice', () => {
    // The failure this shape exists to prevent: a topic consumed only on
    // success means a failing show retries the same subject on every tick,
    // spending money each time and never reaching the next one.
    write(['only']);
    expect(takeTopic('show', dir)).toBe('only');
    expect(takeTopic('show', dir)).toBeNull();
  });

  it('puts a topic back on the FRONT', () => {
    // A failed run should try the same subject next, not go to the back of a
    // queue and come round in a fortnight.
    write(['second']);
    returnTopic('show', 'first', dir);
    expect(loadTopics('show', dir).topics).toEqual(['first', 'second']);
  });

  it('round-trips take and return', () => {
    write(['a', 'b']);
    const taken = takeTopic('show', dir)!;
    returnTopic('show', taken, dir);
    expect(loadTopics('show', dir).topics).toEqual(['a', 'b']);
  });

  it('creates the queue file when returning to a show that had none', () => {
    returnTopic('brand-new', 'a topic', dir);
    expect(loadTopics('brand-new', dir).topics).toEqual(['a topic']);
  });

  it('THROWS on a malformed queue', () => {
    fs.writeFileSync(path.join(dir, 'show.yaml'), 'topics: 42');
    expect(() => loadTopics('show', dir)).toThrow(ScheduleLoadError);
  });
});

describe('the shipped schedule', () => {
  it('parses, and every show in it has a persona', async () => {
    // A schedule naming a show that does not exist is a typo, and a typo that
    // silently means "never publish this" is the worst kind. The plan reports
    // it at runtime; this catches it at commit time.
    const { loadAllPersonas } = await import('../../canon/load');
    const ids = new Set(loadAllPersonas().map((p) => p.id));

    for (const showId of Object.keys(loadSchedule().shows)) {
      expect(ids.has(showId)).toBe(true);
    }
  });

  it('has nothing set to publish automatically', () => {
    // Not a rule the code enforces - a show can opt in. But it should never
    // become true by accident, and a diff on this test is the moment to think
    // about it.
    for (const [id, cadence] of Object.entries(loadSchedule().shows)) {
      expect(`${id}:${cadence.autoPublish}`).toBe(`${id}:false`);
    }
  });
});
