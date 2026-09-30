/**
 * The case file: one document read whole, turned into something tellable.
 *
 * THE THIRD LANE, AND IT EXISTS BECAUSE A CASE IS NOT A MYTH AND NOT A SUBJECT.
 *
 *   extensive   many documents, a claim ledger, a quote bound to each claim.
 *               For a subject ASSEMBLED from sources.
 *   single      two or three documents fused into one reference article.
 *               For a story that already exists whole, told many times.
 *   casefile    ONE document, read whole, turned into a chronology, a cast and
 *               a set of places. For something that HAPPENED, to real people,
 *               on particular dates.
 *
 * WHAT A CASE NEEDS THAT A MYTH DOES NOT.
 *
 * DATES. A myth has an order; a case has a calendar, and the difference between
 * "later" and "eleven days later" is most of what makes a case frightening. The
 * chronology here is the spine of the episode and is built before a word of
 * script exists, so the writer is never reconstructing a sequence from prose.
 *
 * BACKGROUNDS. A myth's cast can be a name and a role. A case's cannot: a
 * listener has to know who somebody was before the thing happened to them, or
 * it is a name in a report rather than a person. Every carried name gets a
 * background, and the victim gets one first.
 *
 * PLACES YOU CAN SEE. This is heard, with nothing on screen, so a place is
 * whatever one physical detail the document actually gives. Not "a quiet
 * suburb" - the kind of thing the reporting really recorded, a road that
 * flooded every spring, a shop that shut at six.
 *
 * AND THE ONE THAT REVERSES A RULE FROM THE MYTH LANE. There, `variants` are
 * resolved and HIDDEN from the writer, because one contested claim ate half an
 * episode in hedging. Here `contested` is resolved and SHOWN, because these are
 * real people and stating a disputed claim as fact is not a style problem, it
 * is defamation. The instruction changes with it: say it once, plainly, in the
 * one place it belongs, and never hedge the rest of the episode around it.
 *
 * ONE SOURCE, WHICH IS A REAL LIMIT AND IS STATED AS ONE. A single document
 * carries its own errors and its own framing straight through, and nothing here
 * can see that. The gate says so, `--reference-check` reads the file back
 * against the document it came from, and neither of those makes one source into
 * two. This lane is for cases that have been reported properly once, not for
 * breaking news and not for anything contested enough to need a second reading.
 */
import { z } from 'zod';
import { completeJson, LlmClient } from '../models/client';
import { Source } from './source';

/**
 * How much of the document the case file is built from.
 *
 * The whole thing, up to a ceiling, for the reason the myth lane reads its
 * sources whole: a keyhole loses whatever did not match the query wording, and
 * in a case that is usually the part that explains why anybody did anything.
 */
export const CASE_CHARS = 120_000;

/**
 * Names a listener is asked to carry.
 *
 * SIX, WHICH IS MORE THAN THE MYTH LANE ALLOWS AND LESS THAN A CASE CONTAINS. A
 * real investigation touches dozens of people and a listener holds about this
 * many. The rest are named once where they act, or replaced by what they did:
 * "the officer who took the call" is clearer than a name nobody will keep.
 */
export const MAX_CARRY = 6;

export const roleSchema = z.enum([
  'victim',
  'accused',
  'convicted',
  'investigator',
  'witness',
  'family',
  'other',
]);

export const personSchema = z.object({
  name: z.string().min(1),
  role: roleSchema,
  /** Who they are in one clause, in ordinary words. */
  who: z.string().min(1),
  /**
   * Who they were before any of this, in a sentence or two.
   *
   * THE FIELD THAT DECIDES WHETHER THIS IS A PERSON OR A CASE NUMBER, and the
   * one a listener remembers. What they did for work, what they were like, what
   * they were doing that week. Empty is allowed and is itself information: a
   * document that records nothing about a victim beyond their name has told you
   * something about the reporting.
   */
  background: z.string().default(''),
  /** Whether the listener has to carry this name or can meet it once. */
  carry: z.boolean().default(false),
});

export const eventSchema = z.object({
  /**
   * When, as precisely as the document says and no more.
   *
   * "14 March 1987", "the spring of 1987", "eleven days later". NEVER a date
   * the document does not give. An invented date in a true story is the single
   * easiest way for this lane to publish something false.
   */
  when: z.string().min(1),
  /** What happened, in one or two plain sentences. */
  what: z.string().min(1),
  /** Where, if the document says. */
  where: z.string().default(''),
  /** Names involved, as they appear in the cast. */
  who: z.array(z.string()).default([]),
  /**
   * Whether this event is established or only alleged.
   *
   * Carried per event rather than per case, because a chronology usually mixes
   * them: the call was made at 9pm and that is a record; what was said on it is
   * one person's account. The writer is told which is which and must not blur
   * them.
   */
  certainty: z.enum(['established', 'alleged', 'disputed']).default('established'),
});

export const placeSchema = z.object({
  name: z.string().min(1),
  /**
   * One physical detail the document actually records.
   *
   * NOT AN ATMOSPHERE. "A quiet suburb" is the writer's imagination and is
   * exactly what this field exists to prevent. What the reporting really noted:
   * the road that flooded, the shop that shut at six, how long the walk took.
   * Empty rather than invented.
   */
  picture: z.string().default(''),
});

export const caseFileSchema = z.object({
  /** The case as it should be named out loud. */
  caseName: z.string().min(1),
  /** The whole thing in one sentence, decided before any of it is told. */
  oneLine: z.string().min(1),
  /**
   * The most arresting TRUE detail in the document, for the first line.
   *
   * A true crime episode opens in the middle of something, and the thing it
   * opens on has to be a fact rather than a mood. This is that fact, chosen
   * once, here, so the writer is not hunting for an opening in its own prose.
   */
  hook: z.string().min(1),
  /** What a listener needs to know for any of it to make sense. */
  context: z.array(z.string()).default([]),
  cast: z.array(personSchema).default([]),
  places: z.array(placeSchema).default([]),
  /** Every dated event, in the order it happened. The spine. */
  chronology: z.array(eventSchema).default([]),
  /** What investigators did, in order. Separate from the crime's own timeline. */
  investigation: z.array(z.string()).default([]),
  outcome: z.object({
    status: z.enum(['convicted', 'acquitted', 'unsolved', 'overturned', 'disputed', 'ongoing']),
    /** What actually happened in the end, plainly. */
    what: z.string().min(1),
    when: z.string().default(''),
  }),
  /**
   * What is disputed, and what the dispute is.
   *
   * SHOWN TO THE WRITER, unlike the myth lane's `variants`, and the reversal is
   * deliberate. There, hiding the disagreement stopped an episode hedging. Here
   * these are claims about real people, and presenting a contested claim as
   * settled is not a style fault. It is the fault this whole lane has to avoid.
   */
  contested: z.array(z.object({ claim: z.string(), whoSays: z.string(), why: z.string() })).default([]),
  /**
   * What the record does not say.
   *
   * KEPT AND USED, because in a case the gap is often the story, and a narrator
   * who says "nobody ever established where he was that afternoon" is more
   * trustworthy and more interesting than one who glides over it.
   */
  unknown: z.array(z.string()).default([]),
  sourceIds: z.array(z.string()).default([]),
});

export type CaseFile = z.infer<typeof caseFileSchema>;
export type CasePerson = z.infer<typeof personSchema>;

const CASE_SYSTEM = `You are building a case file from one piece of reporting, for an audio episode about a real crime.

You are not writing the episode. You are reading the document and setting down what happened, in order, with who was involved and where, so that somebody else can tell it.

THIS IS ABOUT REAL PEOPLE, AND THAT GOVERNS EVERYTHING BELOW.

WHAT YOU MAY NOT DO, IN ORDER OF HOW BADLY IT GOES WRONG.

1. DO NOT INVENT A DATE. If the document says "later that spring", write "later that spring". A date that is not in the document is the easiest way for a true story to become false, and it will not be caught downstream.
2. DO NOT PRESENT AN ALLEGATION AS A FACT. Mark every event as established, alleged or disputed. A confession that was later retracted is not a fact about what happened; it is a fact about what was said.
3. DO NOT INVENT ATMOSPHERE. "A quiet street where nothing ever happened" is a sentence about your assumptions. Only record physical detail the document gives.
4. DO NOT FILL A GAP. If the document does not say why somebody did something, that belongs in the unknown list, not in a motive you supplied.

WHOSE STORY THIS IS. The victim's. Put their background in first and make it a real one - who they were, what they did, what they were like - because a listener who does not know that is hearing about a case number. The person who did it gets what the record supports and no more, and never admiration, style or a nickname the reporting itself did not use.

THE CHRONOLOGY IS THE SPINE. Every dated event, in the order it happened, including the ordinary ones before anything went wrong. A case is frightening in proportion to how normal the week before it was, and a chronology that starts at the crime has thrown that away.

KEEP THE INVESTIGATION SEPARATE from the crime's own timeline. They are two sequences and blurring them is how a listener loses track of what was known when.

NAMES. At most ${MAX_CARRY} people marked carry. Everybody else is named once where they act, or described by what they did. A listener holds about six names and an investigation touches dozens.

PLACES. Only what the document records. A place with no recorded detail gets an empty picture, which is honest, rather than a sentence you made up, which is not.

HARVEST EVERY PHYSICAL DETAIL THE DOCUMENT GIVES YOU, and put it in. This file is the ONLY thing the writer will see - it never reads the document - so a detail you leave out is a detail that cannot reach the episode, and the episode will be abstract because of it.

What counts: the time of day, the weather, what somebody was wearing or carrying, how far apart two places were, how long a walk took, what a room had in it, what was found where, what the light was like, what somebody was doing when they were interrupted. Put it in the event it belongs to, in its "what" field, in the plain words the document uses.

This is the opposite of inventing atmosphere and the two are easy to confuse. "A quiet street where nothing ever happened" is invention. "The only thing open after six was the petrol station" is harvesting, IF the document says so. The test is the same one every time: could you point at the sentence in the document that this came from.`;

const RETURN_SHAPE = `Return ONLY this JSON object.

{
  "caseName": "how the case should be named out loud",
  "oneLine": "the whole thing in one sentence",
  "hook": "the single most arresting TRUE detail, for the first line of the episode",
  "context": ["what a listener needs to know first", "..."],
  "cast": [
    {"name": "...", "role": "victim|accused|convicted|investigator|witness|family|other",
     "who": "one clause", "background": "who they were before any of this", "carry": true}
  ],
  "places": [{"name": "...", "picture": "one physical detail the document records, or empty"}],
  "chronology": [
    {"when": "as precisely as the document says", "what": "...", "where": "...",
     "who": ["..."], "certainty": "established|alleged|disputed"}
  ],
  "investigation": ["what investigators did, in order"],
  "outcome": {"status": "convicted|acquitted|unsolved|overturned|disputed|ongoing",
              "what": "what happened in the end", "when": "..."},
  "contested": [{"claim": "...", "whoSays": "who says it", "why": "why it is disputed"}],
  "unknown": ["what the record does not say"]
}`;

export interface BuildCaseInput {
  topic: string;
  source: Source;
  /** Seconds of audio this has to fill, so the file is sized to the episode. */
  targetSeconds: number;
}

/**
 * Read one document and set down the case.
 *
 * ONE CALL, AND IT IS THE EXPENSIVE ONE. Roughly thirty pence against an
 * episode budget of a pound, which buys the thing the writer cannot do for
 * itself: a chronology it did not have to reconstruct from prose, and a cast it
 * did not have to decide the importance of while also writing sentences.
 */
export const buildCaseFile = async (
  input: BuildCaseInput,
  model: LlmClient,
  onCost?: (pence: number) => void
): Promise<CaseFile> => {
  const text = input.source.text.slice(0, CASE_CHARS);
  const minutes = Math.round(input.targetSeconds / 60);

  const prompt = `THE CASE: ${input.topic}

This has to carry about ${minutes} minutes of audio, so the chronology needs enough events to tell that long without padding, and each one needs enough detail to be said out loud.

THE DOCUMENT
Title: ${input.source.title}
${input.source.url}

${text}

${RETURN_SHAPE}`;

  const reply = await completeJson<unknown>(
    model,
    {
      system: CASE_SYSTEM,
      prompt,
      // The document can be 120,000 characters and the answer is a structured
      // file. Room for both the reading and the thinking.
      maxTokens: 24_000,
      effort: 'medium',
      cacheSystem: true,
      // Near zero. This is transcription and ordering, not invention, and every
      // degree of wandering here is a fact that drifts.
      temperature: 0.2,
    },
    onCost
  );

  const file = caseFileSchema.parse(reply);
  return { ...file, sourceIds: [input.source.id] };
};

/**
 * The case file as the writer sees it.
 *
 * ORDERED THE WAY AN EPISODE IS BUILT, not the way the object is declared: the
 * hook first because it is the first line, then who this is about, then the
 * calendar, then what was and was not established. A writer reads this top to
 * bottom once.
 */
export const renderCaseFile = (file: CaseFile): string => {
  const lines: string[] = [];

  lines.push(`THE CASE: ${file.caseName}`);
  lines.push(`IN ONE SENTENCE: ${file.oneLine}`);
  lines.push('');
  lines.push(`OPEN ON THIS. It is true and it is the most arresting thing here:`);
  lines.push(`  ${file.hook}`);

  if (file.context.length) {
    lines.push('');
    lines.push('WHAT A LISTENER NEEDS FIRST');
    for (const c of file.context) lines.push(`  - ${c}`);
  }

  const carried = file.cast.filter((p) => p.carry);
  const texture = file.cast.filter((p) => !p.carry);

  if (carried.length) {
    lines.push('');
    lines.push('THE PEOPLE TO CARRY. Use these names repeatedly and remind the listener who');
    lines.push('they are. Give the victim their background before anything happens to them.');
    for (const p of carried) {
      lines.push(`  ${p.name} (${p.role}): ${p.who}`);
      if (p.background) lines.push(`      ${p.background}`);
    }
  }

  if (texture.length) {
    lines.push('');
    lines.push('NAMED ONCE, OR NOT AT ALL. Say what they did rather than asking the listener');
    lines.push('to hold a name they will not need again.');
    for (const p of texture) lines.push(`  ${p.name} (${p.role}): ${p.who}`);
  }

  const seen = file.places.filter((p) => p.picture);
  if (seen.length) {
    lines.push('');
    lines.push('PLACES, AND THE ONE DETAIL THE REPORTING ACTUALLY RECORDS. Use these. Do not');
    lines.push('add any others - anything not here is something you imagined.');
    for (const p of seen) lines.push(`  ${p.name}: ${p.picture}`);
  }

  if (file.chronology.length) {
    lines.push('');
    lines.push('THE CHRONOLOGY. This is what happened and when. You decide the order it is');
    lines.push('TOLD in, but nothing may contradict this and no date here may change.');
    for (const e of file.chronology) {
      const mark = e.certainty === 'established' ? '' : `  [${e.certainty.toUpperCase()}]`;
      lines.push(`  ${e.when}${e.where ? `, ${e.where}` : ''}: ${e.what}${mark}`);
    }
  }

  if (file.investigation.length) {
    lines.push('');
    lines.push('WHAT INVESTIGATORS DID, in order. A separate sequence from the one above.');
    for (const step of file.investigation) lines.push(`  - ${step}`);
  }

  lines.push('');
  lines.push(`HOW IT ENDED (${file.outcome.status}): ${file.outcome.what}`);
  if (file.outcome.when) lines.push(`  ${file.outcome.when}`);

  if (file.contested.length) {
    lines.push('');
    lines.push('DISPUTED. These are claims about real people and they are NOT settled.');
    lines.push('Say each one ONCE, plainly, where it belongs, and attribute it. Do not');
    lines.push('state any of them as fact, and do not hedge the rest of the episode.');
    for (const c of file.contested) {
      lines.push(`  ${c.claim}`);
      lines.push(`      said by: ${c.whoSays}. disputed because: ${c.why}`);
    }
  }

  if (file.unknown.length) {
    lines.push('');
    lines.push('WHAT THE RECORD DOES NOT SAY. Say so where it matters. A gap named out loud');
    lines.push('is more trustworthy and more interesting than one glided over, and inventing');
    lines.push('an answer to any of these is the worst thing this episode could do.');
    for (const u of file.unknown) lines.push(`  - ${u}`);
  }

  return lines.join('\n');
};

/**
 * Everything wrong with a case file that can be found without a model.
 *
 * FREE, AND IT RUNS BEFORE THE SCRIPT IS PAID FOR. Each of these is a real
 * failure mode of this lane rather than a tidiness check.
 */
export const checkCaseFile = (file: CaseFile): string[] => {
  const problems: string[] = [];

  const carried = file.cast.filter((p) => p.carry);
  if (carried.length > MAX_CARRY) {
    problems.push(
      `${carried.length} names to carry, and a listener holds about ${MAX_CARRY}. ` +
        `Some of these have to become "the officer who took the call".`
    );
  }

  // THE ONE THAT MATTERS MOST. A case file with no victim is a file about the
  // person who did it, which is the failure the whole lane is written against.
  if (file.cast.length && !file.cast.some((p) => p.role === 'victim')) {
    problems.push('no victim in the cast, so this is a story about whoever did it');
  }

  const victimsWithout = file.cast.filter((p) => p.role === 'victim' && !p.background.trim());
  for (const v of victimsWithout) {
    problems.push(
      `${v.name} is the victim and has no background, so the listener meets them as a case number`
    );
  }

  if (file.chronology.length < 3) {
    problems.push(`only ${file.chronology.length} dated event(s), which is not a chronology`);
  }

  // Names in the chronology that nobody introduced.
  const known = new Set(file.cast.map((p) => p.name.toLowerCase()));
  const orphans = new Set<string>();
  for (const e of file.chronology) {
    for (const name of e.who) {
      if (!known.has(name.toLowerCase())) orphans.add(name);
    }
  }
  for (const name of orphans) {
    problems.push(`"${name}" acts in the chronology but is not in the cast`);
  }

  return problems;
};

/**
 * Reading the case file back against the document it came from.
 *
 * THE ONLY EVIDENCE CHECK THIS LANE HAS, and on a lane about real people that
 * makes it the one worth turning on. The myth lane's equivalent is optional
 * because a wrong detail in a myth is a wrong detail in a myth; here a date the
 * document never gave, or an allegation promoted to a fact, is a false
 * statement about somebody who existed.
 *
 * A DIFFERENT MODEL FAMILY, for the reason the whole studio uses one: a checker
 * that shares the builder's priors reconstructs the builder's reasoning instead
 * of reading the document in front of it. This is worse here than elsewhere,
 * because a plausible-sounding case is exactly what the builder is good at.
 *
 * IT READS THE FILE, NOT THE SCRIPT. Catching an invented date while it is
 * still one line of JSON costs one call; catching it after the script is
 * written means the script is wrong too.
 */
export const caseReviewSchema = z.object({
  /** A date, name or figure the document does not contain. */
  invented: z.array(z.string()).default([]),
  /** Marked established where the document attributes it to somebody. */
  overstated: z.array(z.string()).default([]),
  /** In the document, load-bearing, and missing from the file. */
  missing: z.array(z.string()).default([]),
  /** Whether the check ran, so silence is never mistaken for a pass. */
  checked: z.boolean().default(true),
  failure: z.string().optional(),
});

export type CaseReview = z.infer<typeof caseReviewSchema>;

export const CASE_REVIEW_SYSTEM = `You are checking a case file against the single document it was built from.

This is about real people. You are not judging the writing, and you are not fact-checking the world. You are checking one thing: whether this file says more than that document supports.

Report three things and nothing else.

INVENTED. A date, a name, a number, a place or a physical detail in the file that is not in the document. This is the worst failure available here, because everything downstream treats the file as true and nothing else will catch it. Quote the part of the file that is wrong.

OVERSTATED. Anything the file marks "established" that the document actually attributes to somebody, or reports as a claim, an allegation, a theory or a finding that was later disputed. A confession that was retracted is not a fact about what happened. A police theory is not a fact. Quote it.

MISSING. Something the document establishes, which matters to understanding the case, and which is not in the file at all. Be strict about "matters": a detail that changes what a listener understands, not every fact that was left out. A case file is a selection and is supposed to be.

If the file is clean on any of these, return an empty list for it. Do not invent findings to look thorough.`;

/**
 * Check a case file against its document.
 *
 * Returns a review marked `checked: false` on any failure rather than throwing,
 * so a review that could not run can never read as one that found nothing.
 */
export const reviewCaseFile = async (
  input: { file: CaseFile; source: Source },
  model: LlmClient,
  onCost?: (pence: number) => void
): Promise<CaseReview> => {
  // COMPACT, NOT PRETTY-PRINTED. The indentation was about a fifth of the
  // tokens in this prompt and reads no differently to a model.
  const prompt = `THE CASE FILE
${JSON.stringify(input.file)}

THE DOCUMENT IT WAS BUILT FROM
${input.source.title}
${input.source.url}

${input.source.text.slice(0, CASE_CHARS)}

Return ONLY this JSON object.

{
  "invented": ["quote the part of the file the document does not support"],
  "overstated": ["quote what is marked established and should not be"],
  "missing": ["what the document establishes that matters and is not in the file"]
}`;

  try {
    const reply = await completeJson<unknown>(
      model,
      {
        system: CASE_REVIEW_SYSTEM,
        prompt,
        // MEASURED, AND THE REASON THE NUMBERS ARE HERE. At medium effort with a
        // 16,000 ceiling this call came to 94p on a 51,000-character document,
        // which put a checked episode at 129p against a budget of a pound.
        // Reasoning tokens bill at output rates, and this is a COMPARISON task
        // rather than a reasoning one: read the file, read the document, say
        // what does not match. Low effort is both cheaper and, for structured
        // output, more reliable.
        maxTokens: 8_000,
        effort: 'low',
        cacheSystem: true,
        // Zero. Judgement should not wander.
        temperature: 0,
      },
      onCost
    );

    return caseReviewSchema.parse(reply);
  } catch (err) {
    return {
      invented: [],
      overstated: [],
      missing: [],
      checked: false,
      failure: (err as Error).message.slice(0, 200),
    };
  }
};
