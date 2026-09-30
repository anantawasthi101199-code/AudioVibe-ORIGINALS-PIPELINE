/**
 * Single-story research: find the documents that ARE the story, read them
 * whole, and fuse them into one reference article the writer works from.
 *
 * WHY THIS EXISTS, AND THE RUN THAT FORCED IT. The Descent of Inanna episode
 * (e008) was researched the breadth-first way: fourteen documents, 585,396
 * characters fetched, and a 6,000-character keyhole cut into each one before
 * the extractor saw any of it. Thirteen per cent of what was paid for was ever
 * read. The resulting forty-one facts broke down like this:
 *
 *     9  a university course handout
 *     8  Ancient Mesopotamian underworld - Wikipedia
 *     7  Inanna - Wikipedia            (her entire biography)
 *     7  Dumuzid - Wikipedia           (his entire biography)
 *     6  Descent of Inanna into the Underworld   <- the story itself
 *     2  Ereshkigal - Wikipedia
 *     1  a chronology table
 *     1  a second course page
 *
 * The article that is the story came fifth. The script was therefore assembled
 * from eight documents' partial views of one myth, and a listener hears that
 * exactly as it is: a thing that wanders, changes its emphasis, and contradicts
 * itself, because eight authors are talking over each other.
 *
 * Worse, the keyhole lost the answer to the episode's own central question. The
 * script says "The text does not explain guilty of what". The main article has
 * a section headed "A guilty goddess" explaining precisely that - Inanna went
 * down to take her sister's throne and "failed in her thoughtless endeavor to
 * conquer". It sat at character 71,000 of a 98,191-character document, past the
 * 6,000 the extractor was shown. The pipeline had the answer and threw it away
 * before the writer existed.
 *
 * SO THE FIX IS NOT A BETTER PROMPT. It is reading less, and reading all of it.
 * Three documents at a hundred thousand characters each is 300,000 characters
 * of the RIGHT text, against 77,024 characters of mostly the wrong text - four
 * times the material, better material, and one coherent account instead of
 * eight.
 *
 * TWO STEPS, AND THE SECOND IS THE POINT.
 *
 *   SELECT   A model reads the candidate titles and openings and picks the one
 *            to three documents that carry the WHOLE story, rather than a
 *            piece of it or the background around it. Breadth is the thing
 *            being rejected here, so the cap is hard.
 *
 *   FUSE     Those documents are read whole and rewritten as ONE reference
 *            article: the story in order, the world it needs, the cast, and
 *            the things a listener would not know. This is the artifact the
 *            writer sees. It has one voice, one spelling of every name, and
 *            one version of every event.
 *
 * WHERE THE SOURCES DISAGREE, THE FUSION DECIDES AND SAYS NOTHING. That is the
 * owner's instruction and it reverses the old behaviour, where one contested
 * claim out of forty-four grew into half the closing beat and the last line of
 * the episode. The disagreements are not discarded - they go into
 * `variants`, which is written to the run for a person to read, and is NOT
 * given to the writer. An episode is a told story, not a literature review.
 *
 * WHAT THIS GIVES UP, PLAINLY. There is no claim ledger on this lane, so no
 * sentence-level quote binding and no per-fact verification. The reference
 * article is a model's rewriting of documents that were really fetched, which
 * is weaker than a verbatim quote and stronger than nothing: `sourceIds` are
 * real fetched sources and cannot be invented (see source.ts), and the
 * reference is checked once, whole, by `reviewReference`. For a myth - a claim
 * about a text rather than about the world - that is the right trade. For
 * Honest Health it is not, which is why this is a lane and not a replacement.
 */
import { z } from 'zod';
import { EpisodeFormat } from '../formats/schema';
import { completeJson, LlmClient } from '../models/client';
import { Source, TIER_RANK, SourceTier } from './source';

/**
 * The most documents a single-story episode may be built from.
 *
 * THREE, AND THE NUMBER IS THE WHOLE IDEA. Two is usually better and one is
 * often enough; the third slot exists for the ordinary case where the best
 * account of the story and the best account of its world are different
 * documents. Four is where the seams start, which is the finding
 * `concentrateSources` was already built on for shorts.
 */
export const MAX_STORY_SOURCES = 3;

/**
 * How much of each chosen document the fusion step reads.
 *
 * A HUNDRED THOUSAND, AGAINST SIX. It is affordable only because there are
 * three documents instead of fourteen, and the arithmetic is the argument:
 * 3 x 100,000 is 300,000 characters of the story, where 14 x 6,000 was 77,024
 * characters of mostly its surroundings. Roughly 75,000 tokens on one cached
 * call, which is pennies against the cost of an episode nobody finishes.
 *
 * THE NUMBER IS SET BY THE FAULT IT EXISTS TO FIX, not by a round figure. The
 * Wikipedia article on the Descent of Inanna is 98,191 characters, and the
 * section headed "A guilty goddess" - which answers the question that episode
 * gave up on - begins at roughly character 71,000. Any limit below that loses
 * it again. A hundred thousand clears the whole document with room to spare,
 * and is the point of this lane rather than an incidental setting: raising the
 * source count is what would force this back down.
 *
 * Documents longer than this are truncated rather than sampled, and the
 * fusion prompt is TOLD they were truncated. A truncated document loses its
 * tail, which is knowable and reportable; a BM25-sampled one loses whatever
 * did not match the query wording, which is neither, and which is exactly how
 * a section headed with the question got dropped without anybody noticing.
 */
export const REFERENCE_CHARS_PER_SOURCE = 100_000;

/**
 * How many candidates the selector is shown.
 *
 * All of them, in practice. Selection is cheap - it reads titles and openings,
 * not documents - and showing it fewer would mean something else had already
 * made the choice this step exists to make.
 */
export const SELECT_PREVIEW_CHARS = 1_200;

/**
 * Source characters needed per second of finished episode.
 *
 * A DETERMINISTIC FLOOR UNDER THE SELECTOR'S JUDGEMENT, and it exists because
 * the judgement failed. Asked for the Amaterasu cave myth, the selector picked
 * a 6,518-character mythology blog and a 6,673-character article about the
 * cave site - 13,191 characters between them, for an episode targeting ten to
 * nineteen minutes - and passed over the 91,094-character Amaterasu article it
 * had chosen the day before. Its reasoning was sound on its own terms: the blog
 * "is a dedicated narrative telling of the myth from beginning to end". It is.
 * It is also a tenth of what fifteen minutes needs.
 *
 * Finished narration runs about 2.85 words a second, or roughly 16 characters
 * of script per second. Asking for 20 characters of SOURCE per second is a
 * little over one-to-one, which sounds thin until you remember the fusion is
 * selecting and re-ordering rather than transcribing: most of a source does not
 * reach the episode. Below this the writer is padding or inventing.
 *
 * Applied as a floor, not a target. A single 91,000-character article clears it
 * many times over and nothing else is added.
 */
export const SOURCE_CHARS_PER_SECOND = 20;

/**
 * Top up a selection that cannot carry the episode.
 *
 * DETERMINISTIC AND FREE. It runs on what is already on disk, adds the best
 * remaining candidate by tier then length, and stops at the first of two
 * limits: enough material, or `MAX_STORY_SOURCES`. It never removes a document
 * the selector chose - the model's judgement about WHICH document tells the
 * story is better than any arithmetic, and this only answers whether there is
 * ENOUGH of it.
 */
export const topUpSelection = (
  chosen: Source[],
  all: Source[],
  targetSeconds: number
): { chosen: Source[]; added: Source[] } => {
  const need = targetSeconds * SOURCE_CHARS_PER_SECOND;
  const have = () => chosen.reduce((n, s) => n + Math.min(s.text.length, REFERENCE_CHARS_PER_SOURCE), 0);
  if (have() >= need) return { chosen, added: [] };

  const taken = new Set(chosen.map((s) => s.id));
  const rest = all
    .filter((s) => !taken.has(s.id))
    .sort((a, b) => {
      const ta = TIER_RANK[a.tier as SourceTier] ?? 9;
      const tb = TIER_RANK[b.tier as SourceTier] ?? 9;
      if (ta !== tb) return ta - tb;
      return b.text.length - a.text.length;
    });

  const added: Source[] = [];
  for (const source of rest) {
    if (chosen.length >= MAX_STORY_SOURCES || have() >= need) break;
    chosen = [...chosen, source];
    added.push(source);
  }
  return { chosen, added };
};

export const storySelectionSchema = z.object({
  /** Source ids, best first. The first is the spine of the reference. */
  chosen: z.array(z.string()).min(1).max(MAX_STORY_SOURCES),
  /** Why these, in a sentence, for the journal and for a person reading later. */
  reasoning: z.string().default(''),
});

export type StorySelection = z.infer<typeof storySelectionSchema>;

export const SELECT_SYSTEM = `You are choosing which documents an audio episode will be
built from. You will be shown candidates that were really fetched: a title, a
tier, a length and the opening of each.

Pick the ONE to THREE documents that carry the WHOLE story.

WHAT YOU ARE LOOKING FOR, in order:

1. A document that tells the subject from beginning to end AND HAS ENOUGH IN IT
   TO FILL THE EPISODE. One complete account beats four partial ones - but
   "complete" is not the same as "long enough". A blog post can tell a myth from
   beginning to end in two thousand words and still leave a fifteen-minute
   episode with nothing to say after six minutes, at which point the writer
   either pads or invents. You are told the episode length and the size of each
   candidate below: prefer the FULLEST treatment of the subject, not the
   tidiest.

2. A document that supplies the WORLD the story needs - who the people are, what
   the rules of the place were, what a listener has to know before events make
   sense. Usually a second pick, sometimes already inside the first.

3. A primary text or translation, if one was fetched. Words somebody actually
   wrote are worth more than any summary of them.

WHAT YOU ARE REJECTING, and this is most of the list:

- A biography of one participant, when the subject is an event they were in. An
  article about a person covers their whole life and gives this story a
  paragraph.
- General background about the period, the region or the culture. It is real
  material and it is not this story.
- A short blog post or listicle that adds nothing the fuller document lacks. A
  neat retelling is tempting because it reads well; it is the wrong pick when a
  longer article covers the same ground with detail the neat one dropped.
- A second general encyclopedia article overlapping the first. Two overlapping
  summaries do not make one better one; they make two voices.

FEWER IS BETTER. Choosing one document is a good answer when one document has
the story. Do not fill three slots because there are three slots. A document
that would contribute a paragraph is a document that contributes a seam.

Return JSON only:
{"chosen": ["sourceId", "..."], "reasoning": "one sentence"}`;

const previewOf = (source: Source, index: number): string =>
  [
    `--- CANDIDATE ${index + 1} | sourceId: ${source.id} | tier: ${source.tier}`,
    `TITLE: ${source.title}`,
    `URL: ${source.url}`,
    `LENGTH: ${source.text.length.toLocaleString()} characters`,
    `OPENS:`,
    source.text.slice(0, SELECT_PREVIEW_CHARS).replace(/\s+/g, ' ').trim(),
  ].join('\n');

/**
 * Pick the documents that carry the story.
 *
 * FALLS BACK RATHER THAN THROWS. A selector that fails leaves the run with no
 * way forward, and there is a defensible answer available without a model: the
 * longest documents at the best tier. It is a worse choice than the model's and
 * it is very much better than abandoning a corpus that has already been paid
 * for, so a failure here is reported and survived.
 */
export const selectStorySources = async (
  topic: string,
  sources: Source[],
  model: LlmClient,
  onCost?: (pence: number) => void,
  onProgress?: (message: string) => void,
  /**
   * How many documents to keep.
   *
   * THE CASE LANE PASSES ONE, and it is not a tuning knob. Fusing two accounts
   * of a myth resolves a disagreement about a story; fusing two accounts of a
   * crime resolves a disagreement about what a real person did, and that lane
   * reads only the first document anyway. Without this the selector chose three
   * and the log said "using" all of them, which was simply untrue.
   */
  max: number = MAX_STORY_SOURCES
): Promise<{ chosen: Source[]; reasoning: string; fellBack: boolean }> => {
  const keep = Math.max(1, Math.min(max, MAX_STORY_SOURCES));
  // BY SIZE AND TIER, and it is the fallback as well as the tie-break. A
  // dedicated article is almost always among the longest things fetched about
  // its own subject.
  const byWeight = [...sources].sort((a, b) => {
    const ta = TIER_RANK[a.tier as SourceTier] ?? 9;
    const tb = TIER_RANK[b.tier as SourceTier] ?? 9;
    if (ta !== tb) return ta - tb;
    return b.text.length - a.text.length;
  });

  const fallback = () => ({
    chosen: byWeight.slice(0, Math.min(keep, byWeight.length)),
    reasoning: 'chosen by tier and length; the selector did not answer',
    fellBack: true,
  });

  if (sources.length <= 1) {
    return { chosen: sources, reasoning: 'only one document was fetched', fellBack: false };
  }

  try {
    const selection = await completeJson<unknown>(
      model,
      {
        system: SELECT_SYSTEM,
        prompt: [
          `SUBJECT: ${topic}`,
          '',
          keep === 1
            ? 'Choose exactly ONE document: the single best account of this. Not a shortlist.'
            : `Choose up to ${keep}.`,
          '',
          `THE CANDIDATES, ${sources.length} of them:`,
          '',
          sources.map(previewOf).join('\n\n'),
        ].join('\n'),
        maxTokens: 1_500,
        // A judgement, not a transcription, and a cheap one either way.
        effort: 'medium',
      },
      onCost
    );

    const parsed = storySelectionSchema.parse(selection);
    const byId = new Map(sources.map((s) => [s.id, s]));
    // A SELECTOR CANNOT INVENT A DOCUMENT. Ids that do not resolve are dropped
    // rather than trusted, which is the same property fetchSource gives the
    // corpus and the reason a hallucinated citation cannot reach an episode.
    const chosen = parsed.chosen.map((id) => byId.get(id)).filter((s): s is Source => !!s);

    if (!chosen.length) {
      onProgress?.('the selector named no document that was actually fetched; using tier and length');
      return fallback();
    }

    return { chosen: chosen.slice(0, keep), reasoning: parsed.reasoning, fellBack: false };
  } catch (err) {
    onProgress?.(`the selector failed (${(err as Error).message}); using tier and length`);
    return fallback();
  }
};

export const referenceSchema = z.object({
  /** What the story is called, in the form the episode should use. */
  subject: z.string().min(1),
  /**
   * The whole story in one paragraph, before any of it is told at length.
   *
   * This is what the opening beat is built from, and having it decided here
   * rather than in the writer is why the episode knows where it is going.
   */
  spine: z.string().min(1),
  /** What a listener has to believe or know before events stop being arbitrary. */
  world: z.array(z.string()).default([]),
  cast: z
    .array(
      z.object({
        name: z.string(),
        /** Who they are in one clause, in ordinary words. */
        who: z.string(),
        /**
         * DEAD, AND KEPT ONLY SO OLDER RUNS STILL PARSE.
         *
         * It held a respelling like "soo-sah-NOH-oh", the fusion filled it in,
         * and the writer dutifully put it in the script - so the engine said
         * the name and then spelled it out in syllables, mid-sentence. That is
         * a dictionary entry read aloud. The speech engine already pronounces
         * the name; it never needed help, and the help was audible.
         *
         * The fusion is no longer asked for it and the writer is never shown
         * it. Do not start using it again.
         */
        saidAloud: z.string().default(''),
        /**
         * Whether the listener has to carry this name, or can meet it once and
         * let it go.
         *
         * A MYTH HANDS OUT MORE NAMES THAN ANYBODY CAN HOLD. The Amaterasu
         * episode introduced thirty new proper nouns in its story beat alone,
         * at a steady 2.2 per hundred words, and gave almost all of them equal
         * weight. The listener does not need to remember who held the offerings
         * up in front of the cave; they need Amaterasu, Susanoo and the mirror.
         *
         * Defaults to false, so the writer treats a name as texture unless the
         * fusion says otherwise - the safe direction, because over-carrying a
         * name costs a listener attention and under-carrying one costs nothing
         * but a re-introduction.
         */
        carry: z.boolean().default(false),
      })
    )
    .default([]),
  /**
   * The story itself, in order, at length, in one voice.
   *
   * SECTIONS RATHER THAN ONE BLOCK so the writer can see the shape, and
   * deliberately NOT one section per beat: the beat sheet decides the episode's
   * shape, and a reference that pre-shaped itself to the beats would be writing
   * the script.
   */
  sections: z
    .array(
      z.object({
        heading: z.string(),
        body: z.string(),
      })
    )
    .min(1),
  /**
   * Terms, objects and customs a listener will not know, with what they are.
   *
   * SEPARATED OUT ON PURPOSE. These are the things the old lane compressed into
   * appositives - "cuneiform, wedge marks pressed into wet clay" - because the
   * grounding check treated an explanation as an unsupported assertion. Given
   * their own field, the writer can spend a sentence on each instead of a
   * comma, which is the difference between a script being read and a story
   * being told.
   */
  glossary: z
    .array(
      z.object({
        term: z.string(),
        plainly: z.string(),
      })
    )
    .default([]),
  /**
   * How the story ends, chosen, with no hedging.
   *
   * The closing beat is built from this. It is a separate field so that an
   * ending cannot be whatever material happened to be left over, which is the
   * failure the old `close` beat was written to prevent and did not.
   */
  ending: z.string().min(1),
  /**
   * Where the documents disagreed, and which reading was taken.
   *
   * WRITTEN TO THE RUN AND NEVER GIVEN TO THE WRITER. This is the owner's
   * instruction made mechanical: the reader of a run can audit every choice the
   * fusion made, and the episode says none of it. One contested claim used to
   * become half a closing beat; now it becomes a line in an artifact.
   */
  variants: z
    .array(
      z.object({
        about: z.string(),
        taken: z.string(),
        alsoSaid: z.string(),
      })
    )
    .default([]),
  /** What the documents genuinely do not cover, for a person deciding to publish. */
  gaps: z.array(z.string()).default([]),
  /** The fetched sources this was built from. Real ids, never invented. */
  sourceIds: z.array(z.string()).default([]),
});

export type Reference = z.infer<typeof referenceSchema>;

export const FUSE_SYSTEM = `You are writing ONE reference article from a small number of
documents about the same subject. Somebody will write an audio script from what
you produce and will see nothing else, so this has to be complete, in order, and
in one voice.

You are not summarising. A summary is shorter than its source and this should
not be: you have two or three documents and you are producing the single best
account of what they collectively know. Length is not the constraint. Leaving
something out because it was only in one of the documents is the failure here.

WRITE IT IN ORDER. Whatever happened first goes first. If the documents present
the material thematically, or scholarship-first, re-order it into the sequence
events actually occurred in. The writer needs a story, not an encyclopedia entry.

RESOLVE EVERY DISAGREEMENT YOURSELF, AND DO NOT HEDGE IN THE BODY. Where the
documents differ, decide which account is best supported - by the older text, by
the fuller treatment, by the one closest to a primary source - and write THAT as
what happened. Do not write "some sources say". Do not write "scholars
disagree". Do not write "it is unclear". Record what you decided and what the
alternative was in "variants", which the writer will never see, and write the
body as a person who knows the story tells it.

THIS APPLIES INSIDE A SECTION ABOUT HOW THE TEXT SURVIVED, WHICH IS WHERE IT
GETS FORGOTTEN. How a story was lost, dug up, pieced back together and argued
over is often the best material there is, and it belongs in the body. Tell it
as EVENTS with people doing things: somebody went back to the closing lines in
1996 and found something nobody had noticed, a tablet turned up in one museum
and its other half in another, a translation published in 1974 settled a
reading. That is a story. What is not a story, and does not go in the body, is
the state of an argument: "some scholars count this as part of the poem, others
treat it as separate" tells a listener that the experts are unsure and nothing
else. Decide which reading the section is told on, tell it, and put the other
one in "variants".

ANSWER THE OBVIOUS QUESTIONS. As you write, notice what a listener would ask -
why did she do that, why was he punished, what was the reason - and go looking in
the documents for the answer before concluding there isn't one. The answer is
often in a later section under a heading you would not have predicted. Saying
"the text does not explain" when the explanation is in the document you were
given is the single worst outcome of this step.

EXPLAIN EVERYTHING A LISTENER WOULD NOT KNOW, in "glossary". A writing system, a
title, an object, a custom, a place, a unit of time. Write the explanation as a
plain sentence somebody could say out loud, not as a dictionary definition, and
not as a clause to be dropped into the middle of another sentence.

NAMES. Give every name in "cast" with who they are in ordinary words. Leave
"saidAloud" empty: the script is read by a speech engine that pronounces the
name itself, and a written-out pronunciation only ever reached the episode as
the narrator saying the name and then spelling it out in syllables.

WRITE "who" AS ONE LINE SOMEBODY COULD SAY OUT LOUD, because that is exactly
what it is for: the writer says the name, says this line, and carries on with
the story. "Her older sister, who rules the land of the dead" works. "Chthonic
deity associated with the underworld in Mesopotamian cosmology" does not - it is
a database field, and a narrator reading it aloud sounds like one. Keep it to a
single clause or a short sentence, in the words a person would actually use.

MARK THE FEW NAMES THE LISTENER HAS TO CARRY. Set "carry": true for the handful
the story genuinely turns on - usually three to six, rarely more - and false for
everybody else. A name is CARRY if the listener will need it again minutes after
they first hear it. It is texture if it acts once and is done, however important
that one act was. Be strict: marking ten names as carry is the same as marking
none, because the listener cannot hold ten.

DO NOT ADD ANYTHING THE DOCUMENTS DO NOT CONTAIN. You may re-order, join,
explain and choose. You may not invent an event, a name, a number, a motive or a
quotation. General knowledge of the wider world - where a country is, roughly
when a century was, what a river is - may be used to place things for a reader,
and that is the only addition permitted.

Return JSON only:
{"subject": "...",
 "spine": "the whole story in one paragraph",
 "world": ["what a listener must know before events make sense"],
 "cast": [{"name": "...", "who": "...", "carry": true}],
 "sections": [{"heading": "...", "body": "..."}],
 "glossary": [{"term": "...", "plainly": "..."}],
 "ending": "how it ends, decided, no hedging",
 "variants": [{"about": "...", "taken": "...", "alsoSaid": "..."}],
 "gaps": ["what the documents genuinely do not cover"]}`;

/**
 * Read the chosen documents whole and fuse them into one reference article.
 *
 * ONE CALL, DELIBERATELY. The whole value of this step is that one mind sees
 * all of the material at once and produces one account of it; chunking it would
 * rebuild the collage this lane exists to avoid. That is affordable precisely
 * because selection already cut fourteen documents to three.
 */
export const buildReference = async (
  input: {
    topic: string;
    sources: Source[];
    /** The format, so the reference knows roughly how much story is needed. */
    format: EpisodeFormat;
    angle?: string;
  },
  model: LlmClient,
  onCost?: (pence: number) => void
): Promise<Reference> => {
  const documents = input.sources
    .map((s, i) => {
      const body = s.text.slice(0, REFERENCE_CHARS_PER_SOURCE);
      const cut = s.text.length > REFERENCE_CHARS_PER_SOURCE;
      return [
        `--- DOCUMENT ${i + 1} | sourceId: ${s.id} | tier: ${s.tier}`,
        `TITLE: ${s.title}`,
        `URL: ${s.url}`,
        cut
          ? `NOTE: this document is ${s.text.length.toLocaleString()} characters and you are ` +
            `being shown the first ${REFERENCE_CHARS_PER_SOURCE.toLocaleString()}.`
          : '',
        '',
        body,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  const [lo, hi] = input.format.targetSeconds;
  const minutes = `${Math.round(lo / 60)} to ${Math.round(hi / 60)} minutes`;

  const reference = await completeJson<unknown>(
    model,
    {
      system: FUSE_SYSTEM,
      prompt: [
        `SUBJECT: ${input.topic}`,
        input.angle ? `THE ANGLE THIS EPISODE TAKES: ${input.angle}` : '',
        '',
        `WHAT IT IS FOR: an audio episode of ${minutes}, spoken by one voice to ` +
          `somebody with no background knowledge who cannot see anything and ` +
          `cannot look anything up. Give them enough that the writer never has ` +
          `to guess and never has to leave a question hanging.`,
        '',
        `THE DOCUMENTS, ${input.sources.length} of them, in full:`,
        '',
        documents,
      ]
        .filter((line) => line !== '')
        .join('\n'),
      // Long. This is the artifact the whole episode rests on and truncating it
      // to save output tokens would be saving money on the only thing that
      // matters.
      maxTokens: 32_000,
      cacheSystem: true,
    },
    onCost
  );

  const parsed = referenceSchema.parse(reference);
  // THE IDS ARE SET HERE, NOT BY THE MODEL. A reference can only ever cite the
  // documents it was actually given, and taking the model's word for that would
  // be the one place in this pipeline where a citation could be written down
  // rather than fetched.
  return { ...parsed, sourceIds: input.sources.map((s) => s.id) };
};

export const referenceReviewSchema = z.object({
  /** Questions the reference leaves hanging that its own documents answer. */
  unanswered: z.array(z.string()).default([]),
  /** Anything asserted that no document supports. */
  unsupported: z.array(z.string()).default([]),
  /** Whether the check ran at all, so silence is never mistaken for a pass. */
  checked: z.boolean().default(true),
  failure: z.string().optional(),
});

export type ReferenceReview = z.infer<typeof referenceReviewSchema>;

export const REVIEW_SYSTEM = `You are checking a reference article against the documents
it was written from. You are not judging the writing and you are not a fact
checker for the world - only for these documents.

Report two things and nothing else.

UNANSWERED. A question the reference raises or obviously invites, whose answer
IS in the documents and did not make it across. This is the important one. The
commonest and worst case is the reference saying a motive, a cause or a reason is
unknown, when a document explains it somewhere the writer did not look - often
under a later heading. Read for that specifically.

UNSUPPORTED. A specific event, name, number, motive or quotation in the reference
that appears in none of the documents. Be conservative. Re-ordering, joining,
explaining in plainer words, and ordinary placing of a country or a century are
all correct and are not findings.

Do not report a disagreement between documents that the reference resolved. It
was told to resolve them.

Return JSON only:
{"unanswered": ["..."], "unsupported": ["..."]}

Two empty arrays is a good and common answer.`;

/**
 * Read the reference back against its own documents.
 *
 * THE ONLY CHECK ON THIS LANE, AND IT IS DELIBERATELY ONE. The old lane had
 * quote binding, per-claim verification, repair, counter-evidence and a
 * grounding review, and the compound effect of all of them was a script that
 * would not explain what cuneiform was. One check, run once, over the whole
 * reference, asking the two questions that actually went wrong.
 *
 * IT DOES NOT BLOCK. `unanswered` is the finding that matters and it is a
 * prompt to look again rather than a verdict; the run reports it and carries
 * on, and a person reads it before publishing.
 */
export const reviewReference = async (
  input: { reference: Reference; sources: Source[] },
  model: LlmClient,
  onCost?: (pence: number) => void
): Promise<ReferenceReview> => {
  const documents = input.sources
    .map(
      (s, i) =>
        `--- DOCUMENT ${i + 1} | ${s.title}\n${s.text.slice(0, REFERENCE_CHARS_PER_SOURCE)}`
    )
    .join('\n\n');

  const reference = [
    `SUBJECT: ${input.reference.subject}`,
    `SPINE: ${input.reference.spine}`,
    ...input.reference.sections.map((s) => `## ${s.heading}\n${s.body}`),
    `ENDING: ${input.reference.ending}`,
  ].join('\n\n');

  try {
    const review = await completeJson<unknown>(
      model,
      {
        system: REVIEW_SYSTEM,
        prompt: `THE DOCUMENTS:\n\n${documents}\n\n\nTHE REFERENCE ARTICLE:\n\n${reference}`,
        // ROOM FOR THE THINKING, NOT JUST FOR THE ANSWER. This was 4,000 and
        // it hung the first real run for twenty minutes. Thinking tokens count
        // against max_tokens on both families, so a reasoning model handed a
        // hundred and twenty thousand characters of documents and a modest
        // ceiling spends the whole budget reasoning, returns nothing, and
        // completeJson doubles the ceiling and pays for the entire call again.
        // The answer here is two short arrays; the reading before it is the
        // largest single input in the pipeline. See models/client.ts.
        maxTokens: 16_000,
        // NOT `low`. The whole job is noticing that a section the fusion
        // skipped answers a question the reference left hanging, which is a
        // judgement over a lot of text rather than a shape to fill in.
        effort: 'medium',
      },
      onCost
    );
    return referenceReviewSchema.parse(review);
  } catch (err) {
    // A CHECK THAT COULD NOT RUN IS NOT A CHECK THAT PASSED. Same rule as the
    // grounding review: `checked: false` so a quiet report is never read as a
    // clean one.
    return { unanswered: [], unsupported: [], checked: false, failure: (err as Error).message };
  }
};

/** Everything the story lane produces before the writer, kept as one artifact. */
export const storyResearchSchema = z.object({
  selection: z.object({
    chosen: z.array(z.string()),
    reasoning: z.string().default(''),
    fellBack: z.boolean().default(false),
    /** What was fetched and not used, so a person can see what was passed over. */
    notUsed: z.array(z.object({ id: z.string(), title: z.string() })).default([]),
  }),
  /**
   * The fused article. Absent on a short, which has no fusion step.
   *
   * A SHORT GOES STRAIGHT FROM ARTICLE TO SCRIPT in one call, because the
   * fusion alone costs three times a short's entire budget and there is nothing
   * to fuse when there is one document. See script/shortScript.ts.
   */
  reference: referenceSchema.optional(),
  /** What a short was actually written from, recorded instead of a reference. */
  article: z
    .object({ id: z.string(), title: z.string(), url: z.string(), chars: z.number() })
    .optional(),
  review: referenceReviewSchema,
});

export type StoryResearch = z.infer<typeof storyResearchSchema>;
