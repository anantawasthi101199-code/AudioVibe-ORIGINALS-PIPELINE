/**
 * Artwork a person chose, and the checks that stop a bad file reaching the app.
 *
 * THE POINT OF READING HEADERS rather than trusting a name: the studio uploads
 * whatever is on disk, and the platform's own filter rejects a mistyped image
 * with a 400 that names the MIME type rather than the file. Catching it at the
 * moment somebody picks the file is the difference between "that is a PDF" and
 * a failed publish an hour later.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ArtRefused,
  MIN_EDGE,
  imageSize,
  removeSuppliedArt,
  saveSuppliedArt,
  suppliedArt,
} from '../supplied';

const png = (width: number, height: number): Buffer => {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

const jpeg = (width: number, height: number): Buffer => {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt8(0xff, 0);
  bytes.writeUInt8(0xd8, 1);
  bytes.writeUInt8(0xff, 2);
  bytes.writeUInt8(0xc0, 3);
  bytes.writeUInt16BE(11, 4);
  bytes.writeUInt8(8, 6);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
};

const webp = (width: number, height: number): Buffer => {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'latin1');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBP', 8, 'latin1');
  bytes.write('VP8X', 12, 'latin1');
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
};

const SQUARE = { width: 1024, height: 1024, label: 'profile picture' };
const BANNER = { width: 1536, height: 1024, label: 'cover image' };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-art-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('reading a size out of a header', () => {
  it('reads PNG, JPEG and WebP', () => {
    expect(imageSize(png(1024, 1024))).toEqual({ width: 1024, height: 1024, format: 'png' });
    expect(imageSize(jpeg(1536, 1024))).toEqual({ width: 1536, height: 1024, format: 'jpeg' });
    expect(imageSize(webp(800, 600))).toEqual({ width: 800, height: 600, format: 'webp' });
  });

  it('is null for something that is not an image', () => {
    expect(imageSize(Buffer.from('%PDF-1.7\nnot an image at all'))).toBeNull();
    expect(imageSize(Buffer.alloc(0))).toBeNull();
    expect(imageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />'))).toBeNull();
  });

  it('does not walk off the end of a truncated JPEG', () => {
    // A segment claiming more length than the file has is the shape of both a
    // damaged upload and a deliberate one. Either way it returns, not throws.
    const truncated = jpeg(1024, 1024).subarray(0, 6);
    expect(() => imageSize(truncated)).not.toThrow();
  });
});

describe('storing what somebody chose', () => {
  it('keeps the file and reports where it went', () => {
    const { path: file } = saveSuppliedArt(dir, 'avatar', png(1024, 1024), SQUARE);

    expect(path.basename(file)).toBe('avatar.supplied.png');
    expect(suppliedArt(dir, 'avatar')).toBe(file);
  });

  it('SITS BESIDE THE DRAWN ONE rather than replacing it', () => {
    // So a redraw cannot destroy an upload, and so which one a channel is
    // wearing is visible in a directory listing.
    fs.writeFileSync(path.join(dir, 'avatar.png'), png(1024, 1024));
    saveSuppliedArt(dir, 'avatar', png(1024, 1024), SQUARE);

    expect(fs.existsSync(path.join(dir, 'avatar.png'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'avatar.supplied.png'))).toBe(true);
  });

  it('replaces an earlier choice even in another format', () => {
    saveSuppliedArt(dir, 'avatar', png(1024, 1024), SQUARE);
    const { path: second } = saveSuppliedArt(dir, 'avatar', jpeg(1024, 1024), SQUARE);

    expect(path.basename(second)).toBe('avatar.supplied.jpg');
    // Two supplied files would make the choice depend on a list's order.
    expect(fs.existsSync(path.join(dir, 'avatar.supplied.png'))).toBe(false);
  });

  it('refuses something that is not an image whatever it is called', () => {
    expect(() => saveSuppliedArt(dir, 'avatar', Buffer.from('%PDF-1.7 hello'), SQUARE)).toThrow(
      ArtRefused
    );
  });

  it('refuses a thumbnail', () => {
    expect(() => saveSuppliedArt(dir, 'avatar', png(64, 64), SQUARE)).toThrow(/under 256 pixels/);
  });

  it('REFUSES THE WRONG SHAPE, because the app crops it silently', () => {
    // The failure this prevents happens after publishing, not here: a banner at
    // the wrong ratio loses its edges on display and nothing reports it.
    expect(() => saveSuppliedArt(dir, 'cover', png(1024, 1024), BANNER)).toThrow(
      /has to be 1536x1024 in shape/
    );
  });

  it('accepts a larger original at the right shape', () => {
    // Refusing somebody's 2048px logo for not being exactly 1024 would be a
    // rule with nothing behind it.
    expect(() => saveSuppliedArt(dir, 'avatar', png(2048, 2048), SQUARE)).not.toThrow();
    expect(() => saveSuppliedArt(dir, 'cover', png(3072, 2048), BANNER)).not.toThrow();
  });

  it('allows a pixel or two of rounding', () => {
    expect(() => saveSuppliedArt(dir, 'cover', png(1535, 1024), BANNER)).not.toThrow();
  });
});

describe('taking it back off', () => {
  it('removes the supplied file and leaves the drawn one', () => {
    fs.writeFileSync(path.join(dir, 'avatar.png'), png(1024, 1024));
    saveSuppliedArt(dir, 'avatar', jpeg(1024, 1024), SQUARE);

    expect(removeSuppliedArt(dir, 'avatar')).toBe(true);
    expect(suppliedArt(dir, 'avatar')).toBeNull();
    expect(fs.existsSync(path.join(dir, 'avatar.png'))).toBe(true);
  });

  it('says so when there was nothing to remove', () => {
    expect(removeSuppliedArt(dir, 'avatar')).toBe(false);
  });
});

describe('MIN_EDGE', () => {
  it('is low enough to be about mistakes rather than taste', () => {
    expect(MIN_EDGE).toBeLessThanOrEqual(512);
  });
});
