import fs from 'fs';
import path from 'path';
import { loadPersona } from '../load';
import { loadVoiceMaster, parseVoiceMaster } from '../voiceMaster';
import { Voice } from '../schema';
import { forVoice } from '../../render/tts';
import { withOutro } from '../../script/outro';
import { tagGuidance } from '../../script/narration';
import { stripUnknownTags } from '../../script/dialogue';

const personasDir = path.resolve(__dirname, '..', '..', '..', 'personas');

describe('voice-master.yaml', () => {
  const master = loadVoiceMaster()!;

  it('covers exactly the launch channels, each with a real host', () => {
    const personas = fs.readdirSync(personasDir).map((f) => f.replace(/\.yaml$/, '')).sort();
    expect(Object.keys(master.channels).sort()).toEqual(personas);
    for (const id of personas) {
      const persona = loadPersona(id);
      const host = persona.hosts.find((h) => h.id === master.channels[id]!.host)!;
      expect(host.voice.draftVoiceId).toBe(master.channels[id]!.openai.voice);
      expect(host.voice.settings.stability).toBe(master.channels[id]!.elevenlabs.stability);
    }
  });

  it('keeps every GPT voice the channel has already published in (voices.json pins)', () => {
    const pins = JSON.parse(fs.readFileSync(path.resolve(personasDir, '..', 'voices.json'), 'utf8'));
    for (const [id, hosts] of Object.entries<Record<string, Record<string, { voiceId: string }>>>(pins)) {
      const entry = master.channels[id];
      if (!entry) continue;
      const pinned = hosts[entry.host]?.openai?.voiceId;
      if (pinned) expect(entry.openai.voice).toBe(pinned);
    }
  });

  it('refuses a misspelt field rather than ignoring it', () => {
    const bad = fs
      .readFileSync(path.resolve(personasDir, '..', 'voice-master.yaml'), 'utf8')
      .replace('stability: 0.4\n', 'stabilty: 0.4\n');
    expect(() => parseVoiceMaster(bad, 'bad')).toThrow(/stabilty|stability/);
  });
});

describe('fixed outros', () => {
  const persona = loadPersona('mythic-archives');
  const script = { beats: [{ turns: [{ speaker: 'narrator', text: 'And that is where the text stops.' }] }] };

  it('appends one outro, marked fixed, and never twice', () => {
    const once = withOutro(script, persona, 'long', 'Vetala');
    const twice = withOutro(once, persona, 'long', 'Vetala');
    expect(once.beats[0]!.turns).toHaveLength(2);
    expect(once.beats[0]!.turns[1]).toMatchObject({ speaker: 'narrator', fixed: true });
    expect(persona.signoff).toContain(once.beats[0]!.turns[1]!.text);
    expect(twice).toBe(once);
  });

  it('a kind with no outro is left alone (Global Thread makes no long episodes)', () => {
    expect(withOutro(script, loadPersona('global-thread'), 'long', 'x')).toBe(script);
  });
});

describe("each host's own voice tags", () => {
  it('reach the writer, and survive the strip that removes unknown tags', () => {
    const persona = loadPersona('crime-files');
    expect(tagGuidance(persona)).toContain('[low, steady]');
    expect(stripUnknownTags('[low, steady] It was late. [bananas] Cold.', persona.audioTags?.use)).toBe(
      '[low, steady] It was late.  Cold.'
    );
  });

  it('every outro says who is talking and on which channel', () => {
    for (const [id, entry] of Object.entries(loadVoiceMaster()!.channels)) {
      const persona = loadPersona(id);
      for (const outro of [...entry.outros.episode, ...entry.outros.short]) {
        expect(outro).toContain(entry.name);
        expect(outro.toLowerCase()).toContain(persona.name.toLowerCase().replace(/^the /, ''));
      }
    }
  });
});

describe('forVoice', () => {
  const voice = {
    pronounce: [{ word: 'Vetala', sayAs: 'vay-TAH-lah', ipa: '/veːˈtaːlə/' }],
    neverTags: ['laughs'],
  } as unknown as Voice;

  it('respells whole words only, and prefers IPA where asked', () => {
    expect(forVoice('The Vetala spoke. Vetalas too.', voice)).toBe('The vay-TAH-lah spoke. Vetalas too.');
    expect(forVoice('The Vetala spoke.', voice, { ipa: true })).toBe('The /veːˈtaːlə/ spoke.');
  });

  it('drops a tag the channel never uses, keeps the rest', () => {
    expect(forVoice('[laughs] No. [quietly] Yes.', voice, { neverTags: true })).toBe('No. [quietly] Yes.');
    expect(forVoice('[laughs] No.', voice)).toBe('[laughs] No.');
  });
});
