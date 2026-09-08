/**
 * The receipts, reduced to what the platform stores and the player renders.
 *
 * This is the shape that lands in the platform's `content_provenance` table and
 * comes back out as the Sources sheet under the player. The Foundry keeps the
 * full working state - corpora, drafts, prompts, rejected takes - and copies
 * only this across at publish time.
 *
 * WHY IT MATTERS MORE THAN THE LABEL. Disclosure is not optional: EU AI Act
 * Article 50 took effect on 2 August 2026 and Google Play requires AI
 * disclosure plus in-app flagging. But the research on AI labels is
 * consistently unkind - they reduce perceived authenticity and credibility
 * regardless of the actual quality of the content, and the effect is worse for
 * emotional material than for rational material. Transparency alone reveals the
 * trust problem without solving it.
 *
 * What closes the gap is verifiability. So the label ships together with the
 * evidence behind it, and this file is that evidence.
 */
import { z } from 'zod';
import { Claim } from '../evidence/claim';
import { CounterEvidence } from '../evidence/research';
import { Source, SourceTier } from '../evidence/source';

export const provenanceSourceSchema = z.object({
  tier: z.enum(['T1', 'T2', 'T3', 'T4']),
  title: z.string(),
  publisher: z.string().optional(),
  url: z.string().optional(),
  published_at: z.string().optional(),
});

export const provenancePayloadSchema = z.object({
  persona_ref: z.string(),
  generator_version: z.string(),
  model_ids: z.record(z.string()),
  evidence_summary: z.object({
    claim_count: z.number().int().nonnegative(),
    claims_by_tier: z.record(z.number().int().nonnegative()),
    counter_evidence_found: z.boolean(),
    counter_evidence_addressed: z.boolean(),
    sources: z.array(provenanceSourceSchema),
  }),
  rendered_at: z.string().datetime(),
});

export type ProvenancePayload = z.infer<typeof provenancePayloadSchema>;

/** Version of the pipeline that produced an episode. Bump on behaviour changes. */
export const GENERATOR_VERSION = '0.1.0';

export const buildProvenance = (input: {
  personaId: string;
  claims: Claim[];
  sources: Source[];
  counterEvidence: CounterEvidence[];
  /** Whether a human confirmed the script acknowledges the counter-evidence. */
  counterEvidenceAddressed: boolean;
  models: Record<string, string>;
  renderedAt: Date;
}): ProvenancePayload => {
  const byId = new Map(input.sources.map((s) => [s.id, s]));

  const claimsByTier: Record<string, number> = {};
  for (const claim of input.claims) {
    const tier = byId.get(claim.sourceId)?.tier;
    if (tier) claimsByTier[tier] = (claimsByTier[tier] ?? 0) + 1;
  }

  // Only sources a claim actually rests on. A corpus entry that was fetched and
  // never used is working state, not evidence, and listing it would pad the
  // sheet with documents the episode does not depend on.
  const usedIds = new Set(input.claims.map((c) => c.sourceId));
  const used = input.sources.filter((s) => usedIds.has(s.id));

  const tierRank: Record<SourceTier, number> = { T1: 1, T2: 2, T3: 3, T4: 4 };

  return provenancePayloadSchema.parse({
    persona_ref: input.personaId,
    generator_version: GENERATOR_VERSION,
    model_ids: input.models,
    evidence_summary: {
      claim_count: input.claims.length,
      claims_by_tier: claimsByTier,
      counter_evidence_found: input.counterEvidence.some((c) => c.sources.length > 0),
      counter_evidence_addressed: input.counterEvidenceAddressed,
      // Strongest first, because that is the order a reader scanning for
      // authority wants, and it puts the primary documents at the top where the
      // show's claim on attention is.
      sources: [...used]
        .sort((a, b) => tierRank[a.tier] - tierRank[b.tier])
        .map((s) => ({
          tier: s.tier,
          title: s.title,
          publisher: s.publisher,
          url: s.url,
          published_at: s.publishedAt,
        })),
    },
    rendered_at: input.renderedAt.toISOString(),
  });
};
