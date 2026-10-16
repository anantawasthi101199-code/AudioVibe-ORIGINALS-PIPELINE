/**
 * Every name in a map's scripts that the channel has no pronunciation for
 * (owner, 2026-10-16: "make sure the pronunciation thing is continued across
 * shorts and episodes later as well"). FREE: reads files, calls nothing.
 *
 *   npx ts-node --transpile-only scripts/pronunciation-audit.ts <mapId> [fromNumber] [toNumber]
 *
 * Lists each capitalised word that is not covered by an entry (alone or inside
 * a multi-word one) and never appears in lower case in the scripts checked,
 * with the items it is in. What is left is either ordinary English, which
 * needs nothing, or a name that needs a `word / sayAs / ipa` entry in
 * voice-master.yaml before anything is voiced. Exits 1 when anything is listed,
 * so a writer cannot miss it.
 */
import fs from 'fs';
import path from 'path';
import { loadPersona } from '../src/canon/load';
import { repoRoot } from '../src/config';
import { loadAllMaps } from '../src/server/maps';

const [mapId, from, to] = process.argv.slice(2);
const map = loadAllMaps().find((m) => m.id === mapId);
if (!map) {
  console.log('usage: pronunciation-audit.ts <mapId> [fromNumber] [toNumber]');
  process.exit(2);
}
const lo = Number(from ?? 1);
const hi = Number(to ?? Infinity);

const covered = new Set(loadPersona(map.channelId).hosts[0]!.voice.pronounce.flatMap((p) => [p.word, ...p.word.split(/\s+/)]));
const items = map.series.flatMap((s) => s.episodes).filter((e) => e.script && e.number >= lo && e.number <= hi);
const spoken = (file: string) =>
  fs
    .readFileSync(path.join(repoRoot(), file), 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('===') && !l.startsWith('##'))
    .join('\n')
    .replace(/\[[^\]]*\]/g, ' ');
const texts = items.map((e) => ({ n: e.number, text: spoken(e.script!.file) }));
// ORDINARY ENGLISH is any word some script in the repo writes in lower case,
// so a sentence-start "If" or "Once" is never listed. "I" and "A" likewise.
const corpus = loadAllMaps().flatMap((m) => m.series.flatMap((s) => s.episodes)).filter((e) => e.script);
const lower = new Set(['i', 'a', ...corpus.flatMap((e) => spoken(e.script!.file).match(/\b[a-z][a-z'-]*\b/g) ?? [])]);

const missing = new Map<string, number[]>();
for (const { n, text } of texts) {
  for (const raw of text.match(/(?<![\p{L}'])\p{Lu}[\p{L}'-]*/gu) ?? []) {
    const word = raw.replace(/'s$|'$/, '');
    if (covered.has(word) || covered.has(raw) || lower.has(word.toLowerCase())) continue;
    missing.set(word, [...new Set([...(missing.get(word) ?? []), n])]);
  }
}

console.log(`${map.id}: ${items.length} scripts checked, ${missing.size} words with no entry`);
for (const [word, ns] of [...missing].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${word.padEnd(22)} ${ns.join(', ')}`);
}
process.exit(missing.size ? 1 : 0);
