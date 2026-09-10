import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { newRunId, Run } from '../store';

describe('newRunId', () => {
  it('sorts chronologically as a string', () => {
    // A directory listing is the primary interface to runs, so `ls` order has
    // to be the order they happened. An opaque uuid would make "what did we
    // make most recently" need a tool.
    const a = newRunId('show', new Date('2026-09-07T09:00:00Z'));
    const b = newRunId('show', new Date('2026-09-07T10:00:00Z'));
    expect([b, a].sort()).toEqual([a, b]);
  });

  it('names the show, so a listing is readable', () => {
    expect(newRunId('the-teardown', new Date('2026-09-07T09:00:00Z'))).toContain('the-teardown');
  });

  it('disambiguates two runs of the same show in the same second', () => {
    // The stamp is only accurate to the second, and two runs of one show inside
    // a second is not hypothetical: cutting a short right after gating its
    // parent does it.
    const at = new Date('2026-09-07T09:00:00Z');
    const first = newRunId('show', at);
    expect(newRunId('show', at, (id) => id === first)).not.toBe(first);
  });

  it('keeps the disambiguated id in chronological order', () => {
    const at = new Date('2026-09-07T09:00:00Z');
    const first = newRunId('show', at);
    const second = newRunId('show', at, (id) => id === first);
    const later = newRunId('show', new Date('2026-09-07T09:00:01Z'));
    expect([later, second, first].sort()).toEqual([first, second, later]);
  });
});

describe('Run', () => {
  let root: string;
  const now = () => new Date('2026-09-07T09:00:00Z');
  const create = () =>
    Run.create({ personaId: 'the-teardown', formatId: 'case-study-teardown', topic: 'A topic' }, { root, now });

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
