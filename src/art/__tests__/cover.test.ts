/**
 * Cover art is the one output here that nothing downstream validates: a broken
 * cover publishes perfectly and is simply wrong on a listener's screen. So what
 * is pinned is the set of failures that are invisible from inside the pipeline.
 *
 * The overflow case is not hypothetical - the first version ran long titles
 * straight off the right edge, and it took rendering one and looking at it to
 * notice, because every test and every typecheck passed.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AUDIO_COVER_SIZE,
  SERIES_COVER_SIZE,
  approximateWidth,
  coverSvg,
  escapeXml,
  fitFontSize,
  paletteFor,
  renderCover,
  wrapTitle,
} from '../cover';

const palette = paletteFor('the-teardown');

const svg = (over: Partial<Parameters<typeof coverSvg>[0]> = {}, size = AUDIO_COVER_SIZE) =>
  coverSvg({ showName: 'The Teardown', title: 'The Thursday Column', palette, ...over }, size);

describe('paletteFor', () => {
  it('is deterministic, so a re-publish never changes the artwork', () => {
    // The reason this is drawn rather than generated. An image model would make
    // cover art the only stage whose output cannot be reproduced, and a
    // re-publish would silently change the cover of something already in
    // somebody's library.
    expect(paletteFor('the-teardown')).toEqual(paletteFor('the-teardown'));
  });

  it('gives different shows different colours', () => {
    expect(paletteFor('the-teardown').background).not.toBe(paletteFor('night-shift').background);
  });

  it('varies ONLY the hue, so no show lands on an unreadable cover', () => {
    // Lightness and saturation are fixed on purpose. Letting them vary is how a
    // generator eventually produces pale text on a pale field for exactly one
    // show and nobody notices until it is published.
    const lightness = (c: string) => c.match(/,\s*([\d.]+)%\)$/)![1];
    for (const id of ['a', 'b', 'zzz', 'the-teardown', 'night-shift']) {
      const p = paletteFor(id);
      expect(lightness(p.background)).toBe('13');
      expect(lightness(p.ink)).toBe('95');
    }
  });
});

describe('escapeXml', () => {
  it('escapes a title that would otherwise break the document', () => {
    // An episode called "Q&A" produces an SVG that fails to parse, and it fails
    // at render time - after the episode has been written, voiced and gated.
    expect(escapeXml('Q&A: "why" <now>')).toBe('Q&amp;A: &quot;why&quot; &lt;now&gt;');
  });

  it('survives a round trip through the real renderer', () => {
    const out = path.join(os.tmpdir(), `foundry-escape-${Date.now()}.png`);
    expect(() =>
      renderCover({ showName: 'A & B', title: 'Q&A: "why" <it> broke', palette }, out)
    ).not.toThrow();
    fs.rmSync(out, { force: true });
  });
});

describe('wrapTitle', () => {
  it('breaks on words', () => {
    expect(wrapTitle('one two three four', 9, 4)).toEqual(['one two', 'three', 'four']);
  });

  it('keeps a word longer than the line rather than hyphenating it', () => {
    // A title with a forty-character word in it is a title problem, not a
    // layout problem.
    expect(wrapTitle('antidisestablishmentarianism', 10, 4)).toEqual([
      'antidisestablishmentarianism',
    ]);
  });

  it('truncates rather than letting the block grow past its lines', () => {
    const lines = wrapTitle('a b c d e f g h i j k l m n o p', 3, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/\.\.\.$/);
  });

  it('does not leave a dangling comma before the ellipsis', () => {
    expect(wrapTitle('one, two, three, four, five', 5, 2)[1]).not.toMatch(/,\.\.\./);
  });
});

describe('approximateWidth', () => {
  it('knows capitals set wider than lowercase', () => {
    // An average would let exactly the wide titles run off the edge, which is
    // the failure this replaced.
    expect(approximateWidth('MMMM')).toBeGreaterThan(approximateWidth('llll'));
  });

  it('counts a space as narrower than a letter', () => {
    expect(approximateWidth('    ')).toBeLessThan(approximateWidth('oooo'));
  });
});

describe('fitFontSize', () => {
  it('leaves a title that fits at the preferred size', () => {
    // Almost everything. A cover set whose type size varies title by title
    // stops looking like a set.
    expect(fitFontSize(['Short'], 10_000, 140)).toBe(140);
  });

  it('shrinks a title that would overflow', () => {
    expect(fitFontSize(['A very long line indeed that cannot fit'], 400, 140)).toBeLessThan(140);
  });

  it('will not shrink past the floor, because unreadable is worse than clipped', () => {
    expect(fitFontSize(['x'.repeat(500)], 100, 140)).toBe(Math.round(140 * 0.72));
  });

  it('measures the LONGEST line, not the first', () => {
    const first = fitFontSize(['hi'], 400, 140);
    const withLong = fitFontSize(['hi', 'a considerably longer line here'], 400, 140);
    expect(withLong).toBeLessThan(first);
  });
});

describe('coverSvg', () => {
  it('draws the show name and the episode title', () => {
    const out = svg();
    expect(out).toContain('THE TEARDOWN');
    // The title is set across lines, so it is asserted as its words rather
    // than as one string.
    expect(out).toContain('The Thursday');
    expect(out).toContain('Column');
  });

  it('says the episode number when there is one', () => {
    // On a shelf it is the single most useful thing a cover can tell you.
    expect(svg({ episodeNumber: 3 })).toContain('EPISODE 3');
  });

  it('says SHORT on a short, so a listener knows what they are in for', () => {
    expect(svg({ kind: 'short' })).toContain('SHORT');
  });

  it('does NOT print the show name twice on a series cover', () => {
    // A series cover's title IS the show name, so drawing the wordmark as well
    // prints it twice with nothing else on the frame, which reads as a mistake
    // rather than as branding.
    const out = svg({ title: 'The Teardown' }, SERIES_COVER_SIZE);
    expect(out).not.toContain('THE TEARDOWN');
    expect(out).toContain('The Teardown');
  });

  it('keeps every line inside the frame', () => {
    // The failure the first version had, and the one nothing else would catch:
    // it typechecked, it rendered, it published, and it was wrong on screen.
    const long =
      'The alarm had been off for eleven weeks and nobody noticed a single thing about it';
    const out = svg({ title: long });

    const margin = Math.round(AUDIO_COVER_SIZE.width * 0.08);
    const usable = AUDIO_COVER_SIZE.width - margin * 2;
    const size = Number(/font-size="(\d+)" font-weight="700"/.exec(out)![1]);

    for (const line of [...out.matchAll(/font-weight="700"[^>]*>([^<]+)</g)].map((m) => m[1]!)) {
      expect(approximateWidth(line) * size).toBeLessThanOrEqual(usable);
    }
  });

  it('is valid XML for the awkward cases', () => {
    expect(() => svg({ title: 'A & B <C>', showName: "Ruth's Show" })).not.toThrow();
    expect(svg({ title: 'A & B' })).toContain('A &amp; B');
  });
});

describe('renderCover', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-cover-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a PNG at the platform frame', () => {
    const out = renderCover({ showName: 'X', title: 'Y', palette }, path.join(dir, 'a', 'c.png'));
    const bytes = fs.readFileSync(out);

    // PNG magic, then the IHDR width and height as big-endian uint32s.
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    expect(bytes.readUInt32BE(16)).toBe(AUDIO_COVER_SIZE.width);
    expect(bytes.readUInt32BE(20)).toBe(AUDIO_COVER_SIZE.height);
  });

  it('writes 16:9 for a series, because that is the frame the platform crops to', () => {
    // Sending a square one would have its middle band kept and the top and
    // bottom shaved off, taking the wordmark with them.
    const out = renderCover(
      { showName: 'X', title: 'Y', palette },
      path.join(dir, 's.png'),
      SERIES_COVER_SIZE
    );
    const bytes = fs.readFileSync(out);
    expect(bytes.readUInt32BE(16) / bytes.readUInt32BE(20)).toBeCloseTo(16 / 9, 2);
  });

  it('renders the same bytes twice for the same input', () => {
    const a = renderCover({ showName: 'X', title: 'Y', palette }, path.join(dir, '1.png'));
    const b = renderCover({ showName: 'X', title: 'Y', palette }, path.join(dir, '2.png'));
    expect(fs.readFileSync(a).equals(fs.readFileSync(b))).toBe(true);
  });
});
