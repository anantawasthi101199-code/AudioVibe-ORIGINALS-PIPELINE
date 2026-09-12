/**
 * The gate. Everything an episode has to pass before it can be published.
 *
 * FAILS CLOSED. A check that cannot run is a check that did not pass. That is
 * the opposite of how the platform's own content-safety code behaves, and the
 * difference is deliberate: there, a failing check must not cost a human their
 * upload, because the alternative is that safety code gets switched off. Here,
 * nobody is waiting and nothing is lost by not publishing, so the cautious
 * direction is the cheap one.
 *
 * NONE OF THESE JUDGES IS THE WRITER. The factuality verdicts come from a
 * different model family, and everything else here is deterministic arithmetic
 * over the script and the ledger. A model is never asked "is this good".
 */
import { EpisodeFormat } from '../formats/schema';
import { Persona } from '../canon/schema';
import { beatsBelowClaimFloor, Claim, LedgerReport } from '../evidence/claim';
import { VerificationReport } from '../evidence/verify';
import { CounterEvidence } from '../evidence/research';
import { Script, fullText } from '../script/write';
import { checkStyle, StyleMeasurement, vocabularyOverlap } from '../script/style';
import { ContinuityReport } from '../fiction/continuity';
import { checkSpeakability } from '../script/speakable';
import { withoutTags } from '../script/dialogue';

export interface GateFinding {
  check: string;
  detail: string;
  blocking: boolean;
}

export interface GateReport {
  passed: boolean;
  findings: GateFinding[];
  measurement: StyleMeasurement;
  /** Requires a human before publishing, even when nothing is blocking. */
  needsHumanReview: boolean;
  humanReviewReasons: string[];
}

/**
 * How much distinctive vocabulary two episodes may share before it reads as the
 * same episode twice.
 *
 * Applied within the network AND against the platform's catalogue. Within, it
 * stops five shows converging on one register, which they will, because they
 * share a model. Against, it stops the studio covering ground a real creator
 * has already covered well - which is how you lose that creator, and no
 * engagement number makes that a good trade.
 */
export const MAX_VOCABULARY_OVERLAP = 0.45;

/** Duration may drift this far from the format target before it is a problem. */
export const DURATION_TOLERANCE = 0.2;

export interface GateInput {
  persona: Persona;
  format: EpisodeFormat;
  script: Script;
  claims: Claim[];
  ledger: LedgerReport;
  verification: VerificationReport;
  counterEvidence: CounterEvidence[];
  durationS: number;
  /** Prior scripts to compare against: the network's own, and the platform's. */
  priorTexts?: Array<{ label: string; text: string }>;
  /**
   * Continuity, for a fiction show. Required when persona.fiction is set.
   *
   * Required rather than optional-with-a-default for the same reason the whole
   * gate fails closed: a fiction episode arriving without a continuity report
   * has not been checked, and treating that as "nothing to report" is exactly
   * the shape of failure this file exists to refuse.
   */
  continuity?: ContinuityReport;
}

export const runGate = (input: GateInput): GateReport => {
  const findings: GateFinding[] = [];
  const humanReviewReasons: string[] = [];
  const add = (check: string, detail: string, blocking = true) =>
    findings.push({ check, detail, blocking });

  // WHICH GROUND TRUTH THIS EPISODE ANSWERS TO.
  //
  // Fiction skips sections 1 to 4 entirely - there is no source to bind an
  // invented scene to, and a verifier asked whether a made-up sentence is
  // entailed by a document has been given a question with no answer. What
  // replaces them is section 4b: continuity against the series bible, which is
  // the same discipline (the prose is answerable to something outside itself)
  // pointed at a different ground truth.
  //
  // Everything from section 5 down applies to both, unchanged. Style, self
  // similarity and duration are properties of the audio, not of how it was
  // sourced, and a fiction show that reads like generated prose is exactly as
  // unpublishable as a factual one that does.
  const fiction = input.persona.fiction;

  // --- 1. The ledger. Deterministic, and the cheapest thing to be sure of. ---
  if (!fiction && !input.ledger.ok) {
    for (const p of input.ledger.problems) {
      add('ledger', `${p.claimId}: ${p.detail}`);
    }
  }

  // --- 2. Factuality, from a different model family than the writer. ---
  if (!fiction) {
    for (const v of input.verification.blocking) {
      add('factuality', `${v.claimId} is ${v.verdict}: ${v.reason}`);
    }
  }

  // --- 3. Evidence density. A format's claim floors are not advisory. ---
  const floors = Object.fromEntries(input.format.beats.map((b) => [b.id, b.minClaims]));
  if (!fiction) {
    for (const beatId of beatsBelowClaimFloor(input.ledger.claimsByBeat, floors)) {
      add(
        'evidenceDensity',
        `beat "${beatId}" carries ${input.ledger.claimsByBeat[beatId] ?? 0} claims, below its floor of ${floors[beatId]}`
      );
    }
  }

  // --- 4. Counter-evidence. The check that separates true from one-sided. ---
  const contested = fiction ? [] : input.claims.filter((c) => c.contested);

  // A SHORT MAY NOT CARRY A CONTESTED CLAIM AT ALL.
  //
  // Long formats answer one-sidedness with a required counterpoint beat.
  // Seventy-five seconds cannot hold a steelmanned counterpoint, and cramming
  // one in produces a strawman - which is worse than having none, because it
  // looks like fairness.
  //
  // So the principle is kept the other way round: if a fact needs the other
  // side stating, it does not belong in a short. Shorts carry established
  // specifics, not contested interpretations. Without this rule the short lane
  // would quietly become the one where the show gets to be one-sided.
  if (input.format.kind === 'short' && contested.length) {
    add(
      'shortCarriesContestedClaim',
      `a short may not state a contested claim (${contested.map((c) => c.id).join(', ')}). ` +
        `It has no room for the other side, so it must not need one.`
    );
  }
  const searched = new Set(input.counterEvidence.map((c) => c.claimId));
  for (const claim of contested) {
    if (!searched.has(claim.id)) {
      add(
        'counterEvidence',
        `claim ${claim.id} is marked contested but no disconfirming search was run for it`
      );
    }
  }

  // A contested claim with real counter-evidence must be ACKNOWLEDGED in the
  // script, and no arithmetic can tell whether it was. This is one of the two
  // places a human is genuinely required.
  const withCounterSources = input.counterEvidence.filter((c) => c.sources.length > 0);
  if (withCounterSources.length) {
    humanReviewReasons.push(
      `${withCounterSources.length} contested claim(s) have disconfirming sources; ` +
        `check the script acknowledges them rather than talking past them`
    );
  }

  // --- 4b. Continuity. What fiction answers to instead of evidence. ---
  if (fiction) {
    if (!input.continuity) {
      // Fails closed, like everything else here. A fiction episode arriving
      // without a continuity report has not been checked, and reading that as
      // "nothing to report" is the exact shape of failure this file refuses.
      add(
        'continuityMissing',
        `${input.persona.name} is a fiction show and no continuity check was run. ` +
          `An unchecked episode is an unpublishable one.`
      );
    } else {
      for (const f of input.continuity.blocking) {
        add('continuity', `"${f.established}" (${f.entityName}) - ${f.verdict}: ${f.reason}`);
      }

      // Advisory, because the detector is capitalised words and those are a
      // poor proxy for proper nouns. Worth a human glance all the same: a
      // character who was never introduced is invisible to every other check
      // and obvious the moment somebody reads the list.
      if (input.continuity.unknownEntities.length) {
        add(
          'unknownNames',
          `names not in the series bible: ${input.continuity.unknownEntities.join(', ')}. ` +
            `Either they were introduced this episode, or the writer invented someone twice.`,
          false
        );
      }
    }
  }

  // --- 5. Style. Deterministic; see script/style.ts. ---
  const { measurement, violations } = checkStyle(fullText(input.script), input.persona.styleCard);
  for (const v of violations) {
    add(`style:${v.rule}`, v.detail, v.blocking);
  }

  // --- 5a. Speakability. Whether it can be followed BY EAR. ---
  //
  // Separate from style, because they are different standards. Style asks
  // whether the prose is good; this asks whether it survives being heard once,
  // with no way back. A reader who loses a clause re-reads the line. A listener
  // who loses one has lost the paragraph, because the words keep arriving.
  //
  // It found nothing on the first real episode, which is worth recording: that
  // script was measurably fine by every one of these and still hard to follow.
  // The problem there was structural - no orientation, an argument where a
  // story belonged - and no sentence metric was ever going to see it. This is a
  // floor, not a diagnosis.
  const speech = checkSpeakability(withoutTags(fullText(input.script)));
  for (const problem of speech.problems) {
    add(
      `speakable:${problem.rule}`,
      problem.example ? `${problem.detail} Worst: "${problem.example}"` : problem.detail,
      problem.blocking
    );
  }

  // --- 5b. Beat openers. ---
  //
  // THE FIRST SENTENCE OF A BEAT CARRIES FAR MORE WEIGHT THAN ITS POSITION IN
  // the word count suggests, and sentence-level opener diversity does not see
  // it: four beats opening "Start with the name", "Start with the shape",
  // "Start with the person", "Start with what's dated" is four sentences out of
  // two hundred and forty, which no ratio over the whole script will ever flag.
  //
  // But a listener hears it immediately. It is the audio equivalent of every
  // paragraph starting the same way, and it is one of the most recognisable
  // tells that beats were written separately by the same machine - which is
  // exactly what happened, and exactly what the rest of the design works to
  // hide.
  const openers = input.script.beats
    .map((b) => b.turns[0]?.text ?? '')
    // TWO WORDS, NOT THREE. The real case was "Start with the name", "Start
    // with the shape", "Start with the person", "Start with what's dated" - a
    // three-word window catches three of those and lets the fourth through,
    // which is the one that would make somebody think the check was working.
    // Across ten beats a two-word window is sensitive enough to be useful and
    // still narrow enough that "In 1591" and "In Edinburgh" do not collide.
    .map((t) => t.trim().split(/\s+/).slice(0, 2).join(' ').toLowerCase())
    .filter(Boolean);

  const openerCounts = new Map<string, number>();
  for (const opener of openers) openerCounts.set(opener, (openerCounts.get(opener) ?? 0) + 1);

  const repeatedOpeners = [...openerCounts].filter(([, n]) => n > 1);
  if (repeatedOpeners.length) {
    add(
      'beatOpeners',
      `${repeatedOpeners.map(([o, n]) => `"${o}..." opens ${n} beats`).join(', ')}. ` +
        `A listener hears a repeated beat opening immediately, and it is the clearest ` +
        `sign the beats were written separately by the same machine.`
    );
  }

  // --- 6. Self-similarity. ---
  for (const prior of input.priorTexts ?? []) {
    const overlap = vocabularyOverlap(fullText(input.script), prior.text);
    if (overlap > MAX_VOCABULARY_OVERLAP) {
      add(
        'selfSimilarity',
        `shares ${(overlap * 100).toFixed(0)}% of its distinctive vocabulary with ${prior.label}`
      );
    }
  }

  // --- 7. Duration against the format. ---
  const [lo, hi] = input.format.targetSeconds;
  const min = lo * (1 - DURATION_TOLERANCE);
  const max = hi * (1 + DURATION_TOLERANCE);
  if (input.durationS < min || input.durationS > max) {
    add(
      'duration',
      `runs ${Math.round(input.durationS)}s, outside the ${Math.round(min)}-${Math.round(max)}s the format allows`
    );
  }

  // --- 8. Risk tier. A show does not get a topic it is not cleared for. ---
  //
  // WHAT THIS IS ACTUALLY PROTECTING AGAINST: a claim about a LIVING named
  // person, which is where the legal and ethical exposure is and where T1/T2
  // sourcing plus full human review are non-negotiable.
  //
  // It cannot tell living from dead, because nothing in a claim says which. So
  // a show whose whole method is attributing statements to named people in
  // court records - a history show - has to be cleared for `named_person` or it
  // can never publish anything. Dead Reckoning failed on this with thirty-seven
  // claims about people who died in 1591.
  //
  // The protection does not disappear, it moves to where it can be expressed:
  // the persona's taboos, which say in words that the show covers no living
  // people, and which the beat critique enforces on every draft. A rule a
  // person writes and a model is held to beats a rule arithmetic cannot state.
  //
  // Skipped for fiction, which has no claims to tier.
  const riskyTypes = new Set(['attribution']);
  const hasNamedPersonClaims = !fiction && input.claims.some((c) => riskyTypes.has(c.type));
  if (hasNamedPersonClaims && !input.persona.allowedRiskTiers.includes('named_person')) {
    add(
      'riskTier',
      `contains claims attributed to named parties, which ${input.persona.name} is not cleared for`
    );
  }

  // The second place a human is genuinely required: anything resting on the
  // weakest sources. Not blocking, because a well-framed T4 anecdote is
  // legitimate - but somebody has to have looked at the framing.
  const weakBeats = fiction
    ? []
    : Object.entries(input.ledger.tierByBeat)
        .filter(([, tier]) => tier === 'T4')
        .map(([beat]) => beat);
  if (weakBeats.length) {
    humanReviewReasons.push(
      `beat(s) ${weakBeats.join(', ')} rest on T4 sources; check they are narrated as one ` +
        `person's account rather than as fact`
    );
  }

  return {
    passed: !findings.some((f) => f.blocking),
    findings,
    measurement,
    needsHumanReview: humanReviewReasons.length > 0,
    humanReviewReasons,
  };
};

/** A short, readable summary for a terminal. */
export const formatGateReport = (report: GateReport): string => {
  const lines: string[] = [];
  lines.push(report.passed ? 'GATE: passed' : 'GATE: FAILED');

  const blocking = report.findings.filter((f) => f.blocking);
  const advisory = report.findings.filter((f) => !f.blocking);

  if (blocking.length) {
    lines.push('', 'Blocking:');
    for (const f of blocking) lines.push(`  [${f.check}] ${f.detail}`);
  }
  if (advisory.length) {
    lines.push('', 'Advisory:');
    for (const f of advisory) lines.push(`  [${f.check}] ${f.detail}`);
  }
  if (report.needsHumanReview) {
    lines.push('', 'Needs a human before publishing:');
    for (const r of report.humanReviewReasons) lines.push(`  - ${r}`);
  }

  const m = report.measurement;
  lines.push(
    '',
    `Prose: ${m.words} words, ${m.sentences} sentences, mean ${m.sentenceWordsMean.toFixed(1)} ` +
      `(sd ${m.sentenceWordsStdDev.toFixed(1)}), hedges ${m.hedgesPer100Words.toFixed(1)}/100w`
  );

  return lines.join('\n');
};
