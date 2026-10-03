/**
 * The studio's end of choosing a picture.
 *
 * WHAT IS WORTH TESTING HERE is not that a file gets written - supplied.test.ts
 * covers that - but the two things this layer adds: that a refused picture
 * comes back as something the interface can show a person, and that the shapes
 * it demands are the ones the renderers actually produce. The second is the
 * one that rots: somebody changes AVATAR_SIZE, every drawn avatar follows, and
 * a supplied one silently keeps the old shape until it is live.
 */
import fs from 'fs';
import path from 'path';
import { AUDIO_COVER_SIZE, SERIES_COVER_SIZE } from '../../art/cover';
import { AVATAR_SIZE, PROFILE_BANNER_SIZE } from '../../art/generate';
import { EPISODE_SHAPE, SHAPES, artKind } from '../art';
import { HttpError } from '../routes';

describe('the shapes a supplied picture has to match', () => {
  it('ARE THE ONES THE RENDERERS PRODUCE, not numbers typed here', () => {
    // A supplied avatar and a drawn one end up in the same circle. If these
    // ever disagree, one of the two is wrong on the profile and nothing says
    // which.
    expect(SHAPES.avatar).toMatchObject({ width: AVATAR_SIZE, height: AVATAR_SIZE });
    expect(SHAPES.cover).toMatchObject({
      width: PROFILE_BANNER_SIZE.width,
      height: PROFILE_BANNER_SIZE.height,
    });
    // The app's PROFILE_COVER_RATIO. A 3:2 banner here refused the right file.
    expect(SHAPES.cover.width / SHAPES.cover.height).toBe(2.5);
    expect(SHAPES.series).toMatchObject({
      width: SERIES_COVER_SIZE.width,
      height: SERIES_COVER_SIZE.height,
    });
    expect(EPISODE_SHAPE).toMatchObject({
      width: AUDIO_COVER_SIZE.width,
      height: AUDIO_COVER_SIZE.height,
    });
  });

  it('are described in the words the interface uses', () => {
    // "cover failed a check" helps nobody who just picked a file.
    expect(SHAPES.avatar.label).toBe('profile picture');
    expect(SHAPES.cover.label).toBe('cover image');
    expect(EPISODE_SHAPE.label).toBe('episode image');
  });
});

describe('the kind in a query string', () => {
  it('accepts the three that exist', () => {
    expect(artKind('avatar')).toBe('avatar');
    expect(artKind('cover')).toBe('cover');
    expect(artKind('series')).toBe('series');
  });

  it('refuses anything else by naming what is allowed', () => {
    for (const bad of [null, '', 'banner', 'AVATAR', '../../etc/passwd']) {
      expect(() => artKind(bad)).toThrow(HttpError);
      expect(() => artKind(bad)).toThrow(/"avatar", "cover" or "series"/);
    }
  });
});

describe('the channel id in a query string', () => {
  it('REFUSES A PATH BEFORE IT BECOMES ONE', async () => {
    // This id goes on to build a directory that gets written to. Relying on
    // "no persona lives there" to refuse ../../etc is luck, not a rule.
    const { channelArtState } = await import('../art');

    for (const bad of ['../../etc', 'a/b', '..', 'Honest-Health', '']) {
      expect(() => channelArtState(bad)).toThrow(/is not a channel id/);
    }
  });
});

describe('the upload limit', () => {
  it('is far above the JSON limit, because this route carries a photograph', async () => {
    const { MAX_UPLOAD_BYTES } = await import('../art');
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(4 * 1024 * 1024);
  });
});

describe('what the publish actually reaches for', () => {
  it('PREFERS A SUPPLIED COVER OVER THE DRAWN ONE', () => {
    // The order here is the whole feature. publishRun.ts asks suppliedArt first
    // and only renders when it comes back empty, so this asserts the contract
    // that file depends on rather than re-running a publish.
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'publish', 'publishRun.ts'), 'utf8');

    expect(source).toMatch(/suppliedArt\(/);
    // Nullish coalescing, so renderCover is not even called when one exists:
    // drawing over a supplied cover would be the bug this guards.
    expect(source).toMatch(/chosenCover\s*\?\?\s*\n?\s*renderCover/);
  });

  it('LETS A SUPPLIED CHANNEL PICTURE SURVIVE A REDRAW', () => {
    // A redraw that destroyed an upload would make the two controls next to
    // each other cancel one another out.
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'art', 'generate.ts'), 'utf8');
    const make = source.slice(source.indexOf('const make = async'));

    expect(make.indexOf('suppliedArt(')).toBeGreaterThan(-1);
    expect(make.indexOf('suppliedArt(')).toBeLessThan(make.indexOf('imagesEnabled()'));
  });
});
