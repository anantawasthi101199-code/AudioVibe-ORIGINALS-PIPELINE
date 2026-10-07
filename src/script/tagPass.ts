/**
 * The optional tag pass: one cheap model call that ADDS ElevenLabs audio tags
 * to an approved script, and is not allowed to change a single word.
 *
 * WHY IT IS OPTIONAL. The owner's choice (2026-10-07): either voice the script
 * exactly as written, including any [tags] typed into it by hand, or run this
 * once before rendering. Off by default; only offered for ElevenLabs.
 *
 * WHY A CHEAP MODEL IS ALLOWED HERE. The clerk rule (config/index.ts): a cheap
 * model may only do work whose output is checked by something that is not a
 * model. Every line it returns is compared word for word with the original,
 * case and punctuation aside, and a line that differs is thrown away and the
 * original kept. It can add delivery; it cannot edit the script.
 *
 * The prompt follows ElevenLabs' own "Enhance" prompt for v4 (best-practices,
 * "Enhancing input"), narrowed to one narrator, to this channel's delivery
 * guide, and to the tags that suit its voice.
 */
import { ChannelVoice } from '../canon/voiceMaster';
import { completeJson, LlmClient } from '../models/client';
import { Script } from './write';

/** Words in order, with tags, case and punctuation set aside. */
export const wordsOf = (text: string): string[] =>
  text
    .replace(/\[[^\]]*\]/g, ' ')
    .toLowerCase()
    // Curly and straight apostrophes are the same mark: a script says "night’s"
    // and the model hands back "night's", which is not a changed word.
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]+/gu, ' ')
    .replace(/'/g, '')
    .split(/\s+/)
    .filter(Boolean);

const sameWords = (a: string, b: string): boolean => wordsOf(a).join(' ') === wordsOf(b).join(' ');

/** Keep only tags from the channel's list; anything else the model invented is removed. */
const onlyAllowedTags = (text: string, allowed: string[]): string => {
  const ok = new Set(allowed.map((t) => t.toLowerCase()));
  return text
    .replace(/\[([^\]]{1,48})\]\s*/g, (tag, inner: string) => (ok.has(inner.trim().toLowerCase()) ? tag : ''))
    .replace(/[ \t]+/g, ' ')
    .trim();
};

export const tagPassSystem = (channel: ChannelVoice): string =>
  [
    'You enhance a narration script for ElevenLabs Eleven v4 speech by adding audio tags. ' +
      'Your PRIMARY GOAL is expressive, natural delivery while STRICTLY preserving the original text.',
    '',
    `THE NARRATOR: ${channel.name}. ${channel.personality}`,
    '',
    `HOW THEY SOUND: ${channel.delivery}`,
    '',
    `THE ONLY TAGS YOU MAY USE: ${channel.tags.use.map((t) => `[${t}]`).join(' ')}`,
    channel.tags.never.length
      ? `NEVER USE: ${channel.tags.never.map((t) => `[${t}]`).join(' ')}. They break this voice.`
      : '',
    '',
    'RULES:',
    '- DO NOT add, remove, reorder or change ANY word. You only insert tags in square brackets.',
    '- You MAY add emphasis without changing words: CAPITALS on one word that carries the line, ' +
      'an ellipsis (...) for a weighted pause, or a dash for a short one. Sparingly.',
    '- Place a tag immediately before the words it affects. A tag carries on until the next one, ' +
      'so do not repeat the same tag.',
    '- Tags describe this one voice only: never sound effects, music, accents or other people.',
    '- Use them only where the delivery genuinely changes: about one tag every three or four ' +
      'sentences, and never more than one per sentence. Most sentences get none. ' +
      'A tag on every line is a tag on nothing.',
    '- Keep tags that are already in the text exactly where they are.',
    '- Match the delivery guide above. Never perform an emotion the words have not earned.',
    '',
    'Return JSON only: {"lines": [{"i": <number>, "text": "<the line with tags added>"}]}, ' +
      'one entry for every line you were given, same i.',
  ]
    .filter((l) => l !== '')
    .join('\n');

export interface TagPassResult {
  script: Script;
  tagged: number;
  rejected: number;
  unchanged: number;
}

/**
 * Tag every writer line of the script in ONE call. Fixed lines (the outro) are
 * not sent: they are said exactly as written.
 */
export const tagPass = async (
  script: Script,
  channel: ChannelVoice,
  client: LlmClient,
  onCost?: (pence: number) => void
): Promise<TagPassResult> => {
  const lines: Array<{ i: number; beat: number; turn: number; text: string }> = [];
  script.beats.forEach((b, beat) =>
    b.turns.forEach((t, turn) => {
      if (!t.fixed) lines.push({ i: lines.length, beat, turn, text: t.text });
    })
  );
  if (!lines.length) return { script, tagged: 0, rejected: 0, unchanged: 0 };

  const reply = await completeJson<{ lines: Array<{ i: number; text: string }> }>(
    client,
    {
      system: tagPassSystem(channel),
      prompt: JSON.stringify({ lines: lines.map(({ i, text }) => ({ i, text })) }),
      // Roughly the script back plus tags. Generous so a long episode is not cut off.
      maxTokens: Math.min(32000, Math.ceil(lines.reduce((n, l) => n + l.text.length, 0) / 2.5) + 2000),
      temperature: 0.4,
      cacheSystem: false,
    },
    onCost
  );

  const back = new Map((reply.lines ?? []).map((l) => [l.i, l.text]));
  let tagged = 0;
  let rejected = 0;
  let unchanged = 0;

  const beats = script.beats.map((b) => ({ ...b, turns: b.turns.map((t) => ({ ...t })) }));
  for (const line of lines) {
    const proposed = back.get(line.i);
    if (typeof proposed !== 'string') {
      unchanged += 1;
      continue;
    }
    const cleaned = onlyAllowedTags(proposed, [...channel.tags.use, ...existingTags(line.text)]);
    if (!sameWords(cleaned, line.text)) {
      rejected += 1;
      continue;
    }
    if (cleaned === line.text) {
      unchanged += 1;
      continue;
    }
    beats[line.beat]!.turns[line.turn]!.text = cleaned;
    tagged += 1;
  }

  return { script: { ...script, beats }, tagged, rejected, unchanged };
};

/** Tags a person typed by hand stay, even if they are not on the channel's list. */
const existingTags = (text: string): string[] =>
  [...text.matchAll(/\[([^\]]{1,48})\]/g)].map((m) => m[1]!.trim());
