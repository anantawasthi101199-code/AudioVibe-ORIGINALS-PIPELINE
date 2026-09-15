/**
 * Make each manifest's `id` agree with the directory it sits in.
 *
 * A run's id is stored INSIDE run.json, not derived from its folder, so
 * renaming a directory leaves the run reporting its old name. Everything that
 * compares an id against Run.list() then silently fails to match - which showed
 * up as every short reporting a hundred percent vocabulary overlap with itself,
 * because the self-exclusion in the similarity check never fired.
 */
import fs from 'fs';
import path from 'path';

const RUNS = path.join(__dirname, '..', 'runs');
let fixed = 0;

for (const channel of fs.readdirSync(RUNS)) {
  const channelDir = path.join(RUNS, channel);
  if (!fs.statSync(channelDir).isDirectory()) continue;

  for (const folder of fs.readdirSync(channelDir)) {
    const file = path.join(channelDir, folder, 'run.json');
    if (!fs.existsSync(file)) continue;

    const id = `${channel}/${folder}`;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

    if (manifest.id === id) continue;

    console.log(`  ${String(manifest.id)}\n    -> ${id}`);
    manifest.id = id;
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fixed++;
  }
}

console.log(`\n${fixed} manifest id(s) corrected.`);
