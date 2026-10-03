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
import { paletteFor } from './cover';
import { renderAvatar, renderChannelCover } from './channel';
import { suppliedArt } from './supplied';

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

/**
 * The profile banner AS THE APP SHOWS IT: 2.5:1, the app's PROFILE_COVER_RATIO.
 *
 * COVER_SIZE above is what the image API can be asked for, and it is not this
 * shape, so the app centre-crops a generated banner. A supplied or drawn banner
 * has no such excuse and is held to the real frame.
 */
// ponytail: generated banners are still 3:2 and get cropped on display; crop them to this after generation if that ever matters
export const PROFILE_BANNER_SIZE = { width: 2000, height: 800 };

export type ArtKind = 'avatar' | 'cover';

/**
 * Which image model, and how hard it should try.
 *
 * THE FREE OPTION IS ALREADY HERE AND IS THE FALLBACK. `FOUNDRY_IMAGE=off`
 * skips generation entirely and draws every channel's artwork with the same
 * renderer that makes episode covers - deterministic, instant, and costing
 * nothing. That is a real choice rather than a degraded one: the drawn art is
 * what every episode cover in this studio already looks like, so a channel
 * using it is consistent with its own catalogue.
 *
 * Between the two: `low` on gpt-image-1 is a few pence for a whole studio and
 * is genuinely usable for a mark seen at 64 pixels. `high` costs roughly an
 * order of magnitude more and is worth it for a channel somebody has decided
 * deserves it, not as a default nobody chose.
 */
export const imageModel = (): string => process.env.FOUNDRY_IMAGE_MODEL ?? 'gpt-image-1';

export const imageQuality = (): string => process.env.FOUNDRY_IMAGE_QUALITY ?? 'medium';

/** Whether to generate at all, or draw everything and spend nothing. */
export const imagesEnabled = (): boolean => (process.env.FOUNDRY_IMAGE ?? 'on') !== 'off';

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
      model: imageModel(),
      prompt: promptFor(persona, kind),
      size,
      n: 1,
      // MEDIUM, AND IT WAS HIGH, WHICH WAS AN OVER-REACH WITH A COMMENT ON IT.
      //
      // High is roughly an order of magnitude dearer than low on this model,
      // and the thing being bought is a mark seen at 64 pixels in a feed. What
      // makes an avatar work at that size is a bold silhouette and high
      // contrast, which the prompt asks for and which no quality tier supplies.
      //
      // FOUNDRY_IMAGE_QUALITY moves it. `low` is a few pence for a whole studio
      // and is genuinely usable; `high` is there for a channel somebody has
      // decided is worth it.
      quality: imageQuality(),
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

  /**
   * The drawn version: a monogram, and a banner that stays out of the way.
   *
   * IT USED TO REUSE THE EPISODE RENDERER, and produced two things that
   * shipped: an avatar that was a plain coloured square, because an avatar has
   * no episode title and that layout draws nothing else large; and a banner
   * with the show's name along the bottom left, which is exactly where the app
   * overlays the profile picture and handle. art/channel.ts is the layout these
   * two actually need.
   */
  const draw = (kind: ArtKind, out: string): string => {
    const input = { name: persona.name, palette: paletteFor(persona.id) };
    return kind === 'avatar'
      ? renderAvatar(input, out, AVATAR_SIZE)
      : renderChannelCover(input, out, PROFILE_BANNER_SIZE);
  };

  const make = async (kind: ArtKind): Promise<string> => {
    const out = path.join(dir, `${kind}.png`);

    // WHAT A PERSON CHOSE BEATS ANYTHING HERE, and costs nothing to honour.
    // Checked before `imagesEnabled` rather than after, because an upload is
    // not a fallback for generation being off - it outranks generation being
    // on. A redraw reaches this line too, which is how an upload survives one.
    const chosen = suppliedArt(dir, kind);
    if (chosen) {
      deps.onProgress?.(`using the ${kind} you supplied (${path.basename(chosen)})`);
      return chosen;
    }

    if (!imagesEnabled()) {
      deps.onProgress?.(`drawing the ${kind} (FOUNDRY_IMAGE=off)`);
      return draw(kind, out);
    }

    try {
      deps.onProgress?.(`generating the ${kind} on ${imageModel()} at ${imageQuality()} quality`);
      await generateArt(persona, kind, out, deps);
      generated.push(kind);
      return out;
    } catch (err) {
      deps.onProgress?.(`generation failed, drawing the ${kind} instead: ${(err as Error).message}`);
      return draw(kind, out);
    }
  };

  return { avatar: await make('avatar'), cover: await make('cover'), generated };
};
