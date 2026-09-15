/**
 * What kind of file this is, for a multipart upload.
 *
 * WHY THIS IS NOT OBVIOUS. `new Blob([bytes])` has no type, and undici sends a
 * typeless blob as `application/octet-stream`. The platform's AUDIO filter
 * allows that - there is a comment saying Android file pickers send it - and
 * its IMAGE filter does not. So a cover uploaded without a type is rejected
 * while the audio beside it in the same request sails through, and the failure
 * arrives as "Invalid file type. Only images are allowed." about a .png.
 *
 * That cost an evening. It was found in a production log line, on a publish
 * that had an account, artwork, a credential and an approval behind it.
 *
 * ONE MAP, USED BY EVERY UPLOAD IN THIS STUDIO. The profile uploader already
 * did this correctly and the publisher did not, which is exactly the kind of
 * difference that survives review: both were written to work, one of them was
 * tried against the real API first.
 */
import path from 'path';

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
};

/**
 * The type for a path, or octet-stream when there is nothing better.
 *
 * The fallback is deliberate rather than a throw: an unknown extension is a
 * thing the platform should decide about, and refusing it here would be this
 * studio inventing a rule the API does not have.
 */
export const mimeFor = (filePath: string): string =>
  TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';

/** A file as something FormData can send, typed so a filter recognises it. */
export const fileBlob = (bytes: Buffer, filePath: string): Blob =>
  new Blob([bytes], { type: mimeFor(filePath) });
