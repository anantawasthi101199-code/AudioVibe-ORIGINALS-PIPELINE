/**
 * A claim, and the span of a source that supports it.
 *
 * THE CONTRACT. Every factual assertion in a script is a row here, carrying the
 * id of a source and a VERBATIM quote from that source's text. Two checks then
 * apply, and the order matters:
 *
 *   1. Deterministic: does the quote actually occur in the source? This needs
 *      no model, cannot be argued with, and catches the most common failure -
 *      a quote that is a plausible paraphrase of the document rather than a
 *      thing the document says.
 *   2. Semantic: does the quote actually support the claim? That needs a model,
 *      and it is the job of the verifier, which lives elsewhere and is
 *      deliberately a different model family from the writer.
 *
 * Doing (1) first is most of the value for none of the cost. A model asked to
 * "quote the source" will, given the chance, produce something the source
 * almost says, and a semantic verifier handed that quote will often agree with
 * it - because the quote does support the claim; it just is not in the
 * document. Checking existence before meaning closes that hole entirely.
 *
 * ABSTENTION IS A FIRST-CLASS OUTPUT. When retrieval does not support something
 * the writer wants to say, the correct result is an unsupported claim recorded
 * as such and a beat rewritten - never a guess. See `UnsupportedClaim`.
 */
import { z } from 'zod';
import { Source, SourceTier, weakestTier } from './source';

/**
 * What KIND of assertion this is, because the ways they go wrong differ.
 *
 * Each type carries its own structural rules, checked in `checkClaimShape`.
 */
export const claimTypeSchema = z.enum([
  /** A number. Must carry unit, population and date, or it is a different number. */
  'statistic',
  /** X caused Y. The type most often overstated, and the one with the strictest rule. */
  'causal',
  /** Someone said this. Must be exact and attributed. */
  'quotation',
  /** This happened before that. */
  'chronology',
  /** Someone or something is described as X. */
  'attribution',
  /** A term means X. */
  'definition',
]);

export type ClaimType = z.infer<typeof claimTypeSchema>;

export const claimSchema = z.object({
  id: z.string().min(1),
  /** The assertion as the script will make it, not as the source words it. */
  text: z.string().min(1),
  type: claimTypeSchema,
  /** Which beat this claim appears in. */
  beatId: z.string().min(1),
  /** The source that supports it. */
  sourceId: z.string().min(1),
  /** Verbatim span from that source's extracted text. */
  quote: z.string().min(1),

  /**
   * Whether the retriever flagged this as contested.
   *
   * Drives the counter-evidence pass: a contested claim must have had
   * disconfirming sources actively searched for, and if material ones exist the
   * script has to acknowledge them. Confident one-sidedness is the most common
   * way generated content is false while every sentence is individually sourced.
   */
  contested: z.boolean().default(false),

  /**
   * Whether the quote settles this claim, after repair.
   *
   * 'verified' is the only state the old pipeline had, and everything else was
   * deleted. That cost whole sections of episodes: a claim saying "Collins,
   * Jones and Perkins each got seven years" against a quote saying "three
   * ringleaders each received seven years" was binned, and the seven years went
   * with the three names. One episode named six men and sentenced two.
   *
   * 'unverified' is what survives when narrowing and rebinding have both failed
   * and the fact still matters. It is NOT an unchecked claim - it has been
   * through extraction, the deterministic quote check, verification, a
   * narrowing pass and a rebinding pass, and what remains is a gap the record
   * genuinely does not close. The script may use it ONLY while saying so, which
   * the gate enforces. See evidence/repair.ts.
   */
  status: z.enum(['verified', 'unverified']).default('verified'),

  /**
   * What the script must tell the listener about what is not settled.
   *
   * Written as speech rather than as a flag, because its whole purpose is to
   * reach the listener. Present only on an unverified claim.
   */
  hedge: z.string().optional(),

  /** What this claim said before it was narrowed, so the change is auditable. */
  narrowedFrom: z.string().optional(),

  /**
   * The source this claim was bound to before it was rebound to a better one.
   *
   * Symmetric with narrowedFrom, and needed for the same reason: verification
   * runs BEFORE repair, so its rejection list is a snapshot of what was wrong
   * before anything was done about it. Without a mark saying "this one was
   * fixed", the gate re-reports a fault that no longer exists.
   */
  reboundFrom: z.string().optional(),
});

export type Claim = z.infer<typeof claimSchema>;

/** Something the writer wanted to say and retrieval could not support. */
export const unsupportedClaimSchema = z.object({
  text: z.string().min(1),
  beatId: z.string().min(1),
  /** What was searched for, so the gap is diagnosable rather than mysterious. */
  attemptedQueries: z.array(z.string()).default([]),
});

export type UnsupportedClaim = z.infer<typeof unsupportedClaimSchema>;

// ---------------------------------------------------------------------------
// Deterministic check: does the quote exist in the source?
// ---------------------------------------------------------------------------

/**
 * Whitespace-insensitive comparison form.
 *
 * Extraction collapses runs and inserts newlines at block boundaries, and a
 * model quoting a span will not reproduce that layout exactly. Normalising both
 * sides means a real quote is not rejected over a line break, while anything
 * that differs in a WORD still fails - which is the distinction that matters.
 *
 * Typographic quotes and dashes are folded for the same reason: a document
 * using a curly apostrophe and a quote using a straight one are the same words.
 *
 * CITATION MARKERS AND ORPHANED SPACES ARE FOLDED TOO, and that was another
 * false rejection of valid work - the third of this kind, and the same shape
 * every time. A Wikipedia sentence carries its references as superscripts, and
 * stripping the tag leaves the number behind as plain text:
 *
 *   source: "At or shortly before 22:00, [ 23 ] gas was reintroduced into
 *            pump A ... withstand the resulting pressure. [ 48 ]"
 *   quote:  "At or shortly before 22:00, gas was reintroduced into pump A ...
 *            withstand the resulting pressure."
 *
 * The model quoted the sentence correctly. The check said the quote did not
 * occur. The same strip also leaves a space before the full stop - "alarms ." -
 * which the whitespace collapse above does not remove, because it sits between
 * a word and a punctuation mark rather than inside a run.
 *
 * Folding both HERE rather than only at fetch time is deliberate: it repairs
 * runs whose corpus is already on disk, and it is symmetric, so a quote that
 * genuinely differs in a WORD still fails.
 */
export const normaliseForMatch = (s: string): string =>
  s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\u00a0/g, ' ')
    // Reference markers, section-edit links and editorial flags. Bracketed
    // digits in a fetched document are citations essentially without exception.
    // The named ones are listed rather than matched generally, because "[sic]"
    // and "[emphasis added]" are content and have to survive.
    .replace(/\[\s*\d+\s*\]/g, ' ')
    .replace(/\[\s*(edit|citation needed|clarification needed|who\?|when\?)\s*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()
    .toLowerCase();

export type QuoteCheck =
  | { found: true; index: number }
  | { found: false; reason: 'not_present' | 'empty' | 'too_short' };

/**
 * The shortest quote worth accepting.
 *
 * A three-word span occurs in almost any document by chance, so a short quote
 * proves nothing about whether the source says the thing. Long enough to be
 * evidence, short enough not to force whole paragraphs into the ledger.
 */
export const MIN_QUOTE_CHARS = 40;

export const locateQuote = (sourceText: string, quote: string): QuoteCheck => {
  const q = normaliseForMatch(quote);
  if (!q) return { found: false, reason: 'empty' };
  if (q.length < MIN_QUOTE_CHARS) return { found: false, reason: 'too_short' };

  const index = normaliseForMatch(sourceText).indexOf(q);
  return index >= 0 ? { found: true, index } : { found: false, reason: 'not_present' };
};

// ---------------------------------------------------------------------------
// Type-specific shape rules
// ---------------------------------------------------------------------------

const HEDGE_CAUSAL = /\b(may|might|could|suggests?|associated with|linked to|correlat)/i;
const HARD_CAUSAL = /\b(caused?|causes|because of|led to|resulted in|due to|drove|triggered)\b/i;
const HAS_NUMBER = /\d/;

export interface ShapeProblem {
  claimId: string;
  problem: string;
}

/**
 * Structural rules per claim type. Cheap, deterministic, and run before any
 * model is asked anything.
 *
 * These do not check truth. They check that a claim is the KIND of thing its
 * type promises, which is what stops a "statistic" that carries no number and a
 * "quotation" that is a summary.
 */
/**
 * Fix a claim whose type the extractor guessed wrong.
 *
 * RETYPED, NOT REJECTED, and that is the whole argument. A claim bound to a
 * verbatim quote that says what the claim says is a good claim; what kind of
 * assertion it is, is a label the extractor chose, and the extractor is not
 * especially good at choosing it. Three claims in one set were filed as
 * statistics - "those who had deja vu more frequently also had jamais vu more
 * frequently" - and blocked for stating no number. They state no number because
 * they are not statistics. Nothing about the evidence was wrong.
 *
 * ONLY DOWNWARD, AND ONLY WHERE THE EVIDENCE IS UNAMBIGUOUS. It never promotes
 * a claim into a stricter type, because that would be this function inventing a
 * promise the extractor never made. A statistic with no number anywhere becomes
 * an attribution: the weakest type, carrying no structural promise beyond being
 * bound to its quote, which is exactly what such a claim is.
 *
 * THE NUMBER RULE STILL BITES WHERE IT MATTERS. A claim stating a figure its
 * quote does not contain keeps its type and still fails - that is a number
 * somebody remembered rather than read, and it is the failure the rule was
 * written for.
 */
export const retypeClaim = (claim: Claim): Claim => {
  if (claim.type !== 'statistic') return claim;

  // Only when NEITHER side has a number. A claim with a figure the quote lacks
  // is the fault the statistic rule exists to catch, and must keep its type.
  if (HAS_NUMBER.test(claim.text) || HAS_NUMBER.test(claim.quote)) return claim;

  return { ...claim, type: 'attribution' };
};

export const checkClaimShape = (claim: Claim, source: Source): ShapeProblem[] => {
  const problems: ShapeProblem[] = [];
  const add = (problem: string) => problems.push({ claimId: claim.id, problem });

  if (claim.type === 'statistic') {
    if (!HAS_NUMBER.test(claim.text)) {
      add('typed as a statistic but states no number');
    }
    if (!HAS_NUMBER.test(claim.quote)) {
      // A figure that has lost its source figure is a figure somebody
      // remembered rather than read.
      add('the supporting quote contains no number');
    }
  }

  if (claim.type === 'causal') {
    // The rule that keeps the self-help and case-study lanes honest: a source
    // that only reports an association may not be narrated as a cause.
    const quoteIsAssociational = HEDGE_CAUSAL.test(claim.quote) && !HARD_CAUSAL.test(claim.quote);
    if (quoteIsAssociational && HARD_CAUSAL.test(claim.text)) {
      add('states a cause, but the quote only reports an association');
    }
  }

  if (claim.type === 'quotation') {
    // The claim is meant to reproduce words, so it should contain them.
    const claimCore = normaliseForMatch(claim.text.replace(/^[^"'“]*/, ''));
    if (claimCore && !normaliseForMatch(claim.quote).includes(claimCore.slice(0, 30))) {
      add('typed as a quotation but its wording does not appear in the quote');
    }
  }

  if (claim.type === 'attribution' && source.tier === 'T4') {
    // Attributing a position to someone on the strength of a forum post is the
    // shape of claim most likely to be both wrong and actionable.
    add('attributes something to a named party on a T4 source');
  }

  return problems;
};

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export interface LedgerProblem {
  claimId: string;
  kind: 'missing_source' | 'quote_not_in_source' | 'quote_too_short' | 'shape';
  detail: string;
}

export interface LedgerReport {
  ok: boolean;
  problems: LedgerProblem[];
  /** Lowest tier supporting each beat, so a weakly-sourced beat is visible. */
  tierByBeat: Record<string, SourceTier | null>;
  claimsByBeat: Record<string, number>;
}

/**
 * Check every claim against the corpus it says it came from.
 *
 * Deterministic end to end: no model is consulted here. Anything this rejects
 * is rejected on evidence rather than on judgement, which is what makes it safe
 * to run as a hard gate.
 */
export const checkLedger = (claims: Claim[], sources: Source[]): LedgerReport => {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const problems: LedgerProblem[] = [];
  const tiersByBeat = new Map<string, SourceTier[]>();
  const claimsByBeat: Record<string, number> = {};

  for (const claim of claims) {
    claimsByBeat[claim.beatId] = (claimsByBeat[claim.beatId] ?? 0) + 1;

    const source = byId.get(claim.sourceId);
    if (!source) {
      // Should be impossible, since sources only exist by fetching - but if it
      // ever happens it means a claim invented its own reference, and that has
      // to be loud rather than skipped.
      problems.push({
        claimId: claim.id,
        kind: 'missing_source',
        detail: `cites source "${claim.sourceId}" which is not in the corpus`,
      });
      continue;
    }

    const located = locateQuote(source.text, claim.quote);
    if (!located.found) {
      problems.push({
        claimId: claim.id,
        kind: located.reason === 'too_short' ? 'quote_too_short' : 'quote_not_in_source',
        detail:
          located.reason === 'too_short'
            ? `quote is under ${MIN_QUOTE_CHARS} characters, which proves nothing`
            : `quote does not occur in ${source.url}`,
      });
      continue;
    }

    for (const p of checkClaimShape(claim, source)) {
      problems.push({ claimId: p.claimId, kind: 'shape', detail: p.problem });
    }

    const list = tiersByBeat.get(claim.beatId) ?? [];
    list.push(source.tier);
    tiersByBeat.set(claim.beatId, list);
  }

  const tierByBeat: Record<string, SourceTier | null> = {};
  for (const [beat, tiers] of tiersByBeat) tierByBeat[beat] = weakestTier(tiers);

  return { ok: problems.length === 0, problems, tierByBeat, claimsByBeat };
};

/** Beats that fall short of the format's per-beat claim floor. */
export const beatsBelowClaimFloor = (
  claimsByBeat: Record<string, number>,
  floors: Record<string, number>
): string[] =>
  Object.entries(floors)
    .filter(([beatId, floor]) => floor > 0 && (claimsByBeat[beatId] ?? 0) < floor)
    .map(([beatId]) => beatId);
