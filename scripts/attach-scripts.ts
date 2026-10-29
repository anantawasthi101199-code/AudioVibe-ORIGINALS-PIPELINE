/**
 * Hand-written scripts for content map items: see what is next, then check a
 * batch and attach it (owner, 2026-10-15). The writing brief is the
 * `foundry-scripts` Claude skill; this is the mechanical half.
 *
 *   npx ts-node --transpile-only scripts/attach-scripts.ts next <mapId> [count]
 *       the next items on that map with no script yet, and what they must fit
 *   npx ts-node --transpile-only scripts/attach-scripts.ts check <batch.txt>
 *   npx ts-node --transpile-only scripts/attach-scripts.ts write <batch.txt>
 *
 * A batch is entries like this, any maps mixed:
 *
 *   === business-shorts/41 | heinz | Heinz: The Ketchup That Promised Purity | One-line description.
 *   ## story
 *   ...one paragraph per turn, blank lines between...
 *
 * CHECKED WITH THE STUDIO'S OWN RULES, so a batch that passes here seeds:
 * the format's parts (fillBlank), its length ceiling, the title cap, the
 * channel's never-tags and forbidden phrases, and no long dashes. `write` puts
 * each script next to that map's others and records it on the map item; the
 * next deploy turns each into a held run (seedMaps).
 */
import fs from 'fs';
import path from 'path';
import { loadPersona } from '../src/canon/load';
import { repoRoot } from '../src/config';
import { loadFormat } from '../src/formats/load';
import { blankScript, fillBlank } from '../src/pipeline/handwritten';
import { WORDS_PER_SECOND } from '../src/script/write';
import { TITLE_MAX } from '../src/script/titleRule';
import { topicFor } from '../src/server/maps';

type Item = { number: number; title: string; covers: string; source: string; subject?: string; script?: { file: string; title: string; description: string } };
type MapFile = { id: string; channelId: string; formatId: string; series?: { title: string; episodes: Item[] }[]; shorts?: Item[] };

const mapPath = (id: string) => path.join(repoRoot(), 'maps', `${id}.json`);
const readMap = (id: string): MapFile => JSON.parse(fs.readFileSync(mapPath(id), 'utf8'));
const itemsOf = (m: MapFile): Item[] => m.shorts ?? (m.series ?? []).flatMap((s) => s.episodes);
const ceilingWords = (m: MapFile) => Math.floor(loadFormat(m.formatId).targetSeconds[1] * WORDS_PER_SECOND);

/** Where this map's scripts live: beside the ones it already has. */
const dirFor = (m: MapFile): string => {
  const has = itemsOf(m).find((i) => i.script);
  if (has) return path.posix.dirname(has.script!.file);
  // A new map: a folder named after it, beside this channel's other scripts.
  const folder = m.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const sibling = fs
    .readdirSync(path.join(repoRoot(), 'maps'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => readMap(f.replace(/\.json$/, '')))
    .filter((o) => o.channelId === m.channelId)
    .flatMap(itemsOf)
    .find((i) => i.script);
  if (sibling) return `${path.posix.dirname(path.posix.dirname(sibling.script!.file))}/${folder}`;
  // A channel's first map: CONTENT/<Channel-Name>/Scripts/<map title>, like the others.
  const channel = loadPersona(m.channelId).name.replace(/^The /, '').replace(/[^A-Za-z0-9]+/g, '-');
  return `CONTENT/${channel}/Scripts/${folder}`;
};

const next = (mapId: string, count: number) => {
  const m = readMap(mapId);
  const f = loadFormat(m.formatId);
  console.log(`${mapId}: format ${f.id} (${f.kind}), parts: ${f.beats.map((b) => b.id).join(', ')}`);
  console.log(`ceiling ${f.targetSeconds[1]}s = at most ${ceilingWords(m)} words, tags included; files go in ${dirFor(m)}/`);
  const series = new Map(itemsOf(m).map((i) => [i.number, m.series?.find((s) => s.episodes.includes(i))?.title]));
  for (const i of itemsOf(m).filter((x) => !x.script).slice(0, count)) {
    console.log(`\n${mapId}/${i.number}${series.get(i.number) ? `  [series: ${series.get(i.number)}]` : ''}`);
    console.log(`  title:   ${i.title}\n  covers:  ${i.covers}\n  source:  ${i.source}${i.subject ? `\n  subject: ${i.subject}` : ''}`);
  }
};

interface Entry { key: string; slug: string; title: string; description: string; body: string }

const parse = (file: string): Entry[] =>
  fs
    .readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .split(/^=== /m)
    .slice(1)
    .map((raw) => {
      const [head, ...rest] = raw.split('\n');
      const [key, slug, title, description] = head!.split('|').map((x) => x.trim());
      return { key: key!, slug: slug!, title: title!, description: description!, body: rest.join('\n').trim() + '\n' };
    });

const run = (file: string, write: boolean) => {
  const entries = parse(file);
  let failed = 0;
  for (const e of entries) {
    const problems: string[] = [];
    const warnings: string[] = [];
    const [mapId, num] = e.key.split('/');
    const m = readMap(mapId!);
    const item = itemsOf(m).find((i) => i.number === Number(num));
    if (!item) problems.push('no such map item');
    if (!e.slug || !e.description) problems.push('header needs key | slug | title | description');
    if (e.title.length > TITLE_MAX) problems.push(`title is ${e.title.length} characters, max ${TITLE_MAX}`);
    const persona = loadPersona(m.channelId);
    if (item) {
      try {
        fillBlank(blankScript(persona, loadFormat(m.formatId), topicFor(item as never)), e.body, e);
      } catch (err) {
        problems.push((err as Error).message);
      }
    }
    const words = e.body.replace(/^##.*$/gm, '').split(/\s+/).filter(Boolean).length;
    if (words > ceilingWords(m)) problems.push(`${words} words, ceiling ${ceilingWords(m)}`);
    const whole = `${e.title} ${e.description} ${e.body}`;
    if (/[–—]/.test(whole)) problems.push('long dash');
    const tags = [...e.body.matchAll(/\[([^\]]+)\]/g)].map((x) => x[1]!.toLowerCase());
    for (const t of tags) for (const n of persona.audioTags?.never ?? []) if (new RegExp(`\\b${n}\\b`, 'i').test(t)) problems.push(`never-tag [${t}]`);
    for (const f of persona.styleCard.forbiddenPhrases) if (whole.toLowerCase().includes(f.toLowerCase())) problems.push(`forbidden "${f}"`);
    const negs = (e.body.match(/\bnot\b[^.]{0,60}\bnot\b[^.]{0,60}\bbut\b/gi) ?? []).length;
    if (negs) warnings.push(`${negs} "not x, not y, but z"`);
    console.log(`${e.key.padEnd(26)} ${String(words).padStart(4)}w ${String(tags.length).padStart(3)} tags  ${[...problems, ...warnings].join('; ')}`);
    if (problems.length) failed++;
  }
  if (failed) {
    console.log(`\n${failed} of ${entries.length} failed; nothing written`);
    process.exit(1);
  }
  if (!write) return console.log(`\nall ${entries.length} pass; run "write" to attach them`);

  const touched = new Map<string, MapFile>();
  for (const e of entries) {
    const mapId = e.key.split('/')[0]!;
    const m = touched.get(mapId) ?? readMap(mapId);
    touched.set(mapId, m);
    const num = Number(e.key.split('/')[1]);
    const rel = `${dirFor(m)}/${String(num).padStart(m.shorts ? 3 : 2, '0')}-${e.slug}.txt`;
    fs.mkdirSync(path.join(repoRoot(), path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(repoRoot(), rel), e.body);
    itemsOf(m).find((i) => i.number === num)!.script = { file: rel, title: e.title, description: e.description };
  }
  for (const [id, m] of touched) fs.writeFileSync(mapPath(id), JSON.stringify(m, null, 2) + '\n');
  console.log(`\nwrote ${entries.length}; now run: npx jest src/pipeline/__tests__/prepared.test.ts`);
};

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'next' && a) next(a, Number(b ?? 5));
else if ((cmd === 'check' || cmd === 'write') && a) run(a, cmd === 'write');
else {
  console.log('usage: attach-scripts.ts next <mapId> [count] | check <batch.txt> | write <batch.txt>');
  process.exit(1);
}
