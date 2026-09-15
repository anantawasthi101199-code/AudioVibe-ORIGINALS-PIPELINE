/**
 * Everything the pipeline needs from the outside world, wired up once.
 *
 * WHY THIS IS NOT IN THE CLI ANY MORE. It was, and it was fine while the
 * command line was the only way to start a run. A web server that starts one
 * has to build exactly the same clients against exactly the same rules - the
 * writer and verifier must be different families, the show's voice is committed
 * on first use, a missing retrieval key costs documents rather than the run -
 * and the version of that which lives in a CLI file gets a second, subtly
 * different copy made of it the first time anything else needs one.
 *
 * So the rules live here and both callers ask for them. The only thing either
 * caller supplies is where the output goes.
 */
import { clerkConfig, openAiTtsConfig, screenerConfig, ttsConfig, ttsProvider, verifierConfig, writerConfig } from './config';
import { AnthropicClient, OpenAiClient, onProviderWait } from './models/client';
import { BraveSearch } from './evidence/search';
import { buildSearch, ExaSearch, firecrawlGet, retrievalKeys } from './evidence/providers';
import { HttpResponse } from './evidence/fetch';
import { ElevenLabsTts, nodePostBinary } from './render/tts';
import { OpenAiTts } from './render/openaiTts';
import { PipelineDeps } from './pipeline/episode';
import { Run } from './run/store';
import { fullText, scriptSchema } from './script/write';

export const httpGet = async (url: string): Promise<HttpResponse> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Plenty of publishers serve a stub to an unrecognised client, which
        // then reads as a paywall. Identifying honestly as a bot gets fewer
        // documents than this does.
        'user-agent':
          'Mozilla/5.0 (compatible; AudioVibeFoundry/0.1; +https://audiovibe.co) research fetcher',
        // PDFs are named explicitly because a great deal of the best primary
        // material is one: sentencing remarks, inquest findings, regulator
        // notices. A server that content-negotiates will otherwise hand back an
        // HTML landing page about the document instead of the document.
        accept:
          'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8',
      },
    });

    // READ THE BODY ONCE, AS BYTES, then decode. A response can only be
    // consumed once, so reading text() first would leave nothing for a PDF -
    // and reading arrayBuffer() first costs nothing for HTML.
    const bytes = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? undefined;
    const isPdf = /pdf/i.test(contentType ?? '') || /\.pdf($|\?)/i.test(res.url || url);

    return {
      status: res.status,
      // A PDF decoded as utf-8 is binary noise. It is never read in that form -
      // fetch.ts takes the bytes - but leaving the field empty keeps the noise
      // out of any error message that quotes the body.
      body: isPdf ? '' : bytes.toString('utf8'),
      bytes,
      finalUrl: res.url || url,
      contentType,
    };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The voice engine, chosen by FOUNDRY_TTS.
 *
 * Loud about which one it picked, because the two sound different enough that
 * listening to a draft and forgetting which engine made it is a real way to
 * reach a wrong conclusion about the writing.
 */
const buildTts = () => {
  if (ttsProvider() === 'openai') {
    const cfg = openAiTtsConfig();
    return new OpenAiTts(cfg.apiKey, { post: nodePostBinary, model: cfg.model });
  }

  return new ElevenLabsTts(ttsConfig().apiKey);
};

export const buildDeps = (over: Partial<PipelineDeps> = {}): PipelineDeps => {
  // A rate limit is a WAIT, not a failure, and a run that goes quiet for two
  // minutes is indistinguishable from a hang. Saying so is the difference
  // between somebody waiting and somebody pressing Ctrl-C on a call that was
  // about to succeed.
  onProviderWait((message) => console.log(`  ${message}`));

  const writer = writerConfig();
  const verifier = verifierConfig();
  const clerk = clerkConfig();
  const keys = retrievalKeys();

  if (writer.model === verifier.model) {
    // The check exists because collapsing these is easy, silent, and destroys
    // the point of verification.
    throw new Error(
      `the writer and verifier are both "${writer.model}". A verifier sharing the ` +
        `writer's priors reconstructs its justification instead of checking the text.`
    );
  }

  const search = buildSearch(keys, {
    brave: (k) => new BraveSearch(k),
    exa: (k) => new ExaSearch(k),
  });

  // Firecrawl renders JavaScript, which is the difference between a corpus and
  // a pile of "paywall or a JS shell" rejections on some topics. It falls back
  // to the plain fetcher per URL, so being out of credit costs documents rather
  // than the run.
  const get = keys.firecrawl ? firecrawlGet(keys.firecrawl, httpGet) : httpGet;
  const screener = screenerConfig();

  return {
    writer: new AnthropicClient(writer.model, writer.apiKey),
    verifier: new OpenAiClient(verifier.model, verifier.apiKey),
    clerk: new AnthropicClient(clerk.model, clerk.apiKey),
    screener: screener ? new OpenAiClient(screener.model, screener.apiKey) : undefined,
    search,
    tts: buildTts(),
    fetchDeps: { httpGet: get },
    // Narrowed per run in finishRun, which knows which run is being gated.
    priorTexts: priorEpisodeTexts(),
    log: (m) => console.log(`  ${m}`),
    ...over,
  };
};

/**
 * Earlier episodes from this repo's runs, for the self-similarity check.
 *
 * THE CHECK IS FOR COVERING GROUND SOMEBODY ELSE COVERED, so three things are
 * never in the list:
 *
 * ITSELF. Every script shares a hundred percent of its vocabulary with itself,
 * and including it made self-similarity fail on every episode this studio ever
 * produced - naming the run as its own plagiarism source, which at least made
 * it obvious once somebody read it.
 *
 * THE SCRIPT IT WAS CUT FROM. A cut story IS a beat of its source, word for
 * word, so the overlap is total and the source is never published anyway.
 *
 * ITS SIBLINGS. Ten stories cut from one set are one body of work, published as
 * a set, about one subject by design. Comparing them to each other guarantees
 * failures and says nothing: story seven is not plagiarising story three, they
 * are chapters. This was the half of the rule that was missing, and it was
 * failing the whole myths set and half the health set.
 */
export const priorEpisodeTexts = (exclude?: string): Array<{ label: string; text: string }> => {
  const out: Array<{ label: string; text: string }> = [];

  /** The set this run belongs to: its source if it is a cut, itself if it is one. */
  let set: string | undefined;
  if (exclude) {
    try {
      const run = Run.open(exclude);
      set = run.manifest.derivedFrom ?? exclude;
    } catch {
      // Gone or unreadable. Excluding only the id is the old behaviour and is
      // still correct, just less generous.
    }
  }

  for (const id of Run.list()) {
    if (id === exclude) continue;

    try {
      const run = Run.open(id);
      if (!run.hasArtifact('script')) continue;

      // The set, whichever side of it this run is on.
      if (set && (id === set || run.manifest.derivedFrom === set)) continue;

      out.push({ label: id, text: fullText(run.readArtifact('script', scriptSchema)) });
    } catch {
      // A malformed old run should not stop a new one.
    }
  }
  return out;
};

