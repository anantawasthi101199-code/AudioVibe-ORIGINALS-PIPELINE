/**
 * Hear a channel's pronunciations before an episode is voiced (2026-10-15).
 * Voices one line three ways with the channel's real ElevenLabs voice: as
 * written, with the `sayAs` respellings, and with the `/IPA/` forms, into
 * voice-samples/pronunciation-test/. A few pence of ElevenLabs.
 *
 *   npx ts-node --transpile-only scripts/pronunciation-test.ts <channelId> "<line>"
 */
import fs from 'fs';
import path from 'path';
import { loadPersona } from '../src/canon/load';
import { repoRoot } from '../src/config';
import { buildTts } from '../src/deps';

const [channelId, line] = process.argv.slice(2);
if (!channelId || !line) {
  console.log('usage: pronunciation-test.ts <channelId> "<line to say>"');
  process.exit(1);
}

const main = async () => {
  const voice = loadPersona(channelId).hosts[0]!.voice;
  const tts = buildTts('elevenlabs');
  const out = path.join(repoRoot(), 'voice-samples', 'pronunciation-test');
  fs.mkdirSync(out, { recursive: true });
  const variants = {
    '1-as-written': { ...voice, pronounce: [] },
    '2-respelled': { ...voice, pronounce: voice.pronounce.map(({ ipa: _ipa, ...p }) => p) },
    '3-ipa': voice,
  };
  for (const [name, v] of Object.entries(variants)) {
    const r = await tts.synthesise({ text: line, voice: v as typeof voice });
    const file = path.join(out, `${channelId}-${name}.mp3`);
    fs.writeFileSync(file, r.audio);
    console.log(`${file} (${r.audio.length} bytes)`);
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
