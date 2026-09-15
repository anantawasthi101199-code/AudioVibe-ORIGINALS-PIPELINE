/**
 * A channel's face.
 *
 * Two images per show, generated once, and the whole thing has to survive an
 * image API that is down - because a channel with no artwork cannot be set up,
 * and a studio that stops working when a third party does is a studio that
 * stops working.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadPersona } from '../../canon/load';
import {
  artworkFor,
  generateArt,
  imageModel,
  imageQuality,
  imagesEnabled,
  promptFor,
  ImageError,
} from '../generate';

const persona = loadPersona('honest-health');

/** One pixel of PNG, which is all a test needs written to disk. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const ok = async () => ({
  status: 200,
  json: { data: [{ b64_json: PIXEL }] },
  text: '',
});

describe('promptFor', () => {
  it('describes the show from its own persona, not from a hand-written brief', () => {
    // A prompt written separately drifts from the persona the first time either
    // changes, and the persona is where a show's identity already lives.
    const prompt = promptFor(persona, 'avatar');
    expect(prompt).toContain(persona.name);
    expect(prompt).toContain(persona.category);
    expect(prompt.toLowerCase()).toContain('sleep');
  });

  it('BANS text and faces, in both formats', () => {
    // A face implies a presenter who does not exist, which is a claim this
    // studio must not make in a picture when it is careful about it in every
    // sentence. Text comes out malformed small and cannot be corrected.
    for (const kind of ['avatar', 'cover'] as const) {
      const prompt = promptFor(persona, kind);
      expect(prompt).toMatch(/NO TEXT/i);
      expect(prompt).toMatch(/NO human faces/i);
    }
  });

  it('asks for a mark that survives being small, and a banner that leaves room', () => {
    expect(promptFor(persona, 'avatar')).toMatch(/64 pixels/);
    // The app overlays the name and avatar across the lower left.
    expect(promptFor(persona, 'cover')).toMatch(/left third/);
  });
});

describe('generateArt', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-art-'));
    process.env.OPENAI_API_KEY = 'test-key';
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes the image to disk and returns its path', async () => {
    const out = path.join(dir, 'avatar.png');
    expect(await generateArt(persona, 'avatar', out, { post: ok })).toBe(out);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
  });

  it('asks for a square avatar and a landscape cover', async () => {
    const sizes: string[] = [];
    const post = async (_u: string, _h: Record<string, string>, body: unknown) => {
      sizes.push((body as { size: string }).size);
      return ok();
    };

    await generateArt(persona, 'avatar', path.join(dir, 'a.png'), { post });
    await generateArt(persona, 'cover', path.join(dir, 'c.png'), { post });

    expect(sizes[0]).toBe('1024x1024');
    expect(sizes[1]).toBe('1536x1024');
  });

  it('reports what the API said, rather than a bare status', async () => {
    const post = async () => ({
      status: 400,
      json: { error: { message: 'your prompt was rejected' } },
      text: '',
    });

    await expect(generateArt(persona, 'avatar', path.join(dir, 'a.png'), { post })).rejects.toThrow(
      /your prompt was rejected/
    );
  });

  it('treats a 200 with no image as a failure, not as success', async () => {
    const post = async () => ({ status: 200, json: { data: [] }, text: '{"data":[]}' });
    await expect(
      generateArt(persona, 'avatar', path.join(dir, 'a.png'), { post })
    ).rejects.toThrow(ImageError);
  });
});

describe('artworkFor', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-art-'));
    process.env.OPENAI_API_KEY = 'test-key';
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('produces both images and says which were generated', async () => {
    const art = await artworkFor(persona, dir, { post: ok });

    expect(fs.existsSync(art.avatar)).toBe(true);
    expect(fs.existsSync(art.cover)).toBe(true);
    expect(art.generated).toEqual(['avatar', 'cover']);
  });

  it('DRAWS them instead when generation fails, rather than stopping', async () => {
    // A channel with no artwork cannot be set up. An image API being down is a
    // worse avatar, not a stopped studio - and the fallback is the same
    // renderer every episode cover uses, so the channel still looks like itself.
    const post = async () => {
      throw new Error('connection refused');
    };
    const said: string[] = [];

    const art = await artworkFor(persona, dir, { post, onProgress: (m) => said.push(m) });

    expect(fs.existsSync(art.avatar)).toBe(true);
    expect(fs.existsSync(art.cover)).toBe(true);
    expect(fs.statSync(art.avatar).size).toBeGreaterThan(0);

    // And it says so, because "this channel is wearing its fallback art" is
    // something somebody should see without opening the file.
    expect(art.generated).toEqual([]);
    expect(said.join(' ')).toMatch(/drawing the avatar instead/);
  });

  it('falls back for one image without losing the other', async () => {
    let call = 0;
    const post = async () => {
      call += 1;
      if (call === 1) return ok();
      throw new Error('rate limited');
    };

    const art = await artworkFor(persona, dir, { post });
    expect(art.generated).toEqual(['avatar']);
    expect(fs.existsSync(art.cover)).toBe(true);
  });
});

describe('what it costs, which is a choice', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-art-'));
    process.env.OPENAI_API_KEY = 'test-key';
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.FOUNDRY_IMAGE;
    delete process.env.FOUNDRY_IMAGE_QUALITY;
    delete process.env.FOUNDRY_IMAGE_MODEL;
  });

  it('defaults to medium, not high', () => {
    // High is roughly an order of magnitude dearer and the thing being bought
    // is a mark seen at 64 pixels. What makes an avatar work at that size is a
    // bold silhouette, which the prompt asks for and no quality tier supplies.
    expect(imageQuality()).toBe('medium');
    expect(imageModel()).toBe('gpt-image-1');
    expect(imagesEnabled()).toBe(true);
  });

  it('sends the quality and model it was told to', async () => {
    process.env.FOUNDRY_IMAGE_QUALITY = 'low';
    process.env.FOUNDRY_IMAGE_MODEL = 'dall-e-3';

    const sent: Array<Record<string, unknown>> = [];
    const post = async (_u: string, _h: Record<string, string>, body: unknown) => {
      sent.push(body as Record<string, unknown>);
      return ok();
    };

    await generateArt(persona, 'avatar', path.join(dir, 'a.png'), { post });
    expect(sent[0]!.quality).toBe('low');
    expect(sent[0]!.model).toBe('dall-e-3');
  });

  it('SPENDS NOTHING when generation is switched off, and still makes the art', async () => {
    // The free option is the drawn renderer, which is what every episode cover
    // already uses - so a studio running this way is consistent rather than
    // degraded.
    process.env.FOUNDRY_IMAGE = 'off';
    let called = false;
    const post = async () => {
      called = true;
      return ok();
    };

    const art = await artworkFor(persona, dir, { post });

    expect(called).toBe(false);
    expect(fs.existsSync(art.avatar)).toBe(true);
    expect(fs.existsSync(art.cover)).toBe(true);
    expect(art.generated).toEqual([]);
  });
});
