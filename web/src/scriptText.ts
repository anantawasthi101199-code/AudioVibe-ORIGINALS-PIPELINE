/**
 * The whole script as ONE box of text, and back (owner, 2026-10-09).
 *
 * Editing beat by beat is the default; this is the other way, for pasting a
 * script written somewhere else. Either one at a time, never both.
 *
 * THE FORMAT IS PLAIN TEXT. Each part starts with a line `## <part>` (the
 * beat id, as the box is filled in), and paragraphs inside a part are separated
 * by a blank line, exactly as in the beat editor.
 *
 * WITHOUT ANY `##` LINES the pasted text is shared out over the script's parts
 * in order, a paragraph at a time, in proportion to how long each part was, so
 * a script pasted from a document still lands in the shape the gate checks.
 *
 * THE CHANNEL'S OUTRO stays marked as the fixed outro when its words are pasted
 * back unchanged, as in the beat editor.
 */
import type { Beat, Turn } from './api';

const HEADER = /^##\s+(\S.*?)\s*$/;

export const toWhole = (beats: Beat[]): string =>
  beats.map((b) => `## ${b.beatId}\n\n${b.turns.map((t) => t.text).join('\n\n')}`).join('\n\n');

const paragraphs = (text: string): string[] =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

/** Turns for one part, in its first speaker's voice, outro kept fixed. */
const turnsFor = (original: Beat, paras: string[], fixedTexts: Set<string>): Turn[] => {
  const speaker = original.turns[0]?.speaker ?? 'narrator';
  return paras.map((text) => ({ speaker, text, ...(fixedTexts.has(text) ? { fixed: true } : {}) }));
};

export type WholeResult = { ok: true; beats: Beat[] } | { ok: false; error: string };

export const fromWhole = (text: string, original: Beat[]): WholeResult => {
  const fixedTexts = new Set(original.flatMap((b) => b.turns.filter((t) => t.fixed).map((t) => t.text)));
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const hasHeaders = lines.some((l) => HEADER.test(l));

  if (hasHeaders) {
    const sections = new Map<string, string[]>();
    let current: string | null = null;
    const before: string[] = [];
    for (const line of lines) {
      const m = HEADER.exec(line);
      if (m) {
        current = m[1]!;
        if (sections.has(current)) return { ok: false, error: `the part "${current}" appears twice` };
        sections.set(current, []);
      } else if (current) sections.get(current)!.push(line);
      else before.push(line);
    }
    if (paragraphs(before.join('\n')).length) {
      return { ok: false, error: `there is text before the first "## part" line; put it under a part` };
    }
    const known = new Set(original.map((b) => b.beatId));
    const unknown = [...sections.keys()].filter((k) => !known.has(k));
    if (unknown.length) {
      return {
        ok: false,
        error: `unknown part${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. The parts are: ${[...known].join(', ')}`,
      };
    }
    const beats: Beat[] = [];
    for (const b of original) {
      const paras = paragraphs((sections.get(b.beatId) ?? []).join('\n'));
      if (!paras.length) return { ok: false, error: `the part "${b.beatId}" has no text` };
      beats.push({ ...b, turns: turnsFor(b, paras, fixedTexts) });
    }
    return { ok: true, beats };
  }

  // NO PARTS MARKED: share the paragraphs out in order, by each part's old length.
  const paras = paragraphs(text);
  if (paras.length < original.length) {
    return {
      ok: false,
      error: `that is ${paras.length} paragraph${paras.length === 1 ? '' : 's'} for ${original.length} parts. Add a "## part" line before each part, or more paragraphs`,
    };
  }
  const weights = original.map((b) => Math.max(1, b.turns.reduce((n, t) => n + t.text.length, 0)));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const totalChars = paras.reduce((n, p) => n + p.length, 0);

  const beats: Beat[] = [];
  let i = 0;
  let used = 0;
  let wanted = 0;
  original.forEach((b, k) => {
    const partsLeft = original.length - k - 1;
    wanted += (weights[k]! / totalWeight) * totalChars;
    const mine: string[] = [];
    // At least one paragraph each, and leave one for every part still to come.
    while (i < paras.length - partsLeft && (mine.length === 0 || used + paras[i]!.length / 2 <= wanted || k === original.length - 1)) {
      used += paras[i]!.length;
      mine.push(paras[i]!);
      i++;
    }
    beats.push({ ...b, turns: turnsFor(b, mine, fixedTexts) });
  });
  return { ok: true, beats };
};
