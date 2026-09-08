/**
 * Does the quote actually support the claim?
 *
 * Runs only after the deterministic check in claim.ts has confirmed the quote
 * exists in the document. This stage answers the remaining question, which is
 * about meaning rather than existence.
 *
 * THE VERIFIER IS GIVEN NOTHING ELSE. Not the topic, not the script, not the
 * beat it belongs to, not the writer's reasoning, and not the other claims.
 * Only the claim and the span. This is the single most important design
 * decision in the file, and it is easy to undo by accident when someone later
 * decides the verifier would "do better with more context": give it the
 * surrounding argument and it starts evaluating whether the argument is
 * reasonable, which is a different and much easier question than whether this
 * sentence follows from that quote.
 *
 * IT IS ALSO A DIFFERENT MODEL FAMILY FROM THE WRITER, for the same reason at a
 * different level. A verifier that shares the writer's priors reconstructs the
 * writer's justification rather than checking the text.
 */
import { z } from 'zod';
import { Claim } from './claim';
import { Source } from './source';
import { extractJson, LlmClient } from '../models/client';

export const verdictSchema = z.enum([
  /** The quote supports the claim as stated. */
  'entailed',
  /** Supports part of it, or supports it more weakly than stated. */
  'partially_entailed',
  /** Says nothing either way about the claim. */
  'not_entailed',
  /** Says the opposite. */
  'contradicted',
]);

export type Verdict = z.infer<typeof verdictSchema>;

/**
 * Verdicts that stop an episode.
 *
 * `partially_entailed` blocks too, and that is deliberate rather than strict:
 * "supports it more weakly than stated" is precisely how a sourced episode ends
 * up overclaiming, and it is the single most common way this pipeline could be
 * wrong while every individual citation checks out. The fix is to soften the
 * claim to what the source actually says, which is a rewrite, not a warning.
 */
export const BLOCKING_VERDICTS: Verdict[] = ['partially_entailed', 'not_entailed', 'contradicted'];

export const verificationSchema = z.object({
  claimId: z.string(),
  verdict: verdictSchema,
  /** One sentence. Written for a human reviewing a rejection, not for a log. */
  reason: z.string(),
});

export type Verification = z.infer<typeof verificationSchema>;

export const verificationReportSchema = z.object({
  results: z.array(verificationSchema),
  blocking: z.array(verificationSchema),
  verifierModel: z.string(),
  costPence: z.number(),
});

export type VerificationReport = z.infer<typeof verificationReportSchema>;

const SYSTEM = `You check whether a quoted passage supports a specific claim.

You will be given exactly two things: a CLAIM and a QUOTE. You have no other
context and you must not imagine any. Do not consider whether the claim is
plausible, well known, or likely true in general. The only question is whether
this quote, on its own, establishes this claim.

Answer with one of:
- entailed: the quote supports the claim as stated
- partially_entailed: the quote supports part of the claim, or supports it more
  weakly or more narrowly than the claim states
- not_entailed: the quote does not address the claim either way
- contradicted: the quote says the opposite

Be strict about strength. If the claim says "caused" and the quote says
"associated with", that is partially_entailed. If the claim gives a figure the
quote does not contain, that is not_entailed. If the claim generalises beyond
the population the quote describes, that is partially_entailed.

Reply with JSON only: {"verdict": "...", "reason": "one sentence"}`;

/**
 * Verify one claim. Deliberately one call per claim rather than a batch.
 *
 * Batching would let the model see the other claims, which is the context this
 * stage exists to withhold, and it would let one confident judgement anchor the
 * next. Cost is real but small next to render, and correctness here is the
 * whole product.
 */
export const verifyClaim = async (
  claim: Claim,
  source: Source,
  verifier: LlmClient
): Promise<{ verification: Verification; costPence: number }> => {
  const res = await verifier.complete({
    system: SYSTEM,
    // Claim first, quote second, and nothing else. No source title, no url, no
    // publisher: authority is not what is being judged here, and telling the
    // verifier the quote came from Nature would bias it toward accepting.
    prompt: `CLAIM: ${claim.text}\n\nQUOTE: ${claim.quote}`,
    temperature: 0,
    maxTokens: 300,
  });

  let parsed: { verdict?: string; reason?: string };
  try {
    parsed = extractJson(res.text);
  } catch {
    // An unparseable verdict is not a pass. Failing closed here matters more
    // than almost anywhere else in the pipeline.
    return {
      verification: {
        claimId: claim.id,
        verdict: 'not_entailed',
        reason: `verifier returned unparseable output: ${res.text.slice(0, 120)}`,
      },
      costPence: res.costPence,
    };
  }

  const verdict = verdictSchema.safeParse(parsed.verdict);
  return {
    verification: {
      claimId: claim.id,
      verdict: verdict.success ? verdict.data : 'not_entailed',
      reason: verdict.success
        ? (parsed.reason ?? '')
        : `verifier returned unknown verdict "${String(parsed.verdict)}"`,
    },
    costPence: res.costPence,
  };
};

export const verifyAll = async (
  claims: Claim[],
  sources: Source[],
  verifier: LlmClient,
  onCost?: (pence: number) => void
): Promise<VerificationReport> => {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const results: Verification[] = [];
  let costPence = 0;

  for (const claim of claims) {
    const source = byId.get(claim.sourceId);
    if (!source) {
      results.push({
        claimId: claim.id,
        verdict: 'not_entailed',
        reason: 'cites a source that is not in the corpus',
      });
      continue;
    }

    const { verification, costPence: cost } = await verifyClaim(claim, source, verifier);
    results.push(verification);
    costPence += cost;
    // Reported per claim rather than at the end, so a run that trips the budget
    // stops at the claim that tripped it instead of after all of them.
    onCost?.(cost);
  }

  return {
    results,
    blocking: results.filter((r) => BLOCKING_VERDICTS.includes(r.verdict)),
    verifierModel: verifier.model,
    costPence,
  };
};
