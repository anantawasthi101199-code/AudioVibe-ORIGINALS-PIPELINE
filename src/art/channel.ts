/**
 * A channel's own two images: the mark people recognise, and its banner.
 *
 * WHY NOT art/cover.ts. That renderer draws an EPISODE cover, and its layout is
 * right for one: a quiet wordmark at the top left, the episode's title set
 * large across the bottom. Reused for channel art it produces two specific
 * failures, both of which shipped:
 *
 * THE AVATAR CAME OUT BLANK. An avatar has no episode title, so the renderer
 * drew the show name small in the top corner of a 1024px square and left the
 * other ninety per cent empty. At the 64 pixels an avatar is actually seen at,
 * that is a plain coloured square. The comment explaining the decision said the
 * name would be unreadable at that size and the app prints it beside the avatar
 * anyway - both true, and the conclusion drawn from them was to draw nothing.
 *
 * THE BANNER PUT ITS NAME UNDER THE AVATAR. The episode layout sets the title
 * along the bottom left, which is exactly where the app overlays the profile
 * picture and handle. The prompt written for the GENERATED banner says to keep
 * the lower left clear; the drawn fallback knew nothing about it.
 *
 * SO: an avatar is a monogram, centred, big enough to survive being small. A
 * banner keeps everything in its upper two thirds and leaves the lower left
 * alone.
 */
import fs from 'fs';
import path from 'path';
import { Resvg } from '@resvg/resvg-js';
import { Palette, escapeXml } from './cover';

/**
 * The letters on the mark.
 *
 * Initials of the first two words, because that is what a monogram is and
 * because two letters fill a circle at any size. "Honest Health" is HH; a
 * one-word show gets its first two letters rather than one, which would read as
 * a bullet point rather than a mark.
 */
export const monogramFor = (name: string): string => {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return '??';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
};

export interface ChannelArtInput {
  name: string;
  palette: Palette;
}

/**
 * The avatar: a monogram that reads at 64 pixels.
 *
 * A RING AND TWO LETTERS, nothing else. Whatever is on an avatar has to survive
 * being drawn at the size of a fingernail beside a name the app is already
 * printing, so detail is not an asset - contrast is. The ring gives the mark an
 * edge against a dark feed background, which a bare square does not have.
 */
export const avatarSvg = (input: ChannelArtInput, size: number): string => {
  const { palette: p } = input;
  const letters = monogramFor(input.name);
  const centre = size / 2;

  // Two letters at a fifth of the square is about as large as it goes before
  // the ring crowds it.
  const fontSize = Math.round(size * (letters.length > 2 ? 0.26 : 0.34));
  const ring = Math.round(size * 0.035);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" fill="${p.background}"/>`,
    // The ring sits inside the square, so a circular crop never clips it.
    `<circle cx="${centre}" cy="${centre}" r="${centre - ring * 2}" fill="none" stroke="${p.accent}" stroke-width="${ring}"/>`,
    `<text x="${centre}" y="${centre}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif"`,
    ` font-size="${fontSize}" font-weight="700" letter-spacing="${Math.round(fontSize * 0.02)}"`,
    ` fill="${p.ink}" text-anchor="middle" dominant-baseline="central">${escapeXml(letters)}</text>`,
    `</svg>`,
  ].join('');
};

/**
 * The banner, with its lower left left alone.
 *
 * THE APP OVERLAYS THE AVATAR AND HANDLE ACROSS THE BOTTOM LEFT. Anything drawn
 * there is covered by them, so the name goes in the upper left and the lower
 * third carries nothing but a rule. This is the same instruction the generated
 * banner's prompt gives, finally applied to the drawn one.
 */
export const coverSvg = (input: ChannelArtInput, width: number, height: number): string => {
  const { palette: p } = input;
  const margin = Math.round(width * 0.07);

  // Sized off the height, because the banner is cropped horizontally on narrow
  // screens and anything scaled to the width walks off the edge.
  const nameSize = Math.round(height * 0.13);
  const ruleY = Math.round(height * 0.22);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${p.background}"/>`,
    `<rect x="${margin}" y="${ruleY}" width="${Math.round(width * 0.09)}" height="${Math.max(3, Math.round(height * 0.009))}" fill="${p.accent}"/>`,
    `<text x="${margin}" y="${ruleY + Math.round(nameSize * 1.5)}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif"`,
    ` font-size="${nameSize}" font-weight="700" letter-spacing="${-Math.round(nameSize * 0.02)}"`,
    ` fill="${p.ink}">${escapeXml(input.name)}</text>`,
    `</svg>`,
  ].join('');
};

const write = (svg: string, width: number, outPath: string): string => {
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    // System fonts, so a machine with none still renders rather than throwing.
    font: { loadSystemFonts: true, defaultFontFamily: 'Arial' },
  })
    .render()
    .asPng();

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, png);
  return outPath;
};

export const renderAvatar = (input: ChannelArtInput, outPath: string, size: number): string =>
  write(avatarSvg(input, size), size, outPath);

export const renderChannelCover = (
  input: ChannelArtInput,
  outPath: string,
  size: { width: number; height: number }
): string => write(coverSvg(input, size.width, size.height), size.width, outPath);
