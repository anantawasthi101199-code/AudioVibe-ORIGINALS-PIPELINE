import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { newRunName, Run, slugForTopic } from '../store';

describe('slugForTopic', () => {
  it('turns a topic into something readable in a directory listing', () => {
    expect(slugForTopic('The sinking of the Marchioness on the Thames in August 1989')).toBe(
      'sinking-of-the-marchioness-on-the'
    );
  });

  it('drops a leading filler word, which says nothing and eats the budget', () => {
    expect(slugForTopic('Why a bad night makes you forget things')).toBe(
      'a-bad-night-makes-you-forget'
    );
  });

  it('survives punctuation, apostrophes and accents', () => {
    expect(slugForTopic("HHJ Kinch's sentencing remarks, 2016")).toBe('hhj-kinchs-sentencing-remarks-2016');
  });

  it('never returns an empty name', () => {
    expect(slugForTopic('!!! ???')).toBe('untitled');
  });
});

describe('newRunName', () => {
  /**
   * WHAT THE OLD SCHEME COULD NOT TELL YOU. Every run lived directly under
   * runs/ as `20260913-000745-older-than-writing`, which answers "when" and
   * "which show" and nothing else - not which episode, not what about, and
   * worst, not which episode a short was cut from.
   */
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-names-'));
  });

  const make = (personaId: string, topic: string, parentEpisode?: number) => {
    const name = newRunName({ personaId, topic, parentEpisode }, root, new Date('2026-09-13T10:00:00Z'));
    fs.mkdirSync(path.join(root, ...name.id.split('/')), { recursive: true });
    fs.writeFileSync(path.join(root, ...name.id.split('/'), 'run.json'), '{}');
    return name;
  };

  it('puts a channel in its own folder, numbered and dated and named', () => {
    const name = make('honest-health', 'Why a bad night makes you forget things');
    expect(name.id).toBe('honest-health/e001-20260913-a-bad-night-makes-you-forget');
    expect(name.episode).toBe(1);
  });

  it('counts episodes per channel, not across the studio', () => {
    make('honest-health', 'One');
    make('read-the-file', 'Two');
    expect(make('honest-health', 'Three').episode).toBe(2);
    expect(make('read-the-file', 'Four').episode).toBe(2);
  });

  it('puts a short beside the episode it came from, carrying its number', () => {
    make('honest-health', 'The parent episode');
    const short = make('honest-health', 'The twenty minute gap', 1);
    expect(short.id).toBe('honest-health/e001-s01-20260913-twenty-minute-gap');
    expect(short.episode).toBe(1);
    expect(short.short).toBe(1);
  });

  it('numbers a second short of the same episode', () => {
    make('honest-health', 'The parent');
    make('honest-health', 'First short', 1);
    expect(make('honest-health', 'Second short', 1).short).toBe(2);
  });

  it('DOES NOT let shorts advance the episode number', () => {
    // Three shorts cut from episode one must not make the next episode four. A
    // short is not an episode.
    make('honest-health', 'Episode one');
    make('honest-health', 'a', 1);
    make('honest-health', 'b', 1);
    make('honest-health', 'c', 1);
    expect(make('honest-health', 'Episode two').episode).toBe(2);
  });

  it('sorts into production order within a channel', () => {
    // The reason the old scheme led with a timestamp, and it survives: within a
    // channel the episode number leads, so `ls` answers "what is the latest".
    const first = make('honest-health', 'One');
    const second = make('honest-health', 'Two');
    const short = make('honest-health', 'A short of one', 1);
    const leaves = [second.id, short.id, first.id].map((id) => id.split('/')[1]!).sort();
    expect(leaves).toEqual([
      first.id.split('/')[1],
      short.id.split('/')[1],
      second.id.split('/')[1],
    ]);
  });
});

describe('Run', () => {
  let root: string;
  const now = () => new Date('2026-09-07T09:00:00Z');
  const create = () =>
    Run.create({ personaId: 'business-teardowns', formatId: 'case-study-teardown', topic: 'A topic' }, { root, now });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-runs-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('NEVER adopts an existing run directory', () => {
    // Before this, two runs of the same show in one second landed on the same
    // id, and `Run.create` mkdir -p'd straight into the first one's directory:
    // same manifest path, same artifacts, hasArtifact true for stages the new
    // run had never done. It would have written an episode out of another
    // episode's corpus and looked entirely healthy doing it.
    const first = create();
    first.writeArtifact('brief', { angle: 'the first run' });

    const second = create();

    expect(second.id).not.toBe(first.id);
    expect(second.hasArtifact('brief')).toBe(false);
    expect(first.readArtifact('brief', z.object({ angle: z.string() })).angle).toBe(
      'the first run'
    );
  });

  it('creates a directory with a manifest', () => {
    const run = create();
    expect(fs.existsSync(path.join(run.dir, 'run.json'))).toBe(true);
    expect(run.manifest.topic).toBe('A topic');
    expect(run.manifest.completed).toEqual([]);
  });

  it('round-trips an artifact', () => {
    const run = create();
    run.writeArtifact('brief', { angle: 'the alarm' });
    const back = Run.open(run.id, { root }).readArtifact('brief', z.object({ angle: z.string() }));
    expect(back.angle).toBe('the alarm');
  });

  it('writes artifacts as readable JSON, because a person reads them', () => {
    const run = create();
    const file = run.writeArtifact('brief', { angle: 'x' });
    expect(fs.readFileSync(file, 'utf8')).toContain('\n  "angle"');
  });

  it('explains a missing artifact rather than throwing ENOENT', () => {
    expect(() => create().readArtifact('script', z.unknown())).toThrow(/has no script artifact yet/);
  });

  it('remembers completed stages across reopen, so a rerun can skip them', () => {
    // Rendering is the expensive step and scripting the slow one. Re-running QA
    // must not mean paying for either again.
    const run = create();
    run.markComplete('corpus');
    expect(Run.open(run.id, { root }).isComplete('corpus')).toBe(true);
    expect(Run.open(run.id, { root }).isComplete('script')).toBe(false);
  });

  it('does not record a stage twice', () => {
    const run = create();
    run.markComplete('corpus');
    run.markComplete('corpus');
    expect(run.manifest.completed).toEqual(['corpus']);
  });

  it('finds the latest run', () => {
    Run.create({ personaId: 'a', formatId: 'f', topic: 't' }, { root, now: () => new Date('2026-09-07T09:00:00Z') });
    const later = Run.create({ personaId: 'b', formatId: 'f', topic: 't' }, { root, now: () => new Date('2026-09-08T09:00:00Z') });
    expect(Run.latest({ root })?.id).toBe(later.id);
  });

  it('returns null for latest when nothing has run', () => {
    expect(Run.latest({ root: path.join(root, 'empty') })).toBeNull();
  });

  it('refuses to open a run that does not exist', () => {
    expect(() => Run.open('nope', { root })).toThrow(/no run "nope"/);
  });

  describe('budget', () => {
    it('accumulates spend', () => {
      const run = create();
      run.spend(100, 500);
      run.spend(50, 500);
      expect(run.manifest.spentPence).toBe(150);
    });

    it('THROWS past the ceiling rather than carrying on', () => {
      // A run that quietly continues over budget produces an episode nobody
      // decided to pay for.
      const run = create();
      expect(() => run.spend(600, 500)).toThrow(/over the 500p ceiling/);
    });

    it('persists spend so a resumed run cannot reset its own budget', () => {
      const run = create();
      run.spend(400, 500);
      expect(() => Run.open(run.id, { root }).spend(200, 500)).toThrow(/over the/);
    });
  });

  it('records abandonment rather than deleting the evidence', () => {
    const run = create();
    run.abandon('sources too thin');
    expect(Run.open(run.id, { root }).manifest.abandoned).toBe('sources too thin');
  });

  it('gives media a home outside the JSON', () => {
    const run = create();
    const p = run.mediaPath('beat_1.mp3');
    expect(fs.existsSync(path.dirname(p))).toBe(true);
  });
});
