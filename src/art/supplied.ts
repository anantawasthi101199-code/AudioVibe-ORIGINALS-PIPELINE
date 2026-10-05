/**
 * Artwork somebody supplied, which outranks anything this studio can make.
 *
 * WHY THIS EXISTS. The studio had two ways to get a picture: generate one, or
 * draw one. Both are guesses at what a show should look like, and neither can
 * ever be a logo somebody already owns. A channel's face is the one thing an
 * operator is better at choosing than a model is, and until now the only way to
 * set it was to write a PNG into art/<show>/ by hand and hope nothing
 * overwrote it - which a redraw promptly did.
 *
 * SUPPLIED FILES SIT BESIDE GENERATED ONES, NOT ON TOP OF THEM. `avatar.png` is
 * what the studio made; `avatar.supplied.png` is what a person chose. Two names
 * rather than one means a redraw cannot quietly destroy an upload, removing an
 * upload is deleting one file, and which one a channel is wearing is visible in
 * a directory listing rather than only in a database.
 *
 * THE HEADER DECIDES WHAT A FILE IS, not its extension and not the
 * content-type a browser guessed. A file arriving as image/png and actually
 * being a PDF is how a studio discovers the problem at publish time, hours
 * later, in an error that names the wrong thing.
 */
import fs from 'fs';
import path from 'path';

/** What the platform will take, and therefore all this will keep. */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;

export type ImageFormat = 'png' | 'jpeg' | 'webp';

export interface ImageSize {
  width: number;
  height: number;
  format: ImageFormat;
}

/**
 * Anything smaller than this is a thumbnail somebody grabbed by accident.
 *
 * Low on purpose. The job here is to catch a 64px favicon, not to enforce a
 * house standard - the studio upscales nothing, so a small-but-deliberate image
 * is the operator's call to make.
 */
export const MIN_EDGE = 256;

/**
 * How far from the target shape a supplied image may be.
 *
 * WHY THERE IS A TOLERANCE AT ALL RATHER THAN AN EXACT MATCH. The studio's own
 * picker crops to the exact pixel before it uploads, so in the interface this
 * never fires. It exists for the other door: a file dropped into art/ by hand,
 * or a CLI upload. Somebody's 2048x2048 logo is a perfectly good avatar and
 * demanding exactly 1024 would refuse it for no reason.
 *
 * A wrong RATIO is different from a wrong SIZE, and is worth refusing: the app
 * centre-crops on display, so a banner at the wrong shape loses whatever was
 * carefully placed at its edges, silently and only once it is live.
 */
export const ASPECT_TOLERANCE = 0.02;

/**
 * The dimensions of an image, read from its header, or null if it is not one.
 *
 * No dependency: every format here states its size in the first few dozen
 * bytes, and a decoder would be a native module to learn two numbers.
 */
export const imageSize = (bytes: Buffer): ImageSize | null => {
  // PNG: an 8-byte signature, then IHDR, whose first two fields are the size.
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), format: 'png' };
  }

  // JPEG: walk the segment chain to a start-of-frame, which is the only place
  // the size is stated. Everything before it is metadata of unknown length.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) break;
      const marker = bytes[at + 1]!;

      // Standalone markers carry no length, so the walk cannot step over them.
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }

      const length = bytes.readUInt16BE(at + 2);
      const isFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);

      if (isFrame) {
        return {
          height: bytes.readUInt16BE(at + 5),
          width: bytes.readUInt16BE(at + 7),
          format: 'jpeg',
        };
      }

      if (length < 2) break;
      at += 2 + length;
    }
    return null;
  }

  // WebP: a RIFF container whose size lives in whichever of three chunk types
  // it happens to use.
  if (
    bytes.length >= 30 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    const chunk = bytes.subarray(12, 16).toString('latin1');

    if (chunk === 'VP8X') {
      return {
        width: bytes.readUIntLE(24, 3) + 1,
        height: bytes.readUIntLE(27, 3) + 1,
        format: 'webp',
      };
    }
    if (chunk === 'VP8 ') {
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
        format: 'webp',
      };
    }
    if (chunk === 'VP8L') {
      const packed = bytes.readUInt32LE(21);
      return {
        width: (packed & 0x3fff) + 1,
        height: ((packed >> 14) & 0x3fff) + 1,
        format: 'webp',
      };
    }
  }

  return null;
};

/** The extension this studio stores a given format under. */
export const extensionFor = (format: ImageFormat): string =>
  format === 'jpeg' ? '.jpg' : `.${format}`;

/** Where a supplied image for `name` would live, whatever its format. */
const candidates = (dir: string, name: string): string[] =>
  IMAGE_EXTENSIONS.map((ext) => path.join(dir, `${name}.supplied${ext}`));

/**
 * The supplied image for `name`, or null if nobody supplied one.
 *
 * Returns the FIRST that exists rather than complaining about several, because
 * two supplied files is only reachable by hand, and the useful behaviour there
 * is to pick one deterministically rather than to stop.
 */
export const suppliedArt = (dir: string, name: string): string | null =>
  candidates(dir, name).find((file) => fs.existsSync(file)) ?? null;

export class ArtRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtRefused';
  }
}

export interface ArtShape {
  width: number;
  height: number;
  /** What to call this in an error somebody has to act on. */
  label: string;
}

/**
 * Store an image a person chose, replacing whatever they chose before.
 *
 * EVERY OTHER SUPPLIED FORMAT IS REMOVED FIRST. Uploading a JPEG over a PNG
 * would otherwise leave both on disk, and which one the channel wore would
 * depend on the order of a list in this file.
 */
export const saveSuppliedArt = (
  dir: string,
  name: string,
  bytes: Buffer,
  shape: ArtShape
): { path: string; size: ImageSize } => {
  const size = imageSize(bytes);

  if (!size) {
    throw new ArtRefused(
      'that file is not a PNG, JPEG or WebP image. The name and the browser both say what a ' +
        'file is meant to be; this reads the file itself, and the file disagrees.'
    );
  }

  if (size.width < MIN_EDGE || size.height < MIN_EDGE) {
    throw new ArtRefused(
      `that image is ${size.width}x${size.height}, and anything under ${MIN_EDGE} pixels on a ` +
        `side will look soft on a phone. Use a larger original.`
    );
  }

  const want = shape.width / shape.height;
  const got = size.width / size.height;
  if (Math.abs(got - want) / want > ASPECT_TOLERANCE) {
    throw new ArtRefused(
      `the ${shape.label} has to be ${shape.width}x${shape.height} in shape, and that image is ` +
        `${size.width}x${size.height}. The app centre-crops anything else on display, so the ` +
        `edges would be cut off after it went live rather than here. Crop it first.`
    );
  }

  fs.mkdirSync(dir, { recursive: true });
  for (const old of candidates(dir, name)) if (fs.existsSync(old)) fs.rmSync(old);

  const file = path.join(dir, `${name}.supplied${extensionFor(size.format)}`);
  fs.writeFileSync(file, bytes);
  return { path: file, size };
};

/** Forget a supplied image, so the drawn or generated one is worn again. */
export const removeSuppliedArt = (dir: string, name: string): boolean => {
  let removed = false;
  for (const file of candidates(dir, name)) {
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      removed = true;
    }
  }
  return removed;
};
