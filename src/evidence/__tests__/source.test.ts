/**
 * The property that matters most in this repo: a source exists only because
 * something was fetched. These tests are mostly about refusing things - bad
 * URLs, error pages, paywall stubs - because every one of those, if accepted,
 * puts an unverifiable reference into an episode.
 */
import {
  fetchSource,
  htmlToText,
  extractMetadata,
  MIN_USABLE_CHARS,
  sellsRatherThanContains,
  SourceFetchError,
  HttpResponse,
} from '../fetch';
import { sourceIdFor, tierForUrl, weakestTier, hashText } from '../source';
import { locateQuote } from '../claim';

const body = (chars = MIN_USABLE_CHARS + 100) =>
  `<html><head><title>A Paper</title></head><body><p>${'word '.repeat(Math.ceil(chars / 5))}</p></body></html>`;

const ok = (over: Partial<HttpResponse> = {}): HttpResponse => ({
  status: 200,
  body: body(),
  finalUrl: 'https://example.org/doc',
  contentType: 'text/html',
  ...over,
});

const deps = (res: HttpResponse | Error) => ({
  httpGet: async () => {
    if (res instanceof Error) throw res;
    return res;
  },
  now: () => new Date('2026-09-07T12:00:00.000Z'),
});

describe('HTML entities', () => {
  // THE DETERMINISTIC QUOTE CHECK IS THE FOUNDATION OF THE EVIDENCE LAYER, and
  // an entity left undecoded makes it reject valid work - which is the worst
  // way for it to be wrong, because a false rejection looks exactly like the
  // model misbehaving. Two real claims from one episode were thrown out this
  // way, both of them correct.

  it('decodes HEXADECIMAL entities, which the BBC uses for apostrophes', () => {
    // The actual bug. Source text read "London&#x27;s", the model correctly
    // quoted "London's", and the check said the quote did not occur.
    expect(htmlToText('<p>London&#x27;s quarter</p>')).toBe("London's quarter");
  });

  it('decodes decimal entities', () => {
    expect(htmlToText('<p>it&#39;s here</p>')).toBe("it's here");
  });

  it('decodes a hex entity above the basic plane', () => {
    // fromCodePoint rather than fromCharCode, or anything past U+FFFF lands in
    // the middle of a quote as a replacement character.
    expect(htmlToText('<p>&#x1F600;</p>')).toBe(String.fromCodePoint(0x1f600));
  });

  it('decodes named entities', () => {
    expect(htmlToText('<p>a &mdash; b &amp; c</p>')).toBe('a - b & c');
  });

  it('does not double-decode an escaped ampersand', () => {
    // "&amp;#39;" is a literal "&#39;", not an apostrophe. Decoding the
    // ampersand before the numeric forms would turn it into one.
    expect(htmlToText('<p>&amp;#39;</p>')).toBe('&#39;');
  });
});

describe('sourceIdFor', () => {
  it('is stable for the same document', () => {
    expect(sourceIdFor('https://example.org/a')).toBe(sourceIdFor('https://example.org/a'));
  });

  it('ignores tracking junk, fragments and trailing slashes', () => {
    // Otherwise the same page reached two ways counts twice and reads as
    // corroboration when it is one document.
    const base = sourceIdFor('https://example.org/a');
    expect(sourceIdFor('https://example.org/a/')).toBe(base);
    expect(sourceIdFor('https://example.org/a#section-2')).toBe(base);
    expect(sourceIdFor('https://example.org/a?utm_source=twitter')).toBe(base);
    expect(sourceIdFor('http://example.org/a')).toBe(base);
  });

  it('keeps meaningful query parameters', () => {
    expect(sourceIdFor('https://example.org/a?id=7')).not.toBe(sourceIdFor('https://example.org/a'));
  });
});

describe('tierForUrl', () => {
  it('tiers primary and official sources T1', () => {
    expect(tierForUrl('https://www.sec.gov/filing/123')).toBe('T1');
    expect(tierForUrl('https://arxiv.org/abs/2401.00001')).toBe('T1');
    expect(tierForUrl('https://www.gov.uk/thing')).toBe('T1');
    expect(tierForUrl('https://cam.ac.uk/research')).toBe('T1');
  });

  it('tiers named reputable reporting T2', () => {
    expect(tierForUrl('https://www.reuters.com/article/x')).toBe('T2');
    expect(tierForUrl('https://www.bbc.co.uk/news/x')).toBe('T2');
  });

  it('tiers social and self-published T4', () => {
    expect(tierForUrl('https://www.reddit.com/r/x/comments/y')).toBe('T4');
    expect(tierForUrl('https://someone.substack.com/p/x')).toBe('T4');
    expect(tierForUrl('https://someone.medium.com/x')).toBe('T4');
  });

  it('guesses DOWN, never up, for anything unrecognised', () => {
    // Guessing upward is how a blog post becomes evidence. The cost of guessing
    // downward is only that a good source is under-weighted until told
    // otherwise.
    expect(tierForUrl('https://some-consultancy.com/report')).toBe('T3');
    expect(tierForUrl('not a url at all')).toBe('T4');
  });
});

describe('weakestTier', () => {
  it('takes the lowest tier present', () => {
    // One T4 post cannot be laundered into fact by sitting beside three papers.
    expect(weakestTier(['T1', 'T1', 'T4'])).toBe('T4');
    expect(weakestTier(['T1', 'T2'])).toBe('T2');
  });

  it('returns null for an unsupported claim', () => {
    expect(weakestTier([])).toBeNull();
  });
});

describe('htmlToText', () => {
  it('drops script and style content entirely', () => {
    const text = htmlToText('<p>Real.</p><script>var hidden = "fake";</script><style>.a{}</style>');
    expect(text).toContain('Real.');
    expect(text).not.toContain('fake');
    expect(text).not.toContain('var hidden');
  });

  it('drops navigation chrome, which looks like content and is not', () => {
    expect(htmlToText('<nav><a>Home</a><a>About</a></nav><p>Body.</p>')).toBe('Body.');
  });

  it('does not fuse sentences across block boundaries', () => {
    // Fused sentences produce quote spans that exist in our text and in no
    // document, which is the subtlest way verification goes wrong. Paragraphs
    // separate with a blank line; a <br> separates with a single newline.
    expect(htmlToText('<p>One.</p><p>Two.</p>')).toBe('One.\n\nTwo.');
    expect(htmlToText('Alpha<br>Beta')).toBe('Alpha\nBeta');
  });

  it('decodes entities without double-decoding ampersands', () => {
    expect(htmlToText('<p>M&amp;S said &quot;yes&quot;</p>')).toBe('M&S said "yes"');
    expect(htmlToText('<p>&amp;lt; stays literal</p>')).toBe('&lt; stays literal');
  });

  it('is deterministic, because quote spans are matched against its output', () => {
    const html = '<div><p>Alpha &mdash; beta.</p>\n\n<p>Gamma.</p></div>';
    expect(htmlToText(html)).toBe(htmlToText(html));
  });
});

describe('extractMetadata', () => {
  it('prefers what the publisher declared about itself', () => {
    const html = `
      <meta property="og:title" content="The Declared Title">
      <meta name="citation_author" content="A Researcher">
      <meta name="citation_doi" content="10.1234/abc">
      <title>Some SEO Title | Site</title>`;
    const meta = extractMetadata(html);
    expect(meta.title).toBe('The Declared Title');
    expect(meta.author).toBe('A Researcher');
    expect(meta.doi).toBe('10.1234/abc');
  });

  it('falls back to the title tag', () => {
    expect(extractMetadata('<title>Just A Title</title>').title).toBe('Just A Title');
  });
});

describe('fetchSource', () => {
  it('builds a source from a successful fetch', async () => {
    const s = await fetchSource('https://arxiv.org/abs/1', deps(ok({ finalUrl: 'https://arxiv.org/abs/1' })));
    expect(s.title).toBe('A Paper');
    expect(s.tier).toBe('T1');
    expect(s.retrievedAt).toBe('2026-09-07T12:00:00.000Z');
    expect(s.contentHash).toHaveLength(64);
    expect(s.contentHash).toBe(hashText(s.text));
  });

  it('cites the FINAL url after redirects, not the one asked for', async () => {
    // A shortener that stops resolving would otherwise rot the reference, and
    // tiering the shortener rather than the paper gets the weight wrong too.
    const s = await fetchSource(
      'https://bit.ly/xyz',
      deps(ok({ finalUrl: 'https://www.nature.com/articles/x' }))
    );
    expect(s.url).toBe('https://www.nature.com/articles/x');
    expect(s.tier).toBe('T1');
  });

  it('refuses a non-2xx response', async () => {
    await expect(fetchSource('https://example.org/x', deps(ok({ status: 404 })))).rejects.toThrow(
      /HTTP 404/
    );
  });

  it('refuses a paywall stub or JS shell', async () => {
    // 200 with nothing in it. Accepting these puts a source in the corpus that
    // no claim can be verified against, which then looks like a broken
    // verifier rather than an empty fetch.
    await expect(
      fetchSource('https://example.org/x', deps(ok({ body: '<p>Subscribe to read.</p>' })))
    ).rejects.toThrow(/paywall or a JS shell/);
  });

  it('refuses a URL that is not a URL', async () => {
    await expect(fetchSource('nonsense', deps(ok()))).rejects.toThrow(SourceFetchError);
  });

  it('reports a transport failure against the url rather than throwing raw', async () => {
    await expect(
      fetchSource('https://example.org/x', deps(new Error('ECONNRESET')))
    ).rejects.toThrow(/could not use https:\/\/example\.org\/x: ECONNRESET/);
  });

  it('accepts a human tier override', async () => {
    // Domain is a weak signal for authority and pretending otherwise would be
    // its own dishonesty, so a person can correct it.
    const s = await fetchSource('https://some-consultancy.com/r', deps(ok()), { tier: 'T2' });
    expect(s.tier).toBe('T2');
  });

  it('takes plain text bodies as-is', async () => {
    const s = await fetchSource(
      'https://example.org/x.txt',
      deps(ok({ contentType: 'text/plain', body: 'plain '.repeat(200) }))
    );
    expect(s.text.startsWith('plain')).toBe(true);
  });
});

describe('citation markers and orphaned spaces', () => {
  // THE THIRD FALSE REJECTION OF VALID WORK, and the same shape every time: the
  // deterministic quote check is the foundation of the evidence layer, so when
  // it is wrong in this direction it looks exactly like the model misbehaving.
  //
  // Both strings here are verbatim from a real run. Wikipedia carries its
  // references as superscripts, and stripping the tag leaves the number sitting
  // inside the sentence as plain text.

  const SOURCE =
    'At or shortly before 22:00, [ 23 ] gas was reintroduced into pump A, filling it. ' +
    'The loosely fitted flange did not withstand the resulting pressure. [ 48 ] ' +
    'Gas audibly leaked out at high pressure, drawing the attention of several men ' +
    'and triggering multiple gas alarms . Before anyone could act, the gas ignited.';

  it('finds a quote whose sentence contained a reference marker', () => {
    const quote =
      'At or shortly before 22:00, gas was reintroduced into pump A, filling it. ' +
      'The loosely fitted flange did not withstand the resulting pressure.';
    expect(locateQuote(SOURCE, quote).found).toBe(true);
  });

  it('finds a quote across the orphaned space a stripped tag leaves', () => {
    // "alarms ." in the source, "alarms." in the quote. The whitespace collapse
    // does not touch this, because the space sits between a word and a
    // punctuation mark rather than inside a run.
    const quote =
      'Gas audibly leaked out at high pressure, drawing the attention of several men ' +
      'and triggering multiple gas alarms.';
    expect(locateQuote(SOURCE, quote).found).toBe(true);
  });

  it('still refuses a quote that differs in a WORD', () => {
    // The whole value of the check. Folding layout must not fold meaning.
    expect(
      locateQuote(SOURCE, 'Gas audibly leaked out at low pressure, drawing the attention of several men.')
        .found
    ).toBe(false);
  });

  it('keeps editorial brackets, which are content', () => {
    // "[sic]" and "[emphasis added]" are things a document says about itself,
    // unlike a reference number, so they are matched rather than stripped.
    const withSic = 'The log recorded the valve as closed [sic] on the Wednesday morning shift.';
    expect(locateQuote(withSic, 'The log recorded the valve as closed [sic] on the Wednesday morning shift.').found).toBe(
      true
    );
  });
});

describe('pages that sell a document rather than containing one', () => {
  // A PAGE THAT SELLS A BOOK IS NOT THE BOOK. One episode drew seven claims
  // from a Yale University Press catalogue page - a blurb, a price and an ISBN
  // - and every one quoted the book rather than the page. All seven failed the
  // deterministic quote check, which is the system working, but each had cost
  // an extraction call, a verification call and a repair attempt first.
  //
  // The failure is specific: the page is ABOUT a source, so it carries the
  // right proper nouns and the right subject and survives every relevance
  // filter, and then the only honest thing to quote is marketing copy.

  it('recognises the catalogue page that actually caused this', () => {
    expect(
      sellsRatherThanContains(
        'https://yalebooks.yale.edu/book/9780300164817/vampires-burial-and-death/'
      )
    ).toBe(true);
  });

  it('recognises the usual retailers', () => {
    for (const url of [
      'https://www.amazon.co.uk/dp/0300164815',
      'https://www.goodreads.com/book/show/123.Vampires',
      'https://bookshop.org/p/books/x/9780300164817',
      'https://books.google.com/books?id=abc',
    ]) {
      expect(sellsRatherThanContains(url)).toBe(true);
    }
  });

  it('leaves a real document alone', () => {
    for (const url of [
      'https://www.judiciary.uk/wp-content/uploads/2016/03/sentencing-remarks.pdf',
      'https://etcsl.orinst.ox.ac.uk/section1/tr141.htm',
      'https://www.sacred-texts.com/neu/kveng/kvrune01.htm',
      'https://www.gutenberg.org/files/5186/5186-h/5186-h.htm',
    ]) {
      expect(sellsRatherThanContains(url)).toBe(false);
    }
  });

  it('refuses before the request, because a catalogue page fetches perfectly well', async () => {
    let called = false;
    const httpGet = async () => {
      called = true;
      throw new Error('should never be reached');
    };
    await expect(
      fetchSource('https://www.goodreads.com/book/show/123', { httpGet })
    ).rejects.toThrow(/sells or lists a document/);
    expect(called).toBe(false);
  });
});
