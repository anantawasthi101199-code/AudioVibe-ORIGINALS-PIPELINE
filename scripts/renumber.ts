/**
 * One-off (2026-10-05): give existing runs the new names. A channel's shorts
 * become s001, s002 and its episodes e001, e002, each in the order they were
 * made. Shorts cut from an episode (e001-s01) are left alone.
 *
 *   npx ts-node --transpile-only scripts/renumber.ts          show the plan
 *   npx ts-node --transpile-only scripts/renumber.ts --apply  do it
 *
 * EVERY REFERENCE MOVES WITH THE FOLDER: the run's own record (id, number),
 * any run derived from it, the topic catalogue and the voice pins. An archived
 * run first records where its files are in R2, so playback still finds them.
 * Run it with nothing generating: the studio is restarted afterwards.
 */
import fs from 'fs';
import path from 'path';
import { loadFormat } from '../src/formats/load';
import { repoRoot, runsDir } from '../src/config';
import { readArchive, ARCHIVE_FILE } from '../src/archive/record';

const apply = process.argv.includes('--apply');
const root = path.resolve(runsDir());

const kindOf = (formatId: string): 'short' | 'long' => {
  try {
    return loadFormat(formatId).kind === 'short' ? 'short' : 'long';
  } catch {
    return 'long';
  }
};

const renames: Array<{ from: string; to: string }> = [];

for (const channel of fs.readdirSync(root).sort()) {
  const dir = path.join(root, channel);
  if (!fs.statSync(dir).isDirectory()) continue;

  const runs = fs
    .readdirSync(dir)
    .filter((f) => /^[es]\d{3}-/.test(f) && !/^e\d{3}-s\d{2}-/.test(f) && fs.existsSync(path.join(dir, f, 'run.json')))
    .map((f) => ({ folder: f, manifest: JSON.parse(fs.readFileSync(path.join(dir, f, 'run.json'), 'utf8')) }))
    .sort((a, b) => String(a.manifest.createdAt).localeCompare(String(b.manifest.createdAt)));

  const next = { short: 1, long: 1 };
  for (const { folder, manifest } of runs) {
    const kind = kindOf(manifest.formatId);
    const n = next[kind]++;
    const name = `${kind === 'short' ? 's' : 'e'}${String(n).padStart(3, '0')}${folder.slice(4)}`;
    if (name !== folder) renames.push({ from: `${channel}/${folder}`, to: `${channel}/${name}` });
  }
}

console.log(renames.length ? renames.map((r) => `  ${r.from}  ->  ${r.to}`).join('\n') : '  nothing to rename');
if (!apply) {
  console.log('\nPlan only. Run again with --apply to do it.');
  process.exit(0);
}

// Two passes through temporary names, so e002 -> e001 never lands on a folder
// that has not moved yet.
for (const r of renames) fs.renameSync(path.join(root, r.from), path.join(root, `${r.from}.renaming`));
for (const r of renames) {
  const target = path.join(root, r.to);
  if (fs.existsSync(target)) throw new Error(`${r.to} already exists; stopped`);
  fs.renameSync(path.join(root, `${r.from}.renaming`), target);
}

const swap = (text: string): string =>
  renames.reduce((t, r) => t.split(`"${r.from}"`).join(`"${r.to}"`), text);

for (const r of renames) {
  const dir = path.join(root, r.to);
  const file = path.join(dir, 'run.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.id = r.to;
  manifest.episode = Number(r.to.split('/')[1]!.slice(1, 4));
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));

  // Archived before the rename: its files stay at the old R2 path.
  const record = readArchive(dir);
  if (record && !record.prefix) {
    fs.writeFileSync(path.join(dir, ARCHIVE_FILE), JSON.stringify({ ...record, prefix: `runs/${r.from}` }, null, 2));
  }
}

// Anything else that names a run: other runs' records and the studio's files.
for (const channel of fs.readdirSync(root)) {
  const dir = path.join(root, channel);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    const file = path.join(dir, f, 'run.json');
    if (fs.existsSync(file)) fs.writeFileSync(file, swap(fs.readFileSync(file, 'utf8')));
  }
}
for (const name of ['catalogue.json', 'voices.json', 'series.json']) {
  const file = path.join(repoRoot(), name);
  if (fs.existsSync(file)) fs.writeFileSync(file, swap(fs.readFileSync(file, 'utf8')));
}
console.log(`\nRenamed ${renames.length}. Restart the studio.`);
