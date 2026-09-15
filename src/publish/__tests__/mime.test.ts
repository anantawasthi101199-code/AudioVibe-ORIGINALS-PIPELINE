/**
 * The type on an uploaded file.
 *
 * WHAT THIS IS GUARDING. `new Blob([bytes])` has no type and is sent as
 * application/octet-stream. The platform's audio filter allows that; its image
 * filter does not. So a cover with no type is rejected while the audio beside
 * it in the same request goes through, and the report is "Invalid file type.
 * Only images are allowed." about a .png - which is true, unhelpful, and
 * arrives as a 500 with no detail.
 */
import { fileBlob, mimeFor } from '../mime';

describe('mimeFor', () => {
  it('names the image types the platform will accept', () => {
    // The one that failed in production.
    expect(mimeFor('/runs/x/media/cover.png')).toBe('image/png');
    expect(mimeFor('cover.JPG')).toBe('image/jpeg');
    expect(mimeFor('a.webp')).toBe('image/webp');
  });

  it('names the audio types too, rather than leaning on the octet-stream allowance', () => {
    // The audio filter happens to allow octet-stream, so this was working by
    // luck. Luck that only covers one of the two files in a request is not a
    // thing to keep relying on.
    expect(mimeFor('episode.wav')).toBe('audio/wav');
    expect(mimeFor('episode.mp3')).toBe('audio/mpeg');
  });

  it('falls back rather than throwing on something unknown', () => {
    // An unfamiliar extension is the platform's decision to make. Refusing it
    // here would be this studio inventing a rule the API does not have.
    expect(mimeFor('notes.txt')).toBe('application/octet-stream');
    expect(mimeFor('noextension')).toBe('application/octet-stream');
  });
});

describe('fileBlob', () => {
  it('carries the type, which a bare Blob does not', () => {
    expect(fileBlob(Buffer.from('x'), 'cover.png').type).toBe('image/png');
    // The exact thing that was being sent before, for contrast.
    expect(new Blob([Buffer.from('x')]).type).toBe('');
  });

  it('keeps the bytes', async () => {
    const blob = fileBlob(Buffer.from('RIFF'), 'episode.wav');
    expect(blob.size).toBe(4);
    expect(await blob.text()).toBe('RIFF');
  });
});
