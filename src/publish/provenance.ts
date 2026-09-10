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
  /**
   * What kind of thing this is.
   *
   * NEEDED BECAUSE AN EMPTY SOURCES LIST IS AMBIGUOUS. A fiction episode has no
   * sources because it needs none; a reported episode with no sources is a
   * failure. Rendering both as a blank Sources sheet would make the honest case
   * look like the broken one, and it is the fiction show that would suffer for
   * it - the sheet is where the studio's credibility is spent, and a blank one
   * reads as "we did not bother".
   *
   * So a fiction episode says so, and the player can render "Fiction. Nothing
   * here is reconstructed from real events" instead of an empty list.
   */
  content_kind: z.enum(['reported', 'fiction']).default('reported'),
  generator_version: z.string(),
  model_ids: z.record(z.string()),
  evidence_summary: z.object({
    claim_count: z.number().int().nonnegative(),
    claims_by_tier: z.record(z.number().int().nonnegative()),
    counter_evidence_found: z.boolean(),
    counter_evidence_addressed: z.boolean(),
    sources: z.array(provenanceSourceSchema),
    /**
     * Fiction only. What the episode was checked against instead of sources.
     *
     * Optional rather than a second top-level branch, so the platform stores
     * one shape and the player reads one field to decide what to render.
     */
    continuity: z
      .object({
        facts_checked: z.number().int().nonnegative(),
        prior_episodes: z.number().int().nonnegative(),
      })
      .optional(),
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
    content_kind: 'reported',
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

/**
 * The receipts for a fiction episode.
 *
 * A SEPARATE FUNCTION RATHER THAN A FLAG, because almost every field of the
 * evidence summary is meaningless here and passing empty arrays through the
 * reported path would produce a payload that says "we found no sources and no
 * counter-evidence" - which is true of a fiction episode and also exactly what
 * a broken reported episode says. The two must not be indistinguishable in the
 * table the Sources sheet reads from.
 *
 * WHAT REPLACES THE SOURCE LIST. How many established facts the episode was
 * checked against, and who checked. That is the fiction lane's equivalent claim
 * on a listener's trust: not "we read the documents" but "this is consistent
 * with everything you have already heard", which for a serial is the thing that
 * is actually worth promising.
 *
 * THE LABEL IS UNCHANGED. Fiction discloses as AI-generated exactly as reported
 * content does.
 */
export const buildFictionProvenance = (input: {
  personaId: string;
  /** Established facts this episode was checked against. */
  factsChecked: number;
  /** Episodes of the series that came before this one. */
  priorEpisodes: number;
  models: Record<string, string>;
  renderedAt: Date;
}): ProvenancePayload =>
  provenancePayloadSchema.parse({
    persona_ref: input.personaId,
    content_kind: 'fiction',
    generator_version: GENERATOR_VERSION,
    model_ids: input.models,
    evidence_summary: {
      // Facts checked, not claims made. A fiction episode asserts nothing about
      // the world, so counting claims would be counting zero and implying the
      // episode had failed to source anything.
      claim_count: 0,
      claims_by_tier: {},
      counter_evidence_found: false,
      counter_evidence_addressed: false,
      sources: [],
      continuity: {
        facts_checked: input.factsChecked,
        prior_episodes: input.priorEpisodes,
      },
    },
    rendered_at: input.renderedAt.toISOString(),
  });
