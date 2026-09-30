/**
 * The psychology lane's checks. All free, all deterministic.
 *
 * TWO KINDS, AND THE FIRST KIND IS WHY THIS FILE EXISTS.
 *
 * SAFETY. This is the one subject in the studio where a well-meaning sentence
 * can do real harm to the person listening, and where the listener is, by the
 * nature of the show, quite likely to be having a hard time. Four things are
 * therefore refused by arithmetic rather than asked for in a prompt, because an
 * instruction has failed in this pipeline every single time it was the only
 * thing standing between a writer and a mistake:
 *
 *   telling the listener they HAVE a condition
 *   directing them to start, stop or change a medication or a therapy
 *   promising this can be cured or fixed
 *   covering something crisis-adjacent without pointing at real help
 *
 * CRAFT. The show's identity is a warm second person, one sustained picture,
 * and no unexplained jargon. Those are checkable too, and a script that loses
 * them has quietly become a psychology textbook read aloud.
 *
 * WHAT IS DELIBERATELY NOT CHECKED: small numbers. "Trust the next two
 * minutes", "fifty tabs open", "thirty seconds" are the host's own plain
 * speech, not claims, and a figure check that flagged them would be turned off
 * within a week. Only things shaped like statistics are held to the research.
 */
import { Persona } from '../canon/schema';
import { EpisodeFormat } from '../formats/schema';
import { checkLedger } from '../evidence/claim';
import { Source } from '../evidence/source';
import { GateFinding, GateReport, runGate } from '../qa/gate';
import { aboutThePage } from '../qa/sourceText';
import { Script, WORDS_PER_SECOND, beatText, fullText } from '../script/write';
import { countWords } from '../script/style';
import { Understanding } from './understand';

/** The owner's ceiling for a short. */
export const MAX_SHORT_SECONDS = 180;

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const CONDITIONS =
  'adhd|add|autism|autistic|bipolar|ocd|ptsd|cptsd|depression|depressive disorder|clinical depression|' +
  'anxiety disorder|gad|panic disorder|bpd|borderline personality disorder|schizophrenia|psychosis|' +
  'anorexia|bulimia|binge eating disorder|eating disorder|dyslexia|dyspraxia|narcissistic personality disorder';

/**
 * Words that make a sentence a supposition rather than a diagnosis.
 *
 * "If you have ADHD" and "people who live with ADHD" are the show's ordinary
 * register and must never be blocked. "You have ADHD" is the sentence no
 * podcast may say, however gently it is meant.
 */
const HEDGED = /\b(if|whether|maybe|might|may|could|perhaps|some|many|people|those|anyone|someone|think|wonder|suspect|diagnos)/i;

export const diagnosesListener = (script: string): string[] => {
  const found: string[] = [];
  const pattern = new RegExp(
    `\\byou(?:'re| are| have| ve got| have got)\\b[^.!?]{0,60}?\\b(?:${CONDITIONS})\\b`,
    'gi'
  );
  for (const sentence of script.split(/(?<=[.!?])\s+/)) {
    const hit = sentence.match(pattern);
    if (!hit) continue;
    // The hedge has to come BEFORE the claim in the sentence, which is what
    // makes "if you have ADHD" a supposition and "you have ADHD, if you were
    // wondering" still a diagnosis.
    const before = sentence.slice(0, sentence.indexOf(hit[0]!));
    if (HEDGED.test(before)) continue;
    found.push(hit[0]!.trim());
  }
  return [...new Set(found)];
};

const DRUGS =
  'adderall|ritalin|concerta|vyvanse|elvanse|strattera|methylphenidate|amphetamine|prozac|fluoxetine|' +
  'sertraline|zoloft|citalopram|escitalopram|lexapro|venlafaxine|duloxetine|mirtazapine|lithium|' +
  'xanax|alprazolam|diazepam|valium|lorazepam|propranolol|quetiapine|aripiprazole|ssri|snri|benzodiazepine';

/** Directing treatment, which is a doctor's job and never a podcast's. */
export const directsTreatment = (script: string): string[] => {
  const found: string[] = [];
  const patterns: RegExp[] = [
    // Any named drug at all. Even "some people take Adderall" invites a
    // comparison the show is not qualified to host.
    new RegExp(`\\b(?:${DRUGS})\\b`, 'gi'),
    // Starting, stopping or changing a treatment, however softly put. The
    // inflections matter: the first draft caught "come off" and missed
    // "coming off", which is the way anybody would actually say it.
    /\b(?:start|starting|stop|stopping|com(?:e|ing) off|quit|quitting|increas|reduc|lower|rais|chang|switch|skip)\w*\b[^.!?]{0,30}\b(?:medication|meds|antidepressants?|pills?|dose|dosage|treatment|therapy)\b/gi,
    /\b(?:you|your)\b[^.!?]{0,20}\b(?:need|should get|must get|have to get)\b[^.!?]{0,20}\b(?:medicated|medication|meds|diagnosed|therapy|a therapist)\b/gi,
  ];
  for (const re of patterns) for (const m of script.matchAll(re)) found.push(m[0].trim());
  return [...new Set(found)];
};

/** Promising an outcome nobody can promise. */
export const promisesCure = (script: string): string[] => {
  const found: string[] = [];
  const patterns: RegExp[] = [
    /\b(?:cure|cures|cured|curing)\b[^.!?]{0,40}/gi,
    /\b(?:fix|rewire|reset|heal)\s+your\s+(?:brain|mind|nervous system)\b/gi,
    // BOTH ORDERS. "Gone forever" and "forever gone" are the same promise, and
    // the first version only caught one of them.
    /\b(?:completely|permanently|forever|for good|once and for all)\b[^.!?]{0,30}\b(?:gone|go away|disappear|eliminated|free of|rid of)\b/gi,
    /\b(?:gone|go away|disappear|eliminated|free of|rid of)\b[^.!?]{0,30}\b(?:completely|permanently|forever|for good|once and for all)\b/gi,
    /\b(?:will|guarantee[ds]?|guaranteed to)\b[^.!?]{0,25}\b(?:never feel|never struggle|never experience)\b/gi,
  ];
  for (const re of patterns) for (const m of script.matchAll(re)) found.push(m[0].trim());
  return [...new Set(found)];
};

/**
 * Subjects that must not be covered without pointing at real help.
 *
 * Deliberately narrow and specific. "Abuse" on its own catches "substance
 * abuse" and half the addiction literature, so only the phrases that actually
 * mean somebody is in danger are here.
 */
export const CRISIS =
  /\b(?:suicide|suicidal|kill (?:yourself|themselves|himself|herself)|take your own life|end your life|self-?harm|hurting yourself|cutting yourself|overdose|anorexia|bulimia|purging|eating disorder|psychosis|psychotic|domestic abuse|abusive relationship|childhood abuse|sexual abuse)\b/i;

/** A line that points somebody at a real human being who can help. */
const CARE_LINE =
  /\b(?:talk to|speak to|speak with|reach out to|see|call|contact|tell)\b[^.!?]{0,60}\b(?:doctor|gp|therapist|counsellor|counselor|professional|helpline|crisis line|support line|samaritans|emergency services|someone you trust)\b/i;

export const needsCareLine = (topic: string, script: string): boolean =>
  CRISIS.test(topic) || CRISIS.test(script);

export const hasCareLine = (script: string): boolean => CARE_LINE.test(script);

// ---------------------------------------------------------------------------
// Craft
// ---------------------------------------------------------------------------

/**
 * Terms a listener with no background does not know, and that this show may
 * only use with its plain meaning attached in the same breath.
 *
 * Everyday words a psychology show obviously may say - stress, focus, memory,
 * habit, trauma, burnout - are not here. This is the list of things that make
 * somebody feel talked down to when they arrive unexplained.
 */
export const TRICKY_TERMS = [
  'prefrontal cortex',
  'amygdala',
  'hippocampus',
  'dopamine',
  'serotonin',
  'cortisol',
  'norepinephrine',
  'noradrenaline',
  'neurotransmitter',
  'executive function',
  'executive dysfunction',
  'working memory',
  'dysregulation',
  'emotional regulation',
  'hyperarousal',
  'hypervigilance',
  'neuroplasticity',
  'rumination',
  'dissociation',
  'interoception',
  'limbic system',
  'autonomic nervous system',
  'parasympathetic',
  'sympathetic nervous system',
  'cognitive behavioural therapy',
  'cognitive behavioral therapy',
  'comorbid',
  'rejection sensitive dysphoria',
  'masking',
];

/**
 * How soon after the term the gloss has to START.
 *
 * SHORT ON PURPOSE. The first version looked 160 characters either side, and
 * "This is your amygdala at work" passed because a sentence two lines earlier
 * happened to contain the word "which". A gloss that is not attached to the
 * term is not a gloss; it is a coincidence.
 */
export const GLOSS_WINDOW = 40;

// The separator is `[,\s]+` rather than one character: the commonest gloss in
// the whole show is "dopamine, which is ...", and a pattern that allowed only a
// comma OR a space flagged it as unglossed.
const GLOSS_MARKER =
  /^[,\s]+(?:which|that'?s|that is|the part|the bit|the system|basically|meaning|means|in other words|is when|is the|is basically|is your|or simply|a fancy)/i;

/** Tricky terms used with no plain-words gloss attached to their first use. */
export const unglossedTerms = (script: string): string[] => {
  const lower = script.toLowerCase();
  const bad: string[] = [];
  for (const term of TRICKY_TERMS) {
    const at = lower.indexOf(term);
    if (at === -1) continue;
    const rest = script.slice(at + term.length);

    // "dopamine, which is the chemical that tags what matters"
    if (GLOSS_MARKER.test(rest.slice(0, GLOSS_WINDOW))) continue;

    // THE OTHER ORDER, which is just as good English and just as clear: "the
    // chemical that tags what matters, dopamine, is uneven here". An
    // appositive is a gloss, so the term sitting between two commas counts.
    const before = script.slice(Math.max(0, at - 80), at);
    if (/,\s*$/.test(before) && /^\s*,/.test(rest)) continue;

    bad.push(term);
  }
  return bad;
};

/** Which tricky terms appear at all, for the short's stricter cap. */
export const termsUsed = (script: string): string[] => {
  const lower = script.toLowerCase();
  return TRICKY_TERMS.filter((t) => lower.includes(t));
};

/**
 * Statistics the research does not contain.
 *
 * ONLY THINGS SHAPED LIKE A CLAIM: percentages, counts in the thousands, and
 * "three times more likely". The host's own plain numbers - two minutes, five
 * per cent battery as an image, one or two options - are speech, not evidence,
 * and are left alone. See the header.
 */
export const unsupportedStats = (script: string, research: string): string[] => {
  const haystack = research.replace(/,/g, '');
  const flat = script.replace(/,/g, '');
  const out = new Set<string>();

  const has = (n: number) => {
    for (const m of haystack.matchAll(/\d+(?:\.\d+)?/g)) {
      const k = Number(m[0]);
      if (!Number.isFinite(k)) continue;
      // A tenth either way, so "about 40%" for 38% passes and 60% does not.
      if (Math.abs(k - n) <= 0.1 * Math.max(k, n)) return true;
    }
    return false;
  };

  const claims: RegExp[] = [
    /(\d+(?:\.\d+)?)\s*(?:%|per ?cent)/gi,
    /\b(\d{4,})\b(?=\s+(?:people|adults|children|participants|students|patients))/gi,
    /\b(\d+(?:\.\d+)?)\s*times\s+(?:more|less|as)\b/gi,
    /\b(?:one|two|three|four|five|six|seven|eight|nine)\s+in\s+(\d+)\b/gi,
  ];
  for (const re of claims) {
    for (const m of flat.matchAll(re)) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && !has(n)) out.add(m[0].trim());
    }
  }
  return [...out];
};

/** How often the script says "you". Near zero means it became a lecture. */
export const secondPersonPer100 = (script: string): number => {
  const words = countWords(script);
  if (!words) return 0;
  const hits = script.match(/\b(?:you|your|you're|youre|yourself|you've|you'll)\b/gi)?.length ?? 0;
  return (hits / words) * 100;
};

/** Below this the show has stopped talking to anybody. */
export const SECOND_PERSON_FLOOR = 2.0;

/** The picture has to be built early and landed on at the end. */
export const picturePlacement = (
  script: Script,
  keywords: string[]
): { early: boolean; landed: boolean; uses: number } => {
  const lower = (t: string) => t.toLowerCase();
  const words = keywords.map(lower);
  const all = lower(fullText(script));
  const opening = lower(script.beats.slice(0, 2).map(beatText).join(' '));
  const closing = lower(beatText(script.beats[script.beats.length - 1] ?? { turns: [] }));
  const count = words.reduce((n, w) => n + (all.split(w).length - 1), 0);
  return {
    early: words.some((w) => opening.includes(w)),
    landed: words.some((w) => closing.includes(w)),
    uses: count,
  };
};

// ---------------------------------------------------------------------------
// Put together
// ---------------------------------------------------------------------------

export interface DraftInput {
  topic: string;
  research: string;
  kind: 'short' | 'long';
  keywords?: string[];
  closingBeatId: string;
}

/** What a revision, when one is paid for, would be told to fix. */
export const psychDraftProblems = (
  beats: Array<{ beatId: string; turns: Array<{ text: string }> }>,
  input: DraftInput
): string[] => {
  const text = beats.map((b) => b.turns.map((t) => t.text).join(' ')).join('\n');
  const problems: string[] = [];

  const diagnosed = diagnosesListener(text);
  if (diagnosed.length) problems.push(`tells the listener they have a condition: "${diagnosed.join('", "')}"`);
  const treatment = directsTreatment(text);
  if (treatment.length) problems.push(`treatment or medication direction: "${treatment.join('", "')}"`);
  const cure = promisesCure(text);
  if (cure.length) problems.push(`promises a cure: "${cure.join('", "')}"`);
  if (needsCareLine(input.topic, text) && !hasCareLine(text)) {
    problems.push('this subject needs one warm line pointing at real help, and there is none');
  }

  const unglossed = unglossedTerms(text);
  if (unglossed.length) problems.push(`terms used with no plain explanation: ${unglossed.join(', ')}`);
  if (input.kind === 'short' && termsUsed(text).length > 1) {
    problems.push(`a short may carry one technical term at most, and this has ${termsUsed(text).join(', ')}`);
  }

  const stats = unsupportedStats(text, input.research);
  if (stats.length) problems.push(`statistics the research does not contain: ${stats.join(', ')}`);

  if (secondPersonPer100(text) < SECOND_PERSON_FLOOR) {
    problems.push('it stopped talking to the listener; this show says "you" throughout');
  }

  const last = beats[beats.length - 1];
  if (!last || !/\bfollow\b/i.test(last.turns.map((t) => t.text).join(' '))) {
    problems.push('the last part never asks the listener to follow');
  }

  if (input.kind === 'short' && countWords(text) / WORDS_PER_SECOND > MAX_SHORT_SECONDS - 10) {
    problems.push(`about ${Math.round(countWords(text) / WORDS_PER_SECOND)}s read aloud, over a short's budget`);
  }
  return problems;
};

export interface PsychGateInput {
  persona: Persona;
  format: EpisodeFormat;
  script: Script;
  topic: string;
  sources: Source[];
  /** The understanding plus the source text, which is what the script may draw on. */
  research: string;
  understanding?: Understanding;
  durationS: number;
  measured: boolean;
  priorTexts?: Array<{ label: string; text: string }>;
  stagesOff?: string[];
}

export const psychGate = (input: PsychGateInput): GateReport => {
  const text = fullText(input.script);

  const base = runGate({
    persona: input.persona,
    format: input.format,
    script: input.script,
    claims: [],
    ledger: checkLedger([], input.sources),
    verification: { results: [], blocking: [], costPence: 0, verifierModel: '' },
    counterEvidence: [],
    durationS: input.durationS,
    priorTexts: input.priorTexts,
    corpusText: input.research,
    castNames: [],
    stagesOff: input.stagesOff,
    evidence: 'reference',
    // A REAL CHECK RAN, so this says so truthfully. What the reference review
    // is on the story lane, the safety and craft checks below are here.
    referenceReview: { checked: true, unanswered: [], unsupported: [] },
    sources: input.sources,
  });

  const findings: GateFinding[] = [...base.findings];
  const humanReviewReasons = [...base.humanReviewReasons];
  const add = (check: string, detail: string, blocking = true) =>
    findings.push({ check, detail, blocking });

  // --- Safety ---------------------------------------------------------------
  for (const said of diagnosesListener(text)) {
    add(
      'psychDiagnosis',
      `"${said}" tells the listener they have a condition. This show explains an experience ` +
        `many people have; it never diagnoses anybody, and a listener who takes that sentence ` +
        `literally has been given a diagnosis by a podcast.`
    );
  }
  for (const said of directsTreatment(text)) {
    add(
      'psychTreatment',
      `"${said}" names or directs a treatment. Medication and therapy decisions belong to the ` +
        `listener and their doctor, and this show may only say that a professional is who to ask.`
    );
  }
  for (const said of promisesCure(text)) {
    add('psychCure', `"${said}" promises an outcome nobody can promise.`);
  }
  if (needsCareLine(input.topic, text) && !hasCareLine(text)) {
    add(
      'psychCare',
      `this episode touches something serious and never points at real help. One warm, ` +
        `undramatic line naming a doctor, a therapist or a helpline is required.`
    );
  }

  // --- Craft ----------------------------------------------------------------
  const unglossed = unglossedTerms(text);
  if (unglossed.length) {
    add(
      'psychJargon',
      `used with no plain-words explanation beside it: ${unglossed.join(', ')}. Every term this ` +
        `show cannot avoid gets its meaning in the same breath, the first time.`
    );
  }
  const used = termsUsed(text);
  if (input.format.kind === 'short' && used.length > 1) {
    add('psychJargon', `a short carries one technical term at most, and this has ${used.join(', ')}.`);
  }

  const stats = unsupportedStats(text, input.research);
  if (stats.length) {
    add(
      'psychStats',
      `the script states ${stats.join(', ')}, and the research behind it does not. A figure a ` +
        `listener repeats to somebody else has to be real.`
    );
  }

  const you = secondPersonPer100(text);
  if (you < SECOND_PERSON_FLOOR) {
    add(
      'psychSecondPerson',
      `says "you" ${you.toFixed(1)} times per 100 words, under the ${SECOND_PERSON_FLOOR} floor. ` +
        `It has become a lecture about people rather than a conversation with one.`
    );
  }

  if (input.understanding && input.format.kind !== 'short') {
    const place = picturePlacement(input.script, input.understanding.picture.keywords);
    if (!place.early || !place.landed) {
      add(
        'psychPicture',
        `the episode is built on "${input.understanding.picture.name}" and ` +
          `${!place.early ? 'never builds it early on' : 'never comes back to it at the end'}. ` +
          `The callback is what a listener still has a week later.`,
        false
      );
      humanReviewReasons.push(
        `the picture this episode was built on is not ${place.early ? 'landed at the end' : 'set up at the start'}`
      );
    }
  }

  const page = aboutThePage(text);
  if (page) add('psychMeta', `"${page}" talks about the reading instead of explaining the subject.`);

  const closing = input.script.beats[input.script.beats.length - 1];
  if (!closing || !/\bfollow\b/i.test(beatText(closing))) {
    add('psychOutro', 'the last part never asks the listener to follow the show.');
  }

  if (input.format.kind === 'short' && input.durationS > MAX_SHORT_SECONDS) {
    add(
      'psychLength',
      `${input.measured ? 'runs' : 'would run about'} ${Math.round(input.durationS)}s. A short is under three minutes.`
    );
  }

  return {
    ...base,
    passed: !findings.some((f) => f.blocking),
    findings,
    needsHumanReview: base.needsHumanReview || humanReviewReasons.length > base.humanReviewReasons.length,
    humanReviewReasons,
  };
};

export const estimatedSeconds = (script: Script): number =>
  countWords(fullText(script)) / WORDS_PER_SECOND;
