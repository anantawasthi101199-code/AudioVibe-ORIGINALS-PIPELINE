/**
 * The library: one file listing everything the studio has ever made.
 *
 * WHY THIS EXISTS WHEN EVERY RUN IS ALREADY A DIRECTORY. Because a directory
 * per run answers "what happened in this one" and nothing answers "what have we
 * made, and which of it was any good". After twenty runs the second question is
 * the one you actually have, and answering it by opening twenty directories is
 * how people stop asking it.
 *
 * WHAT IT IS FOR. Looking back. Which topics produced episodes that passed
 * first time, which gate checks fail most often, what an episode actually
 * costs once you stop guessing, and where to find the script of the one you
 * half remember. That is the raw material for tuning the style cards and the
 * beat sheets, which is the work that makes the shows better.
 *
 * DERIVED, NEVER AUTHORITATIVE. It is rebuilt from the run directories every
 * time it is written, so it can be deleted without losing anything and can
 * never drift from the runs it describes. Nothing reads it back - if a piece of
 * code needs a fact about a run, it reads the run.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { repoRoot } from '../config';
import { GateReport } from '../qa/gate';
import { Run } from './store';
import { scriptSchema } from '../script/write';

export interface LibraryEntry {
  runId: string;
  personaId: string;
  formatId: string;
  topic: string;
  createdAt: string;
  title: string | null;
  /** Where the run stopped: the last stage it completed. */
  reached: string;
  gate: 'passed' | 'failed' | 'not run';
  /** Blocking check names, so the common failures are countable. */
  blocking: string[];
  needsHumanReview: boolean;
  spentPence: number;
  durationS: number | null;
  publishedAt: string | null;
  /** Set on a short, naming the episode it was cut from. */
  derivedFrom?: string;
  abandoned?: string;
  dir: string;
}

const gateOf = (run: Run): GateReport | null => {
  const file = path.join(run.dir, 'qa.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as GateReport;
  } catch {
    return null;
  }
};

/** One run, reduced to what a person scanning a list wants. */
export const summarise = (run: Run): LibraryEntry => {
  const m = run.manifest;
  const gate = gateOf(run);

  let title: string | null = null;
  if (run.hasArtifact('script')) {
    try {
      title = run.readArtifact('script', scriptSchema).title;
    } catch {
      // A script that will not parse is a real problem, but not this file's.
    }
  }

  let durationS: number | null = null;
  if (run.hasArtifact('render')) {
    try {
      durationS = run.readArtifact('render', z.object({ durationS: z.number() })).durationS;
    } catch {
      durationS = null;
    }
  }

  return {
    runId: m.id,
    personaId: m.personaId,
    formatId: m.formatId,
    topic: m.topic,
    createdAt: m.createdAt,
    title,
    reached: m.completed[m.completed.length - 1] ?? '(nothing)',
    gate: gate ? (gate.passed ? 'passed' : 'failed') : 'not run',
    blocking: gate ? gate.findings.filter((f) => f.blocking).map((f) => f.check) : [],
    needsHumanReview: gate?.needsHumanReview ?? false,
    spentPence: m.spentPence,
    durationS,
    publishedAt: run.readPublishTimestamp(),
    derivedFrom: m.derivedFrom,
    abandoned: m.abandoned,
    dir: run.dir,
  };
};

/** Every run, newest first. A run that will not open is skipped, not fatal. */
export const buildLibrary = (): LibraryEntry[] =>
  Run.list()
    .flatMap((id) => {
      try {
        return [summarise(Run.open(id))];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

const libraryPath = (dir?: string) => path.join(dir ?? repoRoot(), 'LIBRARY.md');

/**
 * Write the library as Markdown.
 *
 * MARKDOWN RATHER THAN JSON, because the audience is a person deciding what to
 * make next, not a program. It renders in an editor, in a browser and on
 * GitHub, and it diffs readably - which turns "what changed since last week"
 * into something you can see rather than something you have to query.
 *
 * The JSON is written alongside it for anything that does want to compute over
 * it, so neither audience is served badly for the other's benefit.
 */
export const writeLibrary = (dir?: string): { markdown: string; json: string } => {
  const entries = buildLibrary();
  const root = dir ?? repoRoot();

  const pence = (p: number) => `£${(p / 100).toFixed(2)}`;
  const mins = (s: number | null) => (s === null ? '-' : `${Math.round(s / 60)}m`);

  const lines: string[] = [
    '# Library',
    '',
    'Everything the studio has made, newest first. Rebuilt by `foundry library`,',
    'so it can be deleted without losing anything and cannot drift from the runs',
    'it describes.',
    '',
  ];

  if (!entries.length) {
    lines.push('Nothing made yet.');
  } else {
    const spent = entries.reduce((sum, e) => sum + e.spentPence, 0);
    const passed = entries.filter((e) => e.gate === 'passed').length;

    lines.push(
      `${entries.length} run(s), ${passed} passed the gate, ${pence(spent)} spent in total.`,
      '',
      '| Run | Show | Title | Gate | Cost | Length | Published |',
      '| --- | --- | --- | --- | --- | --- | --- |'
    );

    for (const e of entries) {
      const gate =
        e.gate === 'failed' && e.blocking.length
          ? `failed (${e.blocking.slice(0, 2).join(', ')})`
          : e.gate;
      lines.push(
        `| \`${e.runId}\` | ${e.personaId} | ${e.title ?? `_${e.topic.slice(0, 50)}_`} | ` +
          `${gate} | ${pence(e.spentPence)} | ${mins(e.durationS)} | ` +
          `${e.publishedAt ? e.publishedAt.slice(0, 10) : '-'} |`
      );
    }

    // What actually stops episodes, counted. This is the reason to keep a
    // library at all: one failing gate check is an episode, the same check
    // failing six times is a style card or a beat sheet that needs changing.
    const failures = new Map<string, number>();
    for (const e of entries) {
      for (const check of e.blocking) failures.set(check, (failures.get(check) ?? 0) + 1);
    }

    if (failures.size) {
      lines.push('', '## What stops episodes', '');
      for (const [check, count] of [...failures].sort((a, b) => b[1] - a[1])) {
        lines.push(`- \`${check}\` - ${count}`);
      }
      lines.push(
        '',
        'A check failing once is an episode. The same check failing repeatedly is',
        'a style card or a beat sheet asking to be changed.'
      );
    }

    lines.push('', '## Where to find them', '');
    for (const e of entries.slice(0, 20)) {
      lines.push(`- \`${e.runId}\` - ${e.topic}`);
      lines.push(`  - \`${path.relative(root, e.dir) || e.dir}\``);
      lines.push(`  - \`npm run foundry -- script --run ${e.runId}\``);
    }
  }

  const markdown = `${lines.join('\n')}\n`;
  fs.writeFileSync(libraryPath(dir), markdown, 'utf8');

  const jsonPath = path.join(root, 'library.json');
  fs.writeFileSync(jsonPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');

  return { markdown: libraryPath(dir), json: jsonPath };
};
