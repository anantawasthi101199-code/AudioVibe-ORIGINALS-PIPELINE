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
import { Claim, claimSchema } from './claim';
import { Source } from './source';
import { Verification } from './verify';
import { scorePassages, splitPassages } from './passages';
import { LlmClient } from '../models/client';

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

    // --- 1. A claim with no source may still have one. ---
    //
    // THE ONLY SAVE LEFT, AND IT MANGLES NOTHING. Rebinding does not touch the
    // claim; it looks for a passage elsewhere in the corpus that supports it AS
    // WRITTEN. A claim citing a source nobody fetched is usually a real fact
    // with a bad citation - "Matthew Walker is a professor at Berkeley" citing
    // source "10" - and the document that does say it is often already on disk.
    //
    // NOT FOR A CONTRADICTED CLAIM. Going looking for a source that agrees,
    // when one you already have says the opposite, is cherry-picking with extra
    // steps.
    if (failure.verdict !== 'contradicted') {
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
        spend(0);
        if (verdict.verdict === 'entailed') {
          out.set(claim.id, candidate);
          repaired.push({ claim: candidate, method: 'rebound', wasText, wasReason });
          deps.onProgress?.(`rebound ${claim.id} to a source that does support it`);
          continue;
        }
      }
    }

    // --- 2. Otherwise it goes. ---
    //
    // THE NARROWER IS GONE, AND THIS IS WHAT REPLACED IT. It used to rewrite a
    // failing claim down to what its quote strictly supported, and the rewrites
    // cost more than they saved: a lost proper noun, a lost causal link, and on
    // one occasion a claim about a different subject entirely. A claim that
    // cannot be supported is simply left out, which is what somebody who knew
    // the subject would do.
    //
    // Only two verdicts reach here now - contradicted, and unsourced - because
    // a quote that supports slightly less than its claim no longer fails at
    // all. That judgement belongs to the person who reads the script.
    out.delete(claim.id);
    repaired.push({ claim, method: 'abandoned', wasText, wasReason });
    deps.onProgress?.(
      failure.verdict === 'contradicted'
        ? `dropped ${claim.id}: its source says the opposite`
        : `dropped ${claim.id}: ${wasReason}`
    );
  }

  return {
    claims: [...out.values()],
    report: repairReportSchema.parse({ repaired, costPence }),
  };
};


