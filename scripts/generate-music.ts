/**
 * Generate background loops from music-briefs.yaml on ElevenLabs.
 *
 *   npx ts-node -T scripts/generate-music.ts --only crime-files-short-a
 *
 * --engine music  Eleven Music (/v1/music, force_instrumental), the default
 * --engine sfx    Sound Effects with loop:true (/v1/sound-generation), max 30s
 * --seconds N     clip length; default 15 for shorts, 20 for episodes (they loop)
 * --dry-run       print what would be made, spend nothing
 *
 * Every file is kept, never overwritten: music/generated/<channel>/
 * <seq>-<date>-<brief>-<engine>.mp3, and one line per file in
 * music/generated/log.jsonl with the prompt. The studio plays the picked copy
 * of each slot, channel-music/<brief id>.mp3 (committed, ships in the image).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const root = path.resolve(__dirname, '..');
const outRoot = path.join(process.env.FOUNDRY_MUSIC_DIR ?? path.join(root, 'music'), 'generated');
const logFile = path.join(outRoot, 'log.jsonl');
const key = process.env.ELEVENLABS_API_KEY?.trim();

interface Brief {
  id: string;
  channel: string;
  kind: 'short' | 'long';
  prompt: string;
}
const doc = YAML.parse(fs.readFileSync(path.join(root, 'music-briefs.yaml'), 'utf8')) as {
  rules: string;
  longRules: string;
  briefs: Brief[];
};
const only = arg('only')?.split(',');
const briefs = doc.briefs.filter((b) => !only || only.includes(b.id));
const engines = arg('engine') === 'both' ? ['music', 'sfx'] : [arg('engine') ?? 'music'];
const secondsFor = (b: Brief) => Number(arg('seconds') ?? (b.kind === 'long' ? 20 : 15));
const dry = process.argv.includes('--dry-run');

const credits = async (): Promise<number> => {
  const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': key! } });
  return ((await r.json()) as { character_count: number }).character_count;
};

const generate = async (engine: string, text: string, seconds: number): Promise<Buffer> => {
  const [url, body] =
    engine === 'music'
      ? [
          'https://api.elevenlabs.io/v1/music?output_format=mp3_48000_192',
          { prompt: text, music_length_ms: seconds * 1000, force_instrumental: true, model_id: arg('model') ?? 'music_v2_5' },
        ]
      : [
          'https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_48000_192',
          { text, duration_seconds: Math.min(seconds, 30), loop: true, prompt_influence: 0.6, model_id: 'eleven_text_to_sound_v2' },
        ];
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': key!, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${engine} ${r.status}: ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
};

const main = async () => {
  if (!key) throw new Error('ELEVENLABS_API_KEY is empty');
  if (!briefs.length) throw new Error(`no brief matches --only ${only}`);
  fs.mkdirSync(outRoot, { recursive: true });
  // The highest number in the log, so files keep counting up across runs.
  // ponytail: two runs at once can still share a number; run one at a time.
  let seq = fs.existsSync(logFile)
    ? Math.max(0, ...fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).seq as number))
    : 0;
  for (const b of briefs) {
    for (const engine of engines) {
      const seconds = secondsFor(b);
      const rules = b.kind === 'long' ? `${doc.rules.trim()} ${doc.longRules.trim()}` : doc.rules.trim();
      // The SFX model takes a short description, so it gets the brief without the long rules.
      const text = engine === 'music' ? `${b.prompt.trim()} ${rules}` : `${b.prompt.trim()} Instrumental seamless loop, no vocals.`;
      if (dry) {
        console.log(`would make ${b.id} on ${engine}, ${seconds}s`);
        continue;
      }
      const before = await credits();
      const audio = await generate(engine, text, seconds);
      const used = (await credits()) - before;
      seq += 1;
      const date = new Date().toISOString().slice(0, 10);
      const file = path.join(outRoot, b.channel, `${String(seq).padStart(3, '0')}-${date}-${b.id}-${engine}.mp3`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, audio);
      const entry = { seq, at: new Date().toISOString(), brief: b.id, channel: b.channel, kind: b.kind, engine, seconds, credits: used, file: path.relative(outRoot, file), prompt: text };
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
      console.log(`${entry.file}  ${seconds}s`);
    }
  }
};

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
