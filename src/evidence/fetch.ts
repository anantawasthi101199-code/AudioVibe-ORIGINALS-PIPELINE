/**
 * The only way a Source comes into existence.
 *
 * Everything about the anti-hallucination design rests on this file being the
 * sole producer: a model can select from what is here, and has no path to
 * create an entry. See the header of source.ts.
 *
 * The HTTP call is INJECTED rather than imported, so the unit suite can build
 * sources without a network. That is not only about test speed - a test that
 * reaches the internet is a test that fails for reasons unrelated to the code,
 * and this is the one module where a flaky failure would be tempting to skip.
 */
import { z } from 'zod';
import {
  Source,
  SourceTier,
  hashText,
  sourceIdFor,
  sourceSchema,
  tierForUrl,
} from './source';

export interface HttpResponse {
  status: number;
  /** Response body as text. */
  body: string;
  /** Final URL after redirects, which is what should be cited. */
  finalUrl: string;
  contentType?: string;
  /**
   * The raw bytes, when the body is not text.
   *
   * Only a PDF needs this, and only because a PDF is where a great deal of the
   * best primary material lives - sentencing remarks, inquest findings, filings,
   * regulator notices. A fetcher that cannot read one is a fetcher that cannot
   * read the documents this studio exists to read.
   */
  bytes?: Buffer;
}

export type HttpGet = (url: string) => Promise<HttpResponse>;

export interface FetchDeps {
  httpGet: HttpGet;
  /** Injected so a run's sources all carry one consistent retrieval time. */
  now?: () => Date;
}

export class SourceFetchError extends Error {
  constructor(
    readonly url: string,
    message: string
  ) {
    super(`could not use ${url}: ${message}`);
    this.name = 'SourceFetchError';
  }
}

const BLOCK_TAGS = 'p|div|br|li|tr|h[1-6]|section|article|header|footer|blockquote|pre';

/**
 * HTML to plain text.
 *
 * Deliberately simple and deterministic rather than clever. What matters for
 * this pipeline is not that extraction is beautiful, but that it is STABLE:
 * quote spans are matched against exactly this output, so the same input must
 * always give the same text or a verified claim silently stops verifying.
 *
 * Script, style, and navigation chrome go first because they are the parts most
 * likely to contain text that looks like content and is not.
 */
export const htmlToText = (html: string): string => {
  let out = html;

  // Anything whose contents are not prose.
  out = out.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ');
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');

  // Structural chrome. Removed as whole elements so their text goes too.
  out = out.replace(/<(nav|aside|form)[\s\S]*?<\/\1>/gi, ' ');

  // Block boundaries become newlines so sentences do not fuse across them.
  out = out.replace(new RegExp(`<\\s*(${BLOCK_TAGS})[^>]*>`, 'gi'), '\n');
  out = out.replace(new RegExp(`<\\s*/\\s*(${BLOCK_TAGS})\\s*>`, 'gi'), '\n');

  out = out.replace(/<[^>]+>/g, ' ');

  // Entities, commonest first. Ampersand last, or it would double-decode.
  const entities: Record<string, string> = {
    '&nbsp;': ' ',
    '&#160;': ' ',
    '&quot;': '"',
    '&#34;': '"',
    '&apos;': "'",
    '&#39;': "'",
    '&lt;': '<',
    '&gt;': '>',
    '&mdash;': '-',
    '&ndash;': '-',
    '&rsquo;': "'",
    '&lsquo;': "'",
    '&ldquo;': '"',
    '&rdquo;': '"',
    '&hellip;': '...',
  };
  for (const [ent, ch] of Object.entries(entities)) {
    out = out.split(ent).join(ch);
  }
  out = out.replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
  out = out.replace(/&amp;/g, '&');

  // Whitespace. Horizontal runs collapse; vertical runs cap at one blank line.
  out = out.replace(/[ \t\u00a0]+/g, ' ');
  out = out.replace(/ *\n */g, '\n');
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
};

const firstMatch = (html: string, patterns: RegExp[]): string | undefined => {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) {
      const value = htmlToText(m[1]).trim();
      if (value) return value;
    }
  }
  return undefined;
};

/** Metadata off the page, preferring what the publisher declared about itself. */
export const extractMetadata = (html: string) => ({
  title:
    firstMatch(html, [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']citation_title["'][^>]+content=["']([^"']+)["']/i,
      /<title[^>]*>([\s\S]*?)<\/title>/i,
      /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    ]) ?? '',
  author: firstMatch(html, [
    /<meta[^>]+name=["']citation_author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)["']/i,
  ]),
  publisher: firstMatch(html, [
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']citation_journal_title["'][^>]+content=["']([^"']+)["']/i,
  ]),
  publishedAt: firstMatch(html, [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']citation_publication_date["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']date["'][^>]+content=["']([^"']+)["']/i,
    /<time[^>]+datetime=["']([^"']+)["']/i,
  ]),
  doi: firstMatch(html, [
    /<meta[^>]+name=["']citation_doi["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']dc\.identifier["'][^>]+content=["']\s*(10\.[^"']+)["']/i,
  ]),
});

/**
 * The minimum text worth treating as a document.
 *
 * A paywall stub, a cookie wall or a JS-only shell all return 200 with a few
 * hundred characters of nothing. Accepting those would put a source in the
 * corpus that no claim can ever be verified against, which then reads as the
 * verifier being broken rather than the fetch being empty.
 */
export const MIN_USABLE_CHARS = 400;

/**
 * Text out of a PDF.
 *
 * Loaded lazily, and failing softly into a rejected source rather than a thrown
 * run. A malformed PDF is one document out of fourteen; it should cost that
 * document and nothing else, and the corpus stage already knows how to report
 * a fetch that did not work.
 */
const pdfToText = async (res: HttpResponse, url: string): Promise<string> => {
  if (!res.bytes?.length) {
    throw new SourceFetchError(url, 'is a PDF but the fetcher returned no bytes to read');
  }

  try {
    // Imported lazily so the cost lands only on runs that actually meet a PDF,
    // and so a command that never fetches anything does not pay to load it.
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: res.bytes });
    try {
      const parsed = await parser.getText();
      return parsed.text
        .replace(/[ \t\u00a0]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    } finally {
      // Releases the worker. Without it a run that fetches several PDFs leaves
      // the process alive after the CLI has finished, which on Windows is
      // indistinguishable from a hang.
      await parser.destroy();
    }
  } catch (err) {
    throw new SourceFetchError(url, `is a PDF that could not be read: ${(err as Error).message}`);
  }
};

export const fetchSource = async (
  url: string,
  deps: FetchDeps,
  overrides: { tier?: SourceTier } = {}
): Promise<Source> => {
  if (!z.string().url().safeParse(url).success) {
    throw new SourceFetchError(url, 'not a valid URL');
  }

  let res: HttpResponse;
  try {
    res = await deps.httpGet(url);
  } catch (err) {
    throw new SourceFetchError(url, (err as Error).message);
  }

  if (res.status < 200 || res.status >= 300) {
    throw new SourceFetchError(url, `HTTP ${res.status}`);
  }

  const isPdf = /pdf/i.test(res.contentType ?? '') || /\.pdf($|\?)/i.test(res.finalUrl);
  const isHtml = !isPdf && (!res.contentType || /html|xml/i.test(res.contentType));

  let text: string;
  if (isPdf) {
    // A PDF READ AS TEXT IS BINARY GARBAGE THAT PASSES EVERY LENGTH CHECK.
    // Before this, a sentencing remark fetched from judiciary.uk went into the
    // corpus as thousands of characters of stream objects and font tables - a
    // "source" the extractor would then be asked to find quotes in, silently
    // producing nothing useful from the best document in the set.
    text = await pdfToText(res, url);
  } else if (isHtml) {
    text = htmlToText(res.body);
  } else {
    text = res.body.trim();
  }

  if (text.length < MIN_USABLE_CHARS) {
    throw new SourceFetchError(
      url,
      `only ${text.length} characters of text, which is a paywall or a JS shell rather than a document`
    );
  }

  const meta = isHtml
    ? extractMetadata(res.body)
    : { title: '', author: undefined, publisher: undefined, publishedAt: undefined, doi: undefined };

  // The FINAL url is what gets cited and tiered. A redirect from a shortener to
  // a paper should be tiered as the paper, and citing the shortener would make
  // the reference rot the moment it stops resolving.
  const citedUrl = res.finalUrl || url;

  return sourceSchema.parse({
    id: sourceIdFor(citedUrl),
    url: citedUrl,
    doi: meta.doi,
    title: meta.title || citedUrl,
    author: meta.author,
    publisher: meta.publisher,
    publishedAt: meta.publishedAt,
    retrievedAt: (deps.now?.() ?? new Date()).toISOString(),
    contentHash: hashText(text),
    tier: overrides.tier ?? tierForUrl(citedUrl),
    text,
    httpStatus: res.status,
  } satisfies Source);
};
