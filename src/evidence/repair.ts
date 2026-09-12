/**
 * Saving a claim instead of binning it.
 *
 * THE PROBLEM THIS FIXES, and it was costing whole sections of episodes. A
 * claim that says more than its quote establishes fails verification and is
 * dropped, so the FACT goes with the over-reach. One episode named six men and
 * gave sentences for two, because the claim carrying the other four sentences
 * said "Collins, Jones and Perkins each got seven years" from a quote that said
 * "three ringleaders each received seven years". The seven years was solid. The
 * three names were the writer of the claim filling in from context. Binning it
 * lost the seven years too, and a listener heard a story that stops accounting
 * for four of its six people.
 *
 * verify.ts had already written down the right answer and nobody had built it:
 * "the fix is to soften the claim to what the source actually says, which is a
 * rewrite, not a warning."
 *
 * THREE THINGS TO TRY, IN THIS ORDER, and the order is the whole design.
 *
 *   1. NARROW. Rewrite the claim to say exactly what the quote establishes and
 *      no more. Cheapest, and it is what the verifier's own complaint describes
 *      - "does not explicitly state this was Perkins" is a rewrite instruction
 *      wearing a rejection's clothes. Most failures end here, with the fact
 *      kept and only the over-reach removed.
 *
 *   2. REBIND. If the extra detail is the POINT of the claim, the corpus may
 *      support it somewhere else - documents overlap, and the extractor only
 *      saw one passage. Search for a passage that does support the original,
 *      and re-verify against that. This recovers the claim whole.
 *
 *   3. MARK IT UNVERIFIED. If neither works, the claim survives with a hedge
 *      the script MUST say out loud: "the record does not say which of them".
 *      This is the listener's instruction, not mine: crucial content should be
 *      there, and an honest "we do not know" is more interesting than a silence
 *      and far more honest than a guess.
 *
 * WHY (3) IS NOT A HOLE IN THE EVIDENCE LAYER. An unverified claim is not an
 * unchecked one. It has been through extraction, the deterministic quote check,
 * verification, narrowing and rebinding, and what is left is a gap the record
 * genuinely does not close. Saying so out loud is the show's whole thesis. What
 * would be a hole is letting it pass SILENTLY, which is why the gate requires
 * the hedge to appear in the script and caps how many an episode may carry.
 */
import { z } from 'zod';
import { Claim, claimSchema, claimTypeSchema } from './claim';
import { Source } from './source';
import { Verification } from './verify';
import { scorePassages, splitPassages } from './passages';
import { completeJson, LlmClient } from '../models/client';

export const repairedClaimSchema = z.object({
  /** The claim as it now stands, narrowed, rebound, or unchanged. */
  claim: claimSchema,
  /** How it was saved, for the run report and for judging whether this works. */
  method: z.enum(['narrowed', 'rebound', 'unverified', 'abandoned']),
  /** What it said before, so a reader can see what the over-reach was. */
  wasText: z.string(),
  /** The verifier's original complaint. */
  wasReason: z.string(),
});

export type RepairedClaim = z.infer<typeof repairedClaimSchema>;

export const repairReportSchema = z.object({
  repaired: z.array(repairedClaimSchema),
  costPence: z.number(),
});

export type RepairReport = z.infer<typeof repairReportSchema>;

/**
 * How well a passage must match a claim before it is worth a verifier call.
 *
 * Permissive on purpose: a false candidate costs one cheap call and is
 * rejected, while a missed candidate costs the claim outright. The asymmetry
 * says to err low.
 */
export const MIN_REBIND_SCORE = 1.5;

export const NARROW_SYSTEM = `You repair a factual claim that says more than its source
supports.

You are given a CLAIM, the QUOTE it was bound to, and exactly what a verifier
said was missing. Your job is to rewrite the claim so that it says everything
the quote DOES establish and nothing it does not.

This is a rescue, not a rejection. The claim is about to be thrown away, and
with it whatever the quote genuinely supports. Keep as much as the quote earns.

Rules:
- SAY NO MORE THAN THE QUOTE ESTABLISHES. If the quote says "three ringleaders
  each received seven years" and the claim names them, the names go and the
  seven years stays: "three of the ringleaders were each sentenced to seven
  years".
- DO NOT RESOLVE WHAT THE QUOTE LEAVES OPEN. If the quote says "you" or "TP",
  the narrowed claim may not say "Perkins" - not even when you are sure. That
  resolution is exactly the failure being repaired.
- DO NOT ADD ANYTHING. No dates, causes, names or figures that are not in the
  quote, however well you know them.
- KEEP IT USEFUL. A claim narrowed to nothing is worse than no claim, because
  it costs a beat a fact and gives back a sentence not worth saying. If what
  survives is not worth a listener's time, say so with "keep": false.
- GLOSSES ARE ADDITIONS. "his age at sentencing" from a quote that says "is 67"
  adds both the possessive and the occasion. Say "is 67".
- CHECK THE TYPE. A claim typed "statistic" must state a number. One typed
  "quotation" must use the quote's own wording. If the narrowed claim no longer
  fits its type, change the type to one it does fit.

Return JSON only:
{"keep": true, "text": "the narrowed claim", "type": "statistic|causal|quotation|chronology|attribution|definition",
 "lost": "what the quote could not support, in a few words"}`;

const narrowReplySchema = z.object({
  keep: z.boolean(),
  text: z.string().default(''),
  type: claimTypeSchema.optional(),
  lost: z.string().default(''),
});

/**
 * A hedge the narration has to say out loud, built from what was lost.
 *
 * PHRASED AS SPEECH, NOT AS A FLAG. "unverified: attribution to Perkins" is a
 * note to an engineer; "the record does not put a name to him" is a sentence a
 * narrator can say, and the whole point is that it reaches the listener. The
 * writer is free to reword it - the gate checks that the uncertainty is voiced,
 * not that these exact words appear.
 */
export const hedgeFor = (lost: string): string => {
  const what = lost.trim().replace(/\s+/g, ' ').replace(/\.$/, '');
  return what
    ? `the record does not settle ${what}, and the script must say so`
    : `the record does not settle this, and the script must say so`;
};

/**
 * Narrow one claim to what its quote supports.
 *
 * One call. A second attempt would be asking the same model the same question
 * with the same information, and the honest answer to a failed narrowing is
 * that the quote does not support the claim, which is what step 2 and step 3
 * are for.
 */
export const narrowClaim = async (
  claim: Claim,
  reason: string,
  model: LlmClient,
  onCost?: (pence: number) => void
): Promise<{ keep: boolean; text: string; type: Claim['type']; lost: string }> => {
  const reply = await completeJson<unknown>(
    model,
    {
      system: NARROW_SYSTEM,
      prompt: [
        `CLAIM: ${claim.text}`,
        `TYPE: ${claim.type}`,
        `QUOTE: "${claim.quote}"`,
        `WHAT THE VERIFIER SAID WAS MISSING: ${reason}`,
      ].join('\n\n'),
      temperature: 0,
      // Low: this is a subtraction, not a judgement. The verifier has already
      // said what is wrong, and thinking at length about it mostly produces a
      // longer way of saying the same narrowed sentence.
      effort: 'low',
      maxTokens: 1200,
    },
    onCost,
    { parse: (v) => narrowReplySchema.parse(v), label: `the narrowing of ${claim.id}` }
  );

  const parsed = narrowReplySchema.parse(reply);
  return {
    keep: parsed.keep && parsed.text.trim().length > 0,
    text: parsed.text.trim(),
    type: parsed.type ?? claim.type,
    lost: parsed.lost,
  };
};

/**
 * A passage elsewhere in the corpus that might support the claim as it stands.
 *
 * DETERMINISTIC SELECTION, MODEL VERIFICATION. Picking the candidate with BM25
 * costs nothing and cannot hallucinate a passage; deciding whether it supports
 * the claim is the verifier's job and stays there. The claim text is the query,
 * which is crude and works, because a claim and the sentence that supports it
 * share their distinctive words almost by definition.
 */
export const findBetterQuote = (
  claim: Claim,
  sources: Source[]
): { sourceId: string; quote: string } | null => {
  // Not the source it already failed against: if that document supported the
  // claim, the extractor would have found it, and re-testing it costs a call to
  // learn nothing.
  const others = sources.filter((s) => s.id !== claim.sourceId);
  if (!others.length) return null;

  let best: { sourceId: string; quote: string; score: number } | null = null;

  for (const source of others) {
    const passages = splitPassages(source.text);
    if (!passages.length) continue;

    for (const scored of scorePassages(passages, [claim.text])) {
      if (best && scored.score <= best.score) continue;
      best = { sourceId: source.id, quote: scored.text.trim(), score: scored.score };
    }
  }

  // A passage that shares almost nothing with the claim is not a candidate, and
  // sending it to the verifier is paying to be told so.
  if (!best || best.score < MIN_REBIND_SCORE) return null;
  return { sourceId: best.sourceId, quote: best.quote };
};

/**
 * Everything needed to re-check a repaired claim.
 *
 * Verification is injected rather than imported so this module does not depend
 * on the whole verify stage, and so a test can drive the three routes without a
 * model. It is the same verifier the claim already failed: a repair judged by a
 * softer standard than the rejection would be a repair that means nothing.
 */
export interface RepairDeps {
  sources: Source[];
  narrower: LlmClient;
  /** Re-check a claim against its quote. Normally verifyAll over one claim. */
  reverify: (claim: Claim) => Promise<Verification>;
  onCost?: (pence: number) => void;
  onProgress?: (message: string) => void;
}

/**
 * How much of an episode may rest on claims the record does not settle.
 *
 * A SHOW WHOSE FACTS ARE MOSTLY HEDGED IS NOT A FACTUAL SHOW, however honestly
 * each hedge is worded. This is the line between "the record does not say which
 * of them, and that is interesting" and an episode narrating its own ignorance.
 * The gate enforces it; the number lives here because it is a property of the
 * repair policy rather than of the gate.
 */
export const MAX_UNVERIFIED_SHARE = 0.2;

/**
 * Try to save every failing claim, in the order narrow, rebind, hedge.
 *
 * Runs only over claims that FAILED. A claim the verifier accepted is not sent
 * here, because there is nothing to repair and a model asked to improve a good
 * claim will change it.
 */
export const repairAll = async (
  claims: Claim[],
  failures: Verification[],
  deps: RepairDeps
): Promise<{ claims: Claim[]; report: RepairReport }> => {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const repaired: RepairedClaim[] = [];
  let costPence = 0;
  const spend = (pence: number) => {
    costPence += pence;
    deps.onCost?.(pence);
  };

  const out = new Map(claims.map((c) => [c.id, c]));

  for (const failure of failures) {
    const claim = byId.get(failure.claimId);
    if (!claim) continue;

    const wasText = claim.text;
    const wasReason = failure.reason;

    // --- 1. Narrow to what the quote establishes. ---
    let narrowed: Awaited<ReturnType<typeof narrowClaim>>;
    try {
      narrowed = await narrowClaim(claim, wasReason, deps.narrower, spend);
    } catch {
      // A narrowing that will not come back is not a reason to lose the claim.
      // Fall through to the hedge, which is the honest description of a claim
      // nothing could confirm.
      narrowed = { keep: false, text: '', type: claim.type, lost: '' };
    }

    if (narrowed.keep) {
      const candidate = claimSchema.parse({
        ...claim,
        text: narrowed.text,
        type: narrowed.type,
        narrowedFrom: wasText,
        status: 'verified',
      });

      const verdict = await deps.reverify(candidate);
      if (verdict.verdict === 'entailed') {
        out.set(claim.id, candidate);
        repaired.push({ claim: candidate, method: 'narrowed', wasText, wasReason });
        deps.onProgress?.(`narrowed ${claim.id} to what its quote supports`);
        continue;
      }
    }

    // --- 2. Rebind to a passage that supports the claim as it stands. ---
    //
    // The ORIGINAL claim, not the narrowed one. The point of this route is to
    // recover the detail narrowing had to drop, so testing the narrowed version
    // against a new source would be answering a question nobody asked.
    const better = findBetterQuote(claim, deps.sources);
    if (better) {
      const candidate = claimSchema.parse({
        ...claim,
        sourceId: better.sourceId,
        quote: better.quote,
        reboundFrom: claim.sourceId,
        status: 'verified',
      });

      const verdict = await deps.reverify(candidate);
      if (verdict.verdict === 'entailed') {
        out.set(claim.id, candidate);
        repaired.push({ claim: candidate, method: 'rebound', wasText, wasReason });
        deps.onProgress?.(`rebound ${claim.id} to a source that supports it`);
        continue;
      }
    }

    // --- 2b. A CONTRADICTED CLAIM IS NOT AN UNSETTLED ONE. ---
    //
    // The hedge route exists for things the record does not decide. This is the
    // record deciding against you, and "the record does not settle whether the
    // alarm was answered" would be a lie about a document that says plainly it
    // was not. Dropped, and the drop is reported so it is visible rather than
    // silent.
    if (failure.verdict === 'contradicted') {
      out.delete(claim.id);
      repaired.push({ claim, method: 'abandoned', wasText, wasReason });
      deps.onProgress?.(`dropped ${claim.id}: its source says the opposite`);
      continue;
    }

    // --- 3. Keep it, and make the script say what is not settled. ---
    //
    // Narrowed text where there is some, because a claim trimmed to what its
    // quote supports is still the better sentence even when the trim was not
    // enough to pass. The hedge then covers what came off.
    const kept = claimSchema.parse({
      ...claim,
      text: narrowed.keep ? narrowed.text : claim.text,
      type: narrowed.keep ? narrowed.type : claim.type,
      narrowedFrom: narrowed.keep ? wasText : undefined,
      status: 'unverified',
      hedge: hedgeFor(narrowed.lost || wasReason),
    });

    out.set(claim.id, kept);
    repaired.push({ claim: kept, method: 'unverified', wasText, wasReason });
    deps.onProgress?.(`kept ${claim.id} as unverified, with a hedge the script must say`);
  }

  return {
    claims: [...out.values()],
    report: repairReportSchema.parse({ repaired, costPence }),
  };
};

/**
 * Language that tells a listener something is not settled.
 *
 * DELIBERATELY BROAD, because the writer is free to word the hedge its own way
 * and should be. What is being checked is that the uncertainty REACHED THE
 * LISTENER, not that a particular sentence was copied out - a gate that
 * demanded exact wording would turn an honest admission into a formula, and
 * the formula would stop meaning anything by the third episode.
 */
const UNCERTAINTY = [
  /\bnobody (wrote|recorded|knows|said|put)\b/i,
  /\bno (record|document|note|name|way of knowing)\b/i,
  /\bnot (known|clear|recorded|established|settled|say)\b/i,
  /\bnever (identified|named|established|explained|found out)\b/i,
  /\bthe record (does not|doesn't|never)\b/i,
  /\bdoes not say\b/i,
  /\bdoesn'?t say\b/i,
  /\bwe do ?n[o']t know\b/i,
  /\bunclear\b/i,
  /\bat least\b/i,
  /\bthought to\b/i,
  /\bbelieved to\b/i,
  /\breportedly\b/i,
  /\bsome of\b/i,
];

export const soundsUncertain = (text: string): boolean =>
  UNCERTAINTY.some((re) => re.test(text));

/**
 * Unverified claims a beat used without telling the listener they are unsettled.
 *
 * THE ONE THING THAT MAKES KEEPING THEM HONEST. An unverified claim spoken
 * flatly is indistinguishable from a verified one, and the whole argument for
 * keeping it - that an honest "we do not know" beats a silence - collapses if
 * the "we do not know" never gets said. So the permission and the obligation
 * are enforced together, or neither is real.
 *
 * Checked per BEAT rather than per sentence, because the hedge often belongs a
 * sentence or two away from the fact it qualifies, and demanding adjacency
 * would push the writer into stilted constructions to satisfy a regex.
 */
export const unhedgedClaims = (
  beats: Array<{ beatId: string; claimIds: string[]; text: string }>,
  claims: Claim[]
): Array<{ claimId: string; beatId: string; hedge: string }> => {
  const unverified = new Map(
    claims.filter((c) => c.status === 'unverified').map((c) => [c.id, c])
  );

  const problems: Array<{ claimId: string; beatId: string; hedge: string }> = [];
  for (const beat of beats) {
    if (soundsUncertain(beat.text)) continue;
    for (const id of beat.claimIds) {
      const claim = unverified.get(id);
      if (claim) {
        problems.push({ claimId: id, beatId: beat.beatId, hedge: claim.hedge ?? '' });
      }
    }
  }
  return problems;
};
