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
  /**
   * Worth seeing, but not worth refusing the episode over.
   *
   * ADDED BECAUSE A SHAPE RULE IS NOT ALWAYS A BREAK. A quotation claim that
   * reproduces two spans and can prove one of them is imperfect provenance and
   * the sentence is still true; a quotation claim that can prove none of them
   * is a made-up quote. Those are different events and used to be the same
   * finding, so the second was invisible among the first.
   */
  advisory?: boolean;
}

/**
 * The spans a claim presents as somebody's actual words.
 *
 * WHY THIS IS NOT A SLICE FROM THE FIRST QUOTE MARK, which is what it was, and
 * which failed on real claims in both directions:
 *
 *   FALSE FAILURE. "Enki's messengers were told to mimic Ereshkigal's cries"
 *   quotes nothing at all, but the apostrophe in "Enki's" was read as an
 *   opening quotation mark, so the check compared "'s messengers were told to
 *   mimic..." against the source and of course did not find it.
 *
 *   FALSE FAILURE, AGAIN. "...ends with lines praising Ereshkigal: 'Holy
 *   Ereshkigal! Great is your renown!'" is a correct claim whose words are in
 *   the quote verbatim, and it failed because the slice kept the leading
 *   apostrophe and `normaliseForMatch` does not strip quote marks. The compared
 *   string began with a character the source does not have.
 *
 *   MISSED FAILURE. A claim quoting two spans was judged on the first thirty
 *   characters of the first one, so the second could be unsupported and nothing
 *   looked at it. That is the case worth catching and it was the one being
 *   skipped.
 *
 * So: find every span, test each one, and never treat a possessive as a quote.
 * A single-quoted span has to be delimited like a quotation - opened at a
 * boundary, closed before one - which is what separates 'neither male nor
 * female' from Enki's.
 */
export const quotedSpans = (text: string): string[] => {
  const spans: string[] = [];
  const push = (raw: string | undefined): void => {
    const span = normaliseForMatch((raw ?? '').replace(/["'“”‘’]/g, ' '));
    // Two words is the floor. One quoted word is a term of art far more often
    // than it is a quotation, and it would match almost any document by chance.
    if (span.split(' ').filter(Boolean).length >= 2) spans.push(span);
  };

  for (const m of text.matchAll(/[“"]([^“”"]{2,400})[”"]/g)) push(m[1]);
  // A single-quoted run: the opener sits at the start or after a space, colon
  // or bracket, and the closer is followed by whitespace, punctuation or the
  // end. A possessive fails both halves.
  for (const m of text.matchAll(/(?:^|[\s:([])['‘]([^'’]{2,400})['’](?=$|[\s.,;:!?)\]])/g)) push(m[1]);

  return spans;
};

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
  // A QUOTATION THAT QUOTES NOTHING IS AN ATTRIBUTION, and this is the same
  // argument as the statistic below, on a much larger scale.
  //
  // The extraction prompt already says, in capitals, TYPE IT "quotation" ONLY IF
  // THE CLAIM REPRODUCES THE QUOTED WORDING, with a worked example of the
  // difference. It does not work: across three runs of one topic, twelve of
  // forty-six, twelve of forty-nine and six of forty-three claims came back typed
  // `quotation` with no quoted span anywhere in them. A quarter of the ledger,
  // every run, reported as a fault on a report meant to be read.
  //
  // Nothing is wrong with those claims. "The pamphlet says the tortures were
  // described with relish" is a perfectly good assertion bound to a perfectly
  // good quote; it is simply an attribution that got the wrong label. So the
  // label is corrected, deterministically, and the findings list stops being a
  // quarter noise - which matters because a list somebody learns to skim is a
  // list that hides the one real forgery in it.
  //
  // THE RULE STILL BITES WHERE IT MATTERS. A claim that DOES present quoted words
  // keeps its type, and if those words are not in the quote it still fails. That
  // is a quote nobody said, and it is the failure the rule was written for.
  if (claim.type === 'quotation' && quotedSpans(claim.text).length === 0) {
    return { ...claim, type: 'attribution' };
  }

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
    // The claim is meant to reproduce words, so it should contain them, and
    // every span it presents as words should be in the quote. See quotedSpans
    // for the three ways the previous version of this got it wrong.
    const spans = quotedSpans(claim.text);
    const inQuote = normaliseForMatch(claim.quote);

    if (!spans.length) {
      // Nothing is presented as words at all, so this is a typing mistake
      // rather than a provenance failure. Advisory: the sentence may be
      // perfectly well supported, it just is not a quotation.
      problems.push({
        claimId: claim.id,
        problem: 'typed as a quotation but quotes nothing. Retype it or quote the words.',
        advisory: true,
      });
    } else {
      const missing = spans.filter((s) => !inQuote.includes(s));
      if (missing.length) {
        problems.push({
          claimId: claim.id,
          problem:
            `quotes ${missing.length} span(s) the supporting quote does not contain, ` +
            `starting "${missing[0]!.slice(0, 60)}"`,
          // Blocking only when NOTHING it quotes can be proved. One unsupported
          // span among several is bad provenance on a sentence that is probably
          // true; none supported is a quote nobody said.
          advisory: missing.length < spans.length,
        });
      }
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
  /** Worth seeing, but not worth refusing the episode over. See ShapeProblem. */
  advisory?: boolean;
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
      problems.push({ claimId: p.claimId, kind: 'shape', detail: p.problem, advisory: p.advisory });
    }

    const list = tiersByBeat.get(claim.beatId) ?? [];
    list.push(source.tier);
    tiersByBeat.set(claim.beatId, list);
  }

  const tierByBeat: Record<string, SourceTier | null> = {};
  for (const [beat, tiers] of tiersByBeat) tierByBeat[beat] = weakestTier(tiers);

  // ADVISORIES DO NOT MAKE A LEDGER NOT-OK. The gate reads `ok` to decide
  // whether to report the ledger, so counting advisories here would let a
  // note-to-self block an episode through the back door, which is the opposite
  // of what marking it advisory meant.
  return {
    ok: !problems.some((p) => !p.advisory),
    problems,
    tierByBeat,
    claimsByBeat,
  };
};

/** Beats that fall short of the format's per-beat claim floor. */
export const beatsBelowClaimFloor = (
  claimsByBeat: Record<string, number>,
  floors: Record<string, number>
): string[] =>
  Object.entries(floors)
    .filter(([beatId, floor]) => floor > 0 && (claimsByBeat[beatId] ?? 0) < floor)
    .map(([beatId]) => beatId);
