/**
 * Turning a topic into a corpus and a set of verified claims.
 *
 * Four steps, and the boundaries between them are where the honesty lives:
 *
 *   1. BRIEF   - the model proposes an angle and search queries. A judgement
 *                about what to look for, which cannot be false in the way a
 *                citation can.
 *   2. GATHER  - the search engine proposes URLs; the fetcher proves they
 *                exist. A model never originates an address.
 *   3. EXTRACT - the model reads the corpus and proposes claims, each with a
 *                quote it says came from a specific source. It is checked
 *                deterministically, so "says" is not taken on trust.
 *   4. COUNTER - for contested claims, disconfirming evidence is actively
 *                searched for rather than waited for.
 *
 * Step 4 is the one that separates "true" from "confidently one-sided", and it
 * is the step every content pipeline skips. A show that says "this was the
 * famous result, and here is what happened when people tried to repeat it" is
 * doing something the genre does not do, is more interesting than the confident
 * version, and is defensible.
 */
import { z } from 'zod';
import { Persona } from '../canon/schema';
import { EpisodeFormat } from '../formats/schema';
import { completeJson, extractJson, LlmClient } from '../models/client';
import { Claim, claimSchema, checkLedger, UnsupportedClaim, unsupportedClaimSchema } from './claim';
import { FetchDeps, fetchSource } from './fetch';
import { selectPassages } from './passages';
import { rankCandidates, SearchProvider } from './search';
import { Source, tierForUrl } from './source';

export const briefSchema = z.object({
  /** The specific angle, narrower than the topic. */
  angle: z.string().min(1),
  /** What the episode will have to establish to work. */
  mustEstablish: z.array(z.string().min(1)).min(1),
  /** Queries for the search engine. */
  queries: z.array(z.string().min(1)).min(3).max(12),
  /** Claims the writer expects to be contested, driving the counter-evidence pass. */
  likelyContested: z.array(z.string()).default([]),
});

export type Brief = z.infer<typeof briefSchema>;

export const corpusSchema = z.object({
  sources: z.array(z.custom<Source>()),
  /** URLs that were tried and failed, with why. Keeps a thin corpus diagnosable. */
  rejected: z.array(z.object({ url: z.string(), reason: z.string() })),
});

export type Corpus = z.infer<typeof corpusSchema>;

export const claimSetSchema = z.object({
  claims: z.array(claimSchema),
  unsupported: z.array(unsupportedClaimSchema),
});

export type ClaimSet = z.infer<typeof claimSetSchema>;

// ---------------------------------------------------------------------------
// 1. Brief
// ---------------------------------------------------------------------------

const BRIEF_SYSTEM = `You plan the research for one episode of an audio show.

You are NOT writing the episode. You are deciding what has to be found out
before anyone can write it, and what to search for.

Return JSON only:
{
  "angle": "the specific thing this episode is about, narrower than the topic",
  "mustEstablish": ["facts the episode cannot work without"],
  "queries": ["search engine queries, 5 to 10"],
  "likelyContested": ["claims you expect informed people to disagree about"]
}

Write queries a search engine will answer well: specific nouns, names, dates,
document types. Prefer queries that would surface primary documents - filings,
reports, court records, published research - over queries that would surface
commentary about them.

Be honest in likelyContested. It drives a search for evidence AGAINST the
episode's reading, and an empty list means that search does not happen.`;

export const buildBrief = async (
  topic: string,
  persona: Persona,
  format: EpisodeFormat,
  writer: LlmClient,
  onCost?: (pence: number) => void
): Promise<Brief> => {
  // completeJson rather than complete: a brief that runs out of room comes back
  // as valid JSON cut off mid-string, and parsing that says "unterminated JSON"
  // - which sends you looking for a prompt problem that is not there.
  return briefSchema.parse(
    await completeJson(
      writer,
      {
        system: BRIEF_SYSTEM,
        prompt: [
          `SHOW: ${persona.name}`,
          `THESIS: ${persona.thesis}`,
          `AUDIENCE: ${persona.audience}`,
          `FORMAT: ${format.name} - ${format.intent}`,
          `TOPIC: ${topic}`,
        ].join('\n'),
        temperature: 0.7,
        maxTokens: 2500,
      },
      onCost
    )
  );
};

// ---------------------------------------------------------------------------
// 2. Gather
// ---------------------------------------------------------------------------

export interface GatherOptions {
  /** How many documents to end up with. */
  targetSources: number;
  /** How many search results to consider per query before fetching. */
  perQuery: number;
}

export const DEFAULT_GATHER: GatherOptions = { targetSources: 14, perQuery: 8 };

/**
 * Search, then fetch, until there are enough documents or candidates run out.
 *
 * Fetch failures are recorded rather than swallowed. A corpus that came out
 * thin should say whether that is because the topic is obscure or because
 * fifteen paywalls said no, and those call for completely different responses.
 */
export const gatherCorpus = async (
  queries: string[],
  search: SearchProvider,
  fetchDeps: FetchDeps,
  opts: GatherOptions = DEFAULT_GATHER
): Promise<Corpus> => {
  const candidates = [];
  for (const query of queries) {
    try {
      candidates.push(...(await search.search(query, opts.perQuery)));
    } catch (err) {
      // One failed query should not lose the other nine.
      candidates.push();
      void err;
    }
  }

  const ranked = rankCandidates(candidates, tierForUrl);
  const sources: Source[] = [];
  const rejected: Corpus['rejected'] = [];
  const haveIds = new Set<string>();

  for (const candidate of ranked) {
    if (sources.length >= opts.targetSources) break;
    try {
      const source = await fetchSource(candidate.url, fetchDeps);
      if (haveIds.has(source.id)) continue;
      haveIds.add(source.id);
      sources.push(source);
    } catch (err) {
      rejected.push({ url: candidate.url, reason: (err as Error).message });
    }
  }

  return { sources, rejected };
};

// ---------------------------------------------------------------------------
// 3. Extract
// ---------------------------------------------------------------------------

const EXTRACT_SYSTEM = `You extract factual claims from a corpus of documents,
for one episode of an audio show.

You will be given the episode's beats and a numbered corpus. For each beat,
propose the claims that beat needs, and for EACH claim give a quote from ONE
document that establishes it.

RULES, and these are not style preferences:

1. The quote must be COPIED EXACTLY from the document. Not paraphrased, not
   tidied, not shortened with ellipses. It is checked character by character
   against the source and a paraphrase is rejected.
2. The quote must be at least 40 characters.
3. If the corpus does not support something the beat needs, put it in
   "unsupported" and move on. Do NOT stretch a quote to cover it. Abstaining is
   a correct answer and is used to send the researcher back out.
4. Claim types: statistic, causal, quotation, chronology, attribution,
   definition. A statistic must state a number and its quote must contain one.
   Only call something causal if the document states a cause; if the document
   says "associated with", the claim says associated with.
5. Mark contested: true when informed people would disagree.

Return JSON only:
{
  "claims": [
    {"id":"c1","beatId":"...","text":"...","type":"...","sourceId":"...",
     "quote":"exact text from that document","contested":false}
  ],
  "unsupported": [{"beatId":"...","text":"what could not be supported",
                   "attemptedQueries":["what would have been needed"]}]
}`;

/**
 * How much of each document to show the extractor.
 *
 * Whole documents would blow the context window on a corpus of fourteen, and
 * the head of a document is where its thesis and its numbers almost always
 * live. A source whose relevant passage is on page nine is a source this stage
 * will miss, which is a real limitation and worth stating rather than hiding.
 */
export const EXTRACT_CHARS_PER_SOURCE = 6000;

/**
 * How many beats to extract claims for in one call.
 *
 * ONE CALL FOR THE WHOLE EPISODE DOES NOT FIT, which is how this was found: ten
 * beats against fourteen documents, each claim carrying a verbatim quote of
 * forty characters or more, ran past sixteen thousand output tokens twice and
 * killed the run after the corpus had already been fetched and paid for.
 *
 * Three beats is small enough that the reply always fits with room to spare,
 * and it is better work as well as safer: a model asked for claims for three
 * beats reads the corpus for three specific jobs, where one asked for ten
 * spreads itself and returns something thinner for each.
 */
export const BEATS_PER_EXTRACTION = 3;

/**
 * Extract the claims an episode needs, a few beats at a time.
 *
 * THE CORPUS IS SENT AS A CACHED SYSTEM PREFIX, which is what stops chunking
 * from multiplying the bill. The documents are the expensive half of this
 * prompt and they are identical across every chunk, so the first call writes
 * the cache and the rest read it at a tenth of the price. Chunking without
 * this would have tripled the input cost of the most input-heavy stage in the
 * pipeline.
 *
 * Claim ids are renumbered across chunks. Each call starts counting at c1
 * because it cannot see the others, and two claims sharing an id would collide
 * silently in the ledger - the later one simply replacing the earlier.
 */
export const extractClaims = async (
  brief: Brief,
  corpus: Corpus,
  format: EpisodeFormat,
  writer: LlmClient,
  onCost?: (pence: number) => void,
  onProgress?: (message: string) => void
): Promise<ClaimSet> => {
  // What the episode is trying to establish, which is what each passage is
  // scored for relevance against.
  const wanted = [brief.angle, ...brief.mustEstablish, ...brief.queries];

  const documents = corpus.sources
    .map(
      (s, i) =>
        `--- DOCUMENT ${i + 1} | sourceId: ${s.id} | tier: ${s.tier} | ${s.title}\n` +
        selectPassages(s.text, wanted, EXTRACT_CHARS_PER_SOURCE)
    )
    .join('\n\n');

  const system = `${EXTRACT_SYSTEM}\n\nCORPUS:\n${documents}`;

  const chunks: (typeof format.beats)[] = [];
  for (let i = 0; i < format.beats.length; i += BEATS_PER_EXTRACTION) {
    chunks.push(format.beats.slice(i, i + BEATS_PER_EXTRACTION));
  }

  const claims: ClaimSet['claims'] = [];
  const unsupported: ClaimSet['unsupported'] = [];

  for (const [index, chunk] of chunks.entries()) {
    onProgress?.(
      `beats ${chunk.map((b) => b.id).join(', ')} (${index + 1}/${chunks.length})`
    );

    const beats = chunk
      .map(
        (b) =>
          `- ${b.id} (${b.type}, needs >= ${b.minClaims} claims, and no more than ` +
          `${b.minClaims + 2}): ${b.function}`
      )
      .join('\n');

    const parsed = claimSetSchema.parse(
      await completeJson(
        writer,
        {
          system,
          // The corpus never changes between chunks, so the prefix stays valid
          // and every call after the first reads it rather than re-sending it.
          cacheSystem: true,
          prompt: [
            `ANGLE: ${brief.angle}`,
            `MUST ESTABLISH:\n${brief.mustEstablish.map((m) => `- ${m}`).join('\n')}`,
            `Extract claims for THESE BEATS ONLY. Ignore every other beat of the episode.`,
            `BEATS:\n${beats}`,
          ].join('\n\n'),
          temperature: 0.2,
          maxTokens: 6000,
        },
        onCost
      )
    );

    // Renumbered against the running total, not the chunk. Each call starts at
    // c1 because it cannot see the others.
    for (const claim of parsed.claims) {
      claims.push({ ...claim, id: `c${claims.length + 1}` });
    }
    unsupported.push(...parsed.unsupported);
  }

  return { claims, unsupported };
};

// ---------------------------------------------------------------------------
// 4. Counter-evidence
// ---------------------------------------------------------------------------

const COUNTER_SYSTEM = `You are looking for evidence AGAINST a claim.

Given a claim, propose search queries most likely to surface credible
disagreement, failed replications, corrections, retractions, or contrary
findings. Do not propose queries that would confirm it.

Return JSON only: {"queries": ["...", "..."]}`;

export interface CounterEvidence {
  claimId: string;
  /** Sources found that argue against the claim. */
  sources: Source[];
  queries: string[];
}

/**
 * Actively look for disconfirmation of contested claims.
 *
 * This is the step that separates a grounded show from a confident one. The
 * self-help genre in particular is built almost entirely on findings that
 * failed to replicate or whose effect sizes collapsed, and a pipeline that only
 * ever searches for support will reproduce all of them with perfect citations.
 */
export const gatherCounterEvidence = async (
  claims: Claim[],
  search: SearchProvider,
  fetchDeps: FetchDeps,
  writer: LlmClient,
  opts: { perClaim?: number } = {},
  onCost?: (pence: number) => void
): Promise<CounterEvidence[]> => {
  const contested = claims.filter((c) => c.contested);
  const out: CounterEvidence[] = [];

  for (const claim of contested) {
    const res = await writer.complete({
      system: COUNTER_SYSTEM,
      prompt: `CLAIM: ${claim.text}`,
      temperature: 0.5,
      maxTokens: 400,
    });
    onCost?.(res.costPence);

    let queries: string[] = [];
    try {
      queries = z.object({ queries: z.array(z.string()) }).parse(extractJson(res.text)).queries;
    } catch {
      queries = [];
    }

    const found: Source[] = [];
    for (const query of queries.slice(0, opts.perClaim ?? 2)) {
      try {
        const results = await search.search(query, 5);
        for (const r of rankCandidates(results, tierForUrl).slice(0, 2)) {
          try {
            found.push(await fetchSource(r.url, fetchDeps));
          } catch {
            // A counter-source that will not fetch is not a failure of the run.
          }
        }
      } catch {
        // Same.
      }
    }

    out.push({ claimId: claim.id, sources: found, queries });
  }

  return out;
};

/** Everything the ledger stage produces, ready to be written as one artifact. */
export const buildLedger = (claimSet: ClaimSet, corpus: Corpus) => {
  const report = checkLedger(claimSet.claims, corpus.sources);
  return {
    claims: claimSet.claims,
    unsupported: claimSet.unsupported as UnsupportedClaim[],
    report,
  };
};
