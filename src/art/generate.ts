/**
 * The two images that are a channel's face: its avatar and its cover.
 *
 * WHY THESE ARE GENERATED AND EPISODE COVERS ARE NOT. art/cover.ts argues at
 * length that episode artwork should be drawn rather than generated, and every
 * word of it still holds: an episode cover has one job, being recognised at 64
 * pixels in a scrolling feed, which is a typography problem; it changes weekly,
 * so illustration that varies destroys the thing it is for; and it must be
 * reproducible, or a republish quietly changes the artwork of something already
 * in somebody's library.
 *
 * An avatar is the opposite case on all three counts. It is set ONCE, it is the
 * channel's identity rather than an episode's label, and there is no weekly
 * variation to destroy. Reproducibility matters less because nothing regenerates
 * it - and when something does, that is a deliberate rebrand.
 *
 * SO THIS IS NOT A REVERSAL OF THAT ARGUMENT. It is the small number of images
 * on the other side of it.
 *
 * NO MCP AND NO NEW DEPENDENCY. The images API takes the same OPENAI_API_KEY
 * that already runs verification and the drafting voice, so there is one key,
 * one place it lives, and one thing to revoke.
 *
 * IT FALLS BACK TO THE DRAWN RENDERER. A channel with no artwork cannot be set
 * up, and an image API being down is not a reason a studio stops working. The
 * fallback is the same renderer every episode cover uses, so a channel that
 * falls back still looks like itself.
 */
import fs from 'fs';
import path from 'path';
import { Persona } from '../canon/schema';
import { openAiConfig } from '../config';
import { paletteFor, renderCover } from './cover';

/** Square, because every surface that shows an avatar crops to one. */
export const AVATAR_SIZE = 1024;

/**
 * The channel banner, at the platform's own ratio.
 *
 * 16:9 because that is what theme/mediaRatios.ts calls for, and art that does
 * not match gets cropped on display - which silently shaves off whatever was
 * carefully placed at the edge.
 */
export const COVER_SIZE = { width: 1536, height: 1024 };

export type ArtKind = 'avatar' | 'cover';

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageError';
  }
}

/**
 * What to draw, from what the show already says about itself.
 *
 * BUILT FROM THE PERSONA RATHER THAN WRITTEN BY HAND, because a persona file is
 * the one place a show's identity is already described - its thesis, its
 * register, its audience - and a prompt written separately drifts from it the
 * first time either changes.
 *
 * NO PEOPLE AND NO TEXT, and both rules are load-bearing. A face on a channel
 * avatar implies a presenter who does not exist, which is a claim this studio
 * must not make in a picture when it is careful about it in every sentence.
 * Text in a generated image comes out malformed at small sizes and cannot be
 * corrected, and the channel's name is rendered by the app beside the avatar
 * anyway.
 */
export const promptFor = (persona: Persona, kind: ArtKind): string => {
  const palette = paletteFor(persona.id);
  const thesis = persona.thesis.trim().replace(/\s+/g, ' ');

  const shared = [
    `Editorial cover art for an audio show called "${persona.name}".`,
    `The show: ${thesis}`,
    `Category: ${persona.category}.`,
    `Palette: build the image around ${palette.background} and ${palette.accent}. Muted, confident, not neon.`,
    'Style: modern editorial illustration with a printed quality. Flat or lightly textured shapes, deliberate negative space, one clear subject. The restraint of a good book jacket rather than a stock illustration.',
    'ABSOLUTELY NO TEXT, no letters, no numbers, no logos, no watermarks anywhere in the image.',
    'NO human faces and no recognisable people.',
    'Not a photograph, not 3D render, not clip art, not a collage of icons.',
  ];

  return kind === 'avatar'
    ? [
        ...shared,
        'Format: a square profile mark, read at 64 pixels as easily as at full size.',
        'One single symbol or object at the centre against a plain ground. Bold silhouette, high contrast, generous margin. Nothing fine enough to disappear when it is small.',
      ].join(' ')
    : [
        ...shared,
        'Format: a wide channel banner, 3:2 landscape.',
        'A quiet scene or arrangement with a lot of empty space, since the app overlays the channel name and avatar across the lower left. Keep the left third and the bottom third calm and uncluttered.',
      ].join(' ');
};

export interface GenerateDeps {
  /** Injected so the suite never reaches the network. */
  post?: (
    url: string,
    headers: Record<string, string>,
    body: unknown
  ) => Promise<{ status: number; json: unknown; text: string }>;
}

const nodePost: NonNullable<GenerateDeps['post']> = async (url, headers, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Left null; the caller reports the raw text, which is what an HTML error
    // page from a proxy looks like and is worth seeing verbatim.
  }
  return { status: res.status, json, text };
};

/**
 * Ask for one image and write it to disk.
 *
 * RETURNS THE PATH, NOT THE BYTES. Everything downstream uploads a file, and a
 * megabyte of base64 travelling through three function signatures to reach a
 * file write helps nobody.
 */
export const generateArt = async (
  persona: Persona,
  kind: ArtKind,
  outPath: string,
  deps: GenerateDeps = {}
): Promise<string> => {
  const post = deps.post ?? nodePost;
  const cfg = openAiConfig();

  const size = kind === 'avatar' ? `${AVATAR_SIZE}x${AVATAR_SIZE}` : `${COVER_SIZE.width}x${COVER_SIZE.height}`;

  const res = await post(
    'https://api.openai.com/v1/images/generations',
    { authorization: `Bearer ${cfg.apiKey}` },
    {
      model: 'gpt-image-1',
      prompt: promptFor(persona, kind),
      size,
      n: 1,
      // A channel's face is looked at more than any single episode's cover, and
      // it is generated once. This is the one place in the studio where the
      // expensive setting is the cheap decision.
      quality: 'high',
    }
  );

  if (res.status < 200 || res.status >= 300) {
    const message =
      (res.json as { error?: { message?: string } } | null)?.error?.message ?? res.text.slice(0, 200);
    throw new ImageError(`image generation failed (${res.status}): ${message}`);
  }

  const b64 = (res.json as { data?: Array<{ b64_json?: string }> } | null)?.data?.[0]?.b64_json;
  if (!b64) {
    throw new ImageError(`image generation returned no image: ${res.text.slice(0, 200)}`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
  return outPath;
};

/**
 * The channel's artwork, generated where possible and drawn where not.
 *
 * A CHANNEL WITH NO ARTWORK CANNOT BE SET UP, so this never throws for a reason
 * outside the studio's control. An image API being down, rate limited, or
 * refusing a prompt is a worse avatar rather than a stopped pipeline - and the
 * fallback is the same renderer every episode cover uses, so a channel that
 * falls back still looks like itself.
 *
 * It says which it used. "This channel is wearing its fallback art" is
 * something somebody should be able to see without opening the file.
 */
export const artworkFor = async (
  persona: Persona,
  dir: string,
  deps: GenerateDeps & { onProgress?: (message: string) => void } = {}
): Promise<{ avatar: string; cover: string; generated: ArtKind[] }> => {
  const generated: ArtKind[] = [];

  const make = async (kind: ArtKind): Promise<string> => {
    const out = path.join(dir, `${kind}.png`);

    try {
      deps.onProgress?.(`generating the ${kind}`);
      await generateArt(persona, kind, out, deps);
      generated.push(kind);
      return out;
    } catch (err) {
      deps.onProgress?.(`generation failed, drawing the ${kind} instead: ${(err as Error).message}`);

      // THE DRAWN FALLBACK. For an avatar this is the show's wordmark on its own
      // colour, which is a perfectly good profile mark and is what every episode
      // cover already looks like.
      renderCover(
        {
          showName: persona.name,
          // An avatar is the wordmark on the show's own colour and nothing
          // else. A title on a 64-pixel profile mark is unreadable, and the
          // app prints the channel's name beside it regardless.
          title: kind === 'avatar' ? '' : persona.name,
          palette: paletteFor(persona.id),
        },
        out,
        kind === 'avatar'
          ? { width: AVATAR_SIZE, height: AVATAR_SIZE }
          : { width: COVER_SIZE.width, height: COVER_SIZE.height }
      );
      return out;
    }
  };

  return { avatar: await make('avatar'), cover: await make('cover'), generated };
};
