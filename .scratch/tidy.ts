/**
 * Stash what the old pipelines left behind, and renumber what survives.
 *
 * WHAT GOES. Anything that cannot pass its gate under today's checks. Those
 * runs were written by earlier versions of this pipeline - before quote
 * failures were fed to repair, before claims were retyped at extraction,
 * before a show's source tier was applied ahead of the writer - and their
 * faults are baked into artifacts on disk. Re-gating them is free; fixing them
 * is not, and is not worth it.
 *
 * NOTHING IS DELETED. Every stashed run moves to binfiles with its audio and
 * its ledger intact, so anything that turns out to have been worth keeping is
 * a move back rather than a re-run at a pound a time.
 *
 * WHY RENUMBER AT ALL. After a stash the numbering has holes in it - honest
 * health would run e006 with no e001 to e005 - and a catalogue whose first
 * episode is number six invites the question of what happened to the other
 * five. The episode number is a position in a shelf, not an identity: the
 * identity is the run id, which changes with it, and the `story` number is
 * kept exactly as it was because that IS an identity - which beat of the
 * source script this was cut from.
 */
import fs from 'fs';
import path from 'path';
import { Run } from '../src/run/store';
import { regate } from '../src/qa/regate';
import { scriptSchema } from '../src/script/write';
import { loadFormat } from '../src/formats/load';

const DRY = !process.argv.includes('--go');
const RUNS = path.join(__dirname, '..', 'runs');
const STASH = path.join(
  'C:',
  'Users',
  'anant',
  'Python-Projects',
  'binfiles',
  'foundry-runs-stashed-2026-09-15'
);

const say = (s: string) => console.log(s);

// --- 1. Judge everything --------------------------------------------------

interface Row {
  id: string;
  channel: string;
  keep: boolean;
  isSource: boolean;
  story?: number;
  derivedFrom?: string;
  why: string;
}

const rows: Row[] = [];

for (const id of Run.list()) {
  const run = Run.open(id);
  const m = run.manifest;
  const channel = id.includes('/') ? id.split('/')[0]! : 'experiments';

  let sourceOnly = false;
  try {
    sourceOnly = Boolean(loadFormat(m.formatId).sourceOnly);
  } catch {
    /* format gone: judged below as ungateable */
  }
  const isSource = sourceOnly && m.story === undefined;

  let keep = false;
  let why = '';

  if (!run.hasArtifact('script')) {
    why = 'never got as far as a script';
  } else if (isSource) {
    // A SOURCE IS KEPT IF ANY OF ITS CUTS IS. It is never published, so its own
    // gate verdict is beside the point; what it is for is being the provenance
    // of the shorts and the thing you re-cut from.
    keep = true;
    why = 'source script, kept while its shorts are';
  } else if (!run.hasArtifact('qa')) {
    why = 'no gate report: never rendered';
  } else {
    const fresh = regate(run, run.readArtifact('script', scriptSchema));
    if (!fresh) why = 'cannot be gated under current checks';
    else if (fresh.passed) {
      keep = true;
      why = 'passes today';
    } else {
      why = fresh.findings
        .filter((f) => f.blocking)
        .map((f) => f.check)
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(', ');
    }
  }

  rows.push({ id, channel, keep, isSource, story: m.story, derivedFrom: m.derivedFrom, why });
}

// A source with no surviving cuts is not worth keeping either.
for (const row of rows.filter((r) => r.isSource)) {
  const cuts = rows.filter((r) => r.derivedFrom === row.id);
  if (cuts.length > 0 && !cuts.some((c) => c.keep)) {
    row.keep = false;
    row.why = 'source script, and none of its shorts survived';
  }
}

const keeping = rows.filter((r) => r.keep);
const stashing = rows.filter((r) => !r.keep);

say(`\n${DRY ? 'DRY RUN' : 'RUNNING'} - ${rows.length} runs\n`);
say(`KEEP (${keeping.length}):`);
for (const r of keeping) say(`  ${r.id.split('/').pop()!.padEnd(54)} ${r.why}`);
say(`\nSTASH (${stashing.length}):`);
for (const r of stashing) say(`  ${r.id.split('/').pop()!.padEnd(54)} ${r.why}`);

// --- 2. Work out the new names --------------------------------------------

/** Everything after the `eNNN` or `eNNN-sNN` prefix: date and slug. */
const tailOf = (id: string): string => {
  const name = id.split('/').pop()!;
  const m = /^e\d+(?:-s\d+)?-(.*)$/.exec(name);
  return m ? m[1]! : name;
};

const renames = new Map<string, string>();
const numbers = new Map<string, { episode: number; short?: number }>();

for (const channel of [...new Set(keeping.map((r) => r.channel))]) {
  if (channel === 'experiments') continue;

  const mine = keeping.filter((r) => r.channel === channel);
  const sources = mine.filter((r) => r.isSource).sort((a, b) => a.id.localeCompare(b.id));
  const loose = mine.filter((r) => !r.isSource && !r.derivedFrom);

  // Episodes and sources share one numbering, in the order they were made.
  const episodes = [...sources, ...loose].sort((a, b) => a.id.localeCompare(b.id));

  episodes.forEach((ep, i) => {
    const n = i + 1;
    const to = `${channel}/e${String(n).padStart(3, '0')}-${tailOf(ep.id)}`;
    renames.set(ep.id, to);
    numbers.set(ep.id, { episode: n });

    // Its surviving cuts, renumbered in story order so the gaps close up.
    const cuts = keeping
      .filter((r) => r.derivedFrom === ep.id)
      .sort((a, b) => (a.story ?? 0) - (b.story ?? 0));

    cuts.forEach((cut, j) => {
      const s = j + 1;
      const cutTo = `${channel}/e${String(n).padStart(3, '0')}-s${String(s).padStart(2, '0')}-${tailOf(cut.id)}`;
      renames.set(cut.id, cutTo);
      numbers.set(cut.id, { episode: n, short: s });
    });
  });
}

say(`\nRENAME (${[...renames].filter(([a, b]) => a !== b).length}):`);
for (const [from, to] of renames) {
  if (from !== to) say(`  ${from.split('/').pop()!.padEnd(54)} -> ${to.split('/').pop()}`);
}

if (DRY) {
  say('\nNothing moved. Re-run with --go.');
  process.exit(0);
}

// --- 3. Stash ---------------------------------------------------------------

fs.mkdirSync(STASH, { recursive: true });

for (const row of stashing) {
  const from = path.join(RUNS, ...row.id.split('/'));
  const to = path.join(STASH, ...row.id.split('/'));
  if (!fs.existsSync(from)) continue;

  fs.mkdirSync(path.dirname(to), { recursive: true });

  // COPY THEN REMOVE, NOT RENAME. Windows refuses to rename a directory while
  // anything holds a handle inside it, and something always does - a virus
  // scanner working through freshly written audio is enough. A copy is slower
  // and does not care, and a failure part way through leaves the original
  // where it was rather than half moved.
  fs.cpSync(from, to, { recursive: true });
  fs.rmSync(from, { recursive: true, force: true });
  say(`  stashed ${row.id}`);
}

// A note beside them, because a folder of run directories in six months is a
// mystery without one.
fs.writeFileSync(
  path.join(STASH, 'WHY.md'),
  [
    '# Stashed runs',
    '',
    'Moved out of AudioVibe-Foundry/runs on 2026-09-15. Nothing here was deleted.',
    '',
    'Every one of these fails its gate under the checks as they stand today.',
    'They were made by earlier versions of the pipeline, before:',
    '',
    '- quote-location failures were fed to repair as `unsourced` and dropped',
    '  before the writer, so fabricated quotes reached the script;',
    '- claims were retyped at extraction, so findings filed as statistics were',
    '  rejected for stating no number;',
    "- a show's minimum source tier was applied ahead of the writer, so episodes",
    '  were written around sources the show will not stand behind;',
    '- a cut carried its source’s disconfirming searches, so contested claims',
    '  reported as unchecked;',
    '- self-similarity stopped comparing a story to its own siblings.',
    '',
    'Their faults are baked into the artifacts on disk, so re-gating them is free',
    'and fixing them is not. The audio and ledgers are intact if any turn out to',
    'be worth moving back.',
    '',
    '| run | why |',
    '| --- | --- |',
    ...stashing.map((r) => `| \`${r.id}\` | ${r.why} |`),
    '',
  ].join('\n'),
  'utf8'
);

// --- 4. Renumber ------------------------------------------------------------

// Sources before their cuts, so a cut's `derivedFrom` is rewritten to a name
// that already exists.
const ordered = [...renames.keys()].sort((a, b) => {
  const ra = rows.find((r) => r.id === a)!;
  const rb = rows.find((r) => r.id === b)!;
  return Number(Boolean(ra.derivedFrom)) - Number(Boolean(rb.derivedFrom));
});

for (const from of ordered) {
  const to = renames.get(from)!;
  const fromDir = path.join(RUNS, ...from.split('/'));
  const toDir = path.join(RUNS, ...to.split('/'));

  if (from !== to) {
    if (!fs.existsSync(fromDir)) continue;
    fs.renameSync(fromDir, toDir);
  }

  const file = path.join(toDir, 'run.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const n = numbers.get(from)!;

  manifest.episode = n.episode;
  if (n.short !== undefined) manifest.short = n.short;
  if (typeof manifest.derivedFrom === 'string') {
    manifest.derivedFrom = renames.get(manifest.derivedFrom) ?? manifest.derivedFrom;
  }

  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

say(`\nStashed ${stashing.length} to ${STASH}`);
say(`Renumbered ${renames.size} survivors.`);
