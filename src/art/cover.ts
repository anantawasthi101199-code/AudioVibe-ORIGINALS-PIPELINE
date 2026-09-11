/**
 * Cover art, drawn rather than generated.
 *
 * WHY NOT AN IMAGE MODEL. It is the obvious answer and it is the wrong one for
 * this, for three reasons that all point the same way:
 *
 *   - A show's artwork has ONE job, which is to be recognised at 64 pixels in a
 *     scrolling feed. That is a typography problem, not an illustration
 *     problem. Generated illustration at that size is texture.
 *   - Episode covers that vary from week to week destroy the thing they are
 *     for. Every real audio network in existence uses one consistent frame with
 *     the episode's own text in it, and they do that because it works.
 *   - It costs nothing and it is deterministic. The same episode renders the
 *     same cover on any machine, forever, which means a re-publish never
 *     quietly changes the artwork of something already in someone's library.
 *
 * That last one is not a small thing. An image model would make cover art the
 * only stage of this pipeline whose output cannot be reproduced.
 *
 * WHAT IS ACTUALLY DRAWN. The show's wordmark, a field of its own colour, and
 * the episode's title set large. A serial adds its episode number, because on a
 * shelf that is the single most useful thing a cover can tell you.
 *
 * SQUARE FOR AUDIO, 16:9 FOR A SERIES. Those are the platform's frames and they
 * are not negotiable from here: art that does not match gets cropped on display,
 * which silently shaves off whatever was carefully placed at the edge. See the
 * app's theme/mediaRatios.ts, which is the authority.
 */
import fs from 'fs';
import path from 'path';
import { Resvg } from '@resvg/resvg-js';

/** The platform's frames. Width over height, matching theme/mediaRatios.ts. */
export const AUDIO_COVER_SIZE = { width: 1400, height: 1400 };
export const SERIES_COVER_SIZE = { width: 1920, height: 1080 };

export interface Palette {
  /** The field. Everything else is chosen to sit on it. */
  background: string;
  /** The title, and the strongest thing on the cover. */
  ink: string;
  /** The wordmark and the episode number. Quieter than the title on purpose. */
  accent: string;
}

/**
 * A show's palette, derived from its id.
 *
 * DERIVED RATHER THAN DECLARED, so a new show has usable artwork the moment it
 * has a name, and nobody has to pick hex codes to see whether an idea works. A
 * show that wants specific colours declares them in its persona and this is
 * never consulted.
 *
 * The hues are spaced around the wheel by hashing the id, and the lightness and
 * saturation are FIXED. That is what stops the generator producing an
 * unreadable cover: only the hue varies, so every show gets a dark field and
 * near-white text regardless of which hue it landed on.
 */
export const paletteFor = (showId: string): Palette => {
  let hash = 0;
  for (const ch of showId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;

  return {
    background: `hsl(${hue}, 34%, 13%)`,
    ink: `hsl(${hue}, 12%, 95%)`,
    accent: `hsl(${(hue + 28) % 360}, 62%, 62%)`,
  };
};

/**
 * XML-escape, because a title is arbitrary text going into markup.
 *
 * An episode called "Q&A" or one with a quotation mark in it would otherwise
 * produce an SVG that fails to parse, and it would fail at render time - after
 * the episode has been written, voiced and gated.
 */
export const escapeXml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * Break a title into lines that fit.
 *
 * Greedy, on an approximation of character width rather than real metrics. It
 * does not need to be exact: the cover has room for a line or two of slack, and
 * the alternative is measuring text, which means loading and parsing the font
 * here for a result nobody would be able to tell apart.
 *
 * Long single words are left alone rather than hyphenated. A title with a
 * forty-character word in it is a title problem.
 */
export const wrapTitle = (title: string, maxCharsPerLine: number, maxLines: number): string[] => {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  if (lines.length <= maxLines) return lines;

  // Truncate rather than let the block grow. A title long enough to need a
  // fifth line has stopped being a title, and the cover is not the place to
  // discover that.
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1]!.replace(/[\s,.;:]+$/, '')}...`;
  return kept;
};

/**
 * Roughly how wide a string sets, in multiples of the font size.
 *
 * An approximation, and it only has to be one: it decides whether a line would
 * overflow, and the consequence of being slightly wrong is a slightly larger
 * margin. Measuring properly means loading and parsing the font here, for a
 * result nobody could tell apart.
 *
 * The per-character factors matter more than the average does. A title in caps
 * or full of Ms sets far wider than the same character count of lowercase, and
 * an average would let exactly those titles run off the edge.
 */
export const approximateWidth = (text: string): number => {
  let em = 0;
  for (const ch of text) {
    if (/[ilIjt.,;:'!|]/.test(ch)) em += 0.3;
    else if (/[A-Z]/.test(ch)) em += 0.68;
    else if (/[mwMW]/.test(ch)) em += 0.9;
    else if (ch === ' ') em += 0.27;
    else em += 0.55;
  }
  return em;
};

/**
 * The largest size at which the longest line still fits, capped at `preferred`.
 *
 * FIXED SIZE FOR ANYTHING THAT FITS, which is almost everything, because a
 * cover set whose type size varies title by title stops looking like a set.
 * Shrinking is purely an overflow guard: without it a long title runs straight
 * off the right edge, which is what this did before anyone looked at a rendered
 * one. There is a floor, because type small enough to fit any title is type too
 * small to read in a feed - below it the title truncates instead.
 */
export const fitFontSize = (
  lines: string[],
  usableWidth: number,
  preferred: number,
  floorRatio = 0.72
): number => {
  const widest = Math.max(...lines.map(approximateWidth), 0.001);
  const fits = usableWidth / widest;
  return Math.round(Math.max(Math.min(preferred, fits), preferred * floorRatio));
};

export interface CoverInput {
  showName: string;
  title: string;
  palette: Palette;
  /** Set for a serial. Shown large, because on a shelf it is the useful fact. */
  episodeNumber?: number;
  /** A short says so, so a listener knows what they are getting into. */
  kind?: 'episode' | 'short';
}

/**
 * The cover as SVG.
 *
 * Exposed separately from rendering so it can be asserted on in tests without a
 * PNG decoder, and so a cover can be eyeballed in a browser while iterating.
 */
export const coverSvg = (
  input: CoverInput,
  size: { width: number; height: number }
): string => {
  const { width, height } = size;
  const p = input.palette;
  const margin = Math.round(width * 0.08);
  const landscape = width > height;

  // Fewer, larger characters on the square frame; the 16:9 series cover is
  // wider and read at a distance, so it takes a longer line. These are line
  // budgets in characters, deliberately conservative - fitFontSize below is
  // what actually guarantees the line fits, and this only decides where the
  // breaks fall.
  const maxChars = landscape ? 22 : 15;
  const maxLines = landscape ? 3 : 4;
  const lines = wrapTitle(input.title, maxChars, maxLines);

  const usableWidth = width - margin * 2;
  const titleSize = fitFontSize(lines, usableWidth, Math.round(height * (landscape ? 0.13 : 0.105)));
  const lineHeight = Math.round(titleSize * 1.16);
  const wordmarkSize = Math.round(height * 0.038);

  // The title block sits on the lower half and grows upward, so a one-line
  // title and a four-line title share the same baseline. Anchoring at the top
  // instead would make short titles float in the middle of the frame.
  const lastBaseline = height - margin - Math.round(height * (landscape ? 0.06 : 0.09));
  const firstBaseline = lastBaseline - lineHeight * (lines.length - 1);

  // A SERIES COVER SAYS THE SHOW'S NAME ONCE. Its title IS the show name, so
  // drawing the wordmark as well prints it twice with nothing else on the
  // frame, which reads as a mistake rather than as branding.
  const showWordmark = input.showName.trim().toLowerCase() !== input.title.trim().toLowerCase();

  const label =
    input.episodeNumber !== undefined
      ? `EPISODE ${input.episodeNumber}`
      : input.kind === 'short'
        ? 'SHORT'
        : '';

  const titleTspans = lines
    .map(
      (line, i) =>
        `<text x="${margin}" y="${firstBaseline + i * lineHeight}" ` +
        `font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="${titleSize}" ` +
        `font-weight="700" letter-spacing="-1.2" fill="${p.ink}">${escapeXml(line)}</text>`
    )
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${p.background}"/>
  <rect x="${margin}" y="${margin}" width="${Math.round(width * 0.09)}" height="${Math.round(height * 0.008)}" fill="${p.accent}"/>
  ${
    showWordmark
      ? `<text x="${margin}" y="${margin + Math.round(height * 0.075)}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="${wordmarkSize}" font-weight="600" letter-spacing="${Math.round(wordmarkSize * 0.18)}" fill="${p.accent}">${escapeXml(input.showName.toUpperCase())}</text>`
      : ''
  }
  ${titleTspans}
  ${
    label
      ? `<text x="${margin}" y="${height - margin}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="${wordmarkSize}" font-weight="600" letter-spacing="${Math.round(wordmarkSize * 0.14)}" fill="${p.accent}" opacity="0.85">${escapeXml(label)}</text>`
      : ''
  }
</svg>`;
};

/**
 * Render a cover to a PNG on disk, returning the path.
 *
 * resvg rather than an HTML renderer because it is a single native dependency
 * with no browser in it, and rather than a canvas library because those need
 * fonts registered by hand to draw text at all.
 */
export const renderCover = (
  input: CoverInput,
  outputPath: string,
  size = AUDIO_COVER_SIZE
): string => {
  const svg = coverSvg(input, size);
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: size.width },
    // System fonts, so a machine with none still renders rather than throwing.
    font: { loadSystemFonts: true, defaultFontFamily: 'Arial' },
  })
    .render()
    .asPng();

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, png);
  return outputPath;
};
