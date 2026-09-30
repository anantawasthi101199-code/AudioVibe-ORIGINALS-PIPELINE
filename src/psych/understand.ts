/**
 * The two research stages of the psychology lane: EXTRACT, then FUSE.
 *
 * The owner's instruction, and the reason this is two calls and not one: "the
 * first step needs to be the best extract most relevant context, then combine
 * into 1 source of truth, like a coherent thing, then make script".
 *
 * WHY THAT ORDER IS RIGHT, and not just asked for. A psychology topic is
 * covered by documents that are each good at one thing and useless at the
 * others: a clinical page has the mechanism and no lived experience, a
 * lived-experience piece has the exact moment a listener will recognise and no
 * idea why it happens, and the practical pages have the strategies with no
 * explanation of what they are working on. Handing all of that to one call and
 * asking for a script produces whichever document was longest, told badly.
 *
 * So EXTRACT reads them separately and pulls out only the five kinds of thing
 * this show uses, keeping each attributable to the document it came from. FUSE
 * then writes ONE understanding: the mechanism in plain words, the picture the
 * episode will be built on, the moments, the inner voice, and what helps. That
 * understanding is the only thing the writer ever sees.
 *
 * WHAT THE WRITER NEVER SEES: `variants` and `sources`. Disagreements between
 * documents are decided HERE and recorded for a person to audit. The myth lane
 * learned this the expensive way: one contested claim, left for the writer to
 * handle, ate half the payoff of an episode in hedging. A listener who is
 * already overwhelmed does not need to be told the literature is unsettled.
 *
 * CHEAP BY CONSTRUCTION. Which part of each document the extractor reads is
 * chosen for free by BM25 against the curriculum's own queries, so the paid
 * call reads seven thousand characters of the relevant pages rather than sixty
 * thousand characters of navigation, cookie notices and related links.
 */
import { z } from 'zod';
import { selectPassages } from '../evidence/passages';
import { Source } from '../evidence/source';
import { completeJson, LlmClient } from '../models/client';


// ---------------------------------------------------------------------------
// 1. Extract
// ---------------------------------------------------------------------------

export const findingsSchema = z.object({
  sources: z.array(
    z.object({
      sourceId: z.string(),
      /** How this subject actually works, as this document explains it. */
      mechanism: z.array(z.string()).default([]),
      /** Something people commonly get wrong, and what is true instead. */
      corrections: z.array(z.string()).default([]),
      /** A moment a person living with this would recognise. */
      experiences: z.array(z.string()).default([]),
      /** Something that helps, as concretely as the document puts it. */
      strategies: z.array(z.string()).default([]),
      /** A figure worth saying out loud, with what it measures. */
      figures: z.array(z.string()).default([]),
      /** A term this subject cannot be explained without. */
      terms: z.array(z.object({ term: z.string(), meaning: z.string() })).default([]),
    })
  ),
});

export type Findings = z.infer<typeof findingsSchema>;

export const EXTRACT_SYSTEM = `You are reading research and clinical writing for an audio
show that explains how the mind works to somebody with no background in
psychology, warmly and in very plain words.

Pull out ONLY what such an episode can actually use, from EACH document
separately, and keep it attached to the document it came from. Do not merge
documents and do not resolve disagreements between them; that happens later.

FIVE KINDS OF THING, and nothing else:

1. MECHANISM. How this actually works, as this document explains it. What the
   brain or the nervous system is doing, and why that produces the experience.
   Write each one as a plain sentence a fifteen-year-old could follow. Keep the
   real specifics (which part of the brain, which chemical, which system) but
   say them in ordinary words.

2. CORRECTIONS. Something people commonly believe about this that this document
   says is wrong, and what is true instead. These are the most valuable thing
   on this list: the whole show is built on the difference between what this
   feels like and what it is.

3. EXPERIENCES. A concrete moment a person living with this would recognise.
   Ordinary, specific and physical: what they were doing, what happened, what it
   felt like. Not a summary of symptoms.

4. STRATEGIES. Something that helps, as concretely as the document puts it. A
   real thing a person can do, with any worked example the document gives. Skip
   anything that is really a medical decision.

5. FIGURES. A number worth saying out loud, with what it measures and where it
   comes from. Only if the document actually states it.

Also list TERMS: any word this subject genuinely cannot be explained without,
with what it means in one plain clause.

RULES. Everything comes from the document in front of you; nothing from your own
knowledge. If a document has nothing of a given kind, return an empty list for
it rather than inventing something. Prefer specific over general every time: "he
gets up to clean his room and ends up on his bed on his phone" is worth ten
sentences about difficulty with task initiation.

Return JSON only:
{"sources": [{"sourceId": "...", "mechanism": ["..."], "corrections": ["..."],
"experiences": ["..."], "strategies": ["..."], "figures": ["..."],
"terms": [{"term": "...", "meaning": "..."}]}]}`;

export const extractFindings = async (
  input: { topic: string; sources: Source[]; queries: string[]; charsPerSource: number },
  model: LlmClient,
  onCost?: (pence: number) => void
): Promise<Findings> => {
  const documents = input.sources
    .map((source, i) =>
      [
        `===== DOCUMENT ${i + 1} =====`,
        `sourceId: ${source.id}`,
        `title: ${source.title}`,
        `publisher: ${source.publisher ?? new URL(source.url).hostname}`,
        '',
        selectPassages(source.text, input.queries, input.charsPerSource),
      ].join('\n')
    )
    .join('\n\n');

  const reply = await completeJson<unknown>(
    model,
    {
      system: EXTRACT_SYSTEM,
      prompt: [
        `THE SUBJECT OF THE EPISODE: ${input.topic}`,
        '',
        `There are ${input.sources.length} documents. Return one entry for each, using the ` +
          `sourceId exactly as given.`,
        '',
        documents,
      ].join('\n'),
      maxTokens: 12_000,
      // Reading and sorting, not judging. Low effort keeps the thinking, which
      // bills at output rates, from doubling the bill on the longest call in
      // the lane.
      effort: 'low',
      cacheSystem: true,
      temperature: 0.3,
    },
    onCost
  );

  return findingsSchema.parse(reply);
};

// ---------------------------------------------------------------------------
// 2. Fuse
// ---------------------------------------------------------------------------

export const understandingSchema = z.object({
  /** The subject, as the episode will say it out loud. */
  subject: z.string(),
  /** What this is, in one plain sentence. */
  oneLine: z.string(),
  /**
   * The specific everyday moment the listener will recognise, in the second
   * person. This is what the episode opens on, so it has to be a moment and not
   * a description: "you sit down to do one thing and your mind will not start".
   */
  feltMoment: z.string(),
  /**
   * THE PICTURE THE WHOLE EPISODE IS BUILT ON.
   *
   * One sustained everyday image that carries the mechanism: a control panel of
   * blinking buttons, a smoke alarm that cannot tell toast from a fire, a phone
   * on five per cent battery. The episode introduces it, explains the science
   * through it, and lands on it at the end, which is what makes a listener
   * remember the episode a week later.
   */
  picture: z.object({
    name: z.string(),
    /** How to build it out loud, in two or three sentences. */
    build: z.string(),
    /** What each part of it stands for. */
    mapsTo: z.string(),
    /** The words to check the callback against. Ordinary nouns, not a phrase. */
    keywords: z.array(z.string().min(3)).min(1).max(4),
  }),
  /** What is actually happening, in plain words, three to five sentences. */
  mechanism: z.string(),
  /** Words the episode cannot avoid, each with the gloss it must be given. */
  terms: z.array(z.object({ term: z.string(), gloss: z.string() })).max(3).default([]),
  /** What people commonly believe, and what is true instead. */
  corrections: z.array(z.object({ believed: z.string(), actually: z.string() })).default([]),
  /** Moments to tell back to the listener, second person, concrete. */
  realLife: z.array(z.string()).default([]),
  /** The listener's own thoughts, in their words. */
  innerVoice: z.array(z.string()).default([]),
  /** The compassionate reframe: what the mind is doing FOR them. */
  comfort: z.string(),
  /** What this is NOT, said plainly. "It is not laziness." */
  notSaying: z.array(z.string()).default([]),
  /** What helps, each with a worked before-and-after. */
  helps: z
    .array(z.object({ instead: z.string(), tryThis: z.string(), why: z.string() }))
    .default([]),
  /** Figures worth saying, with what they measure. */
  figures: z.array(z.string()).default([]),
  /**
   * A line pointing at real help, when the subject needs one.
   *
   * Empty for an ordinary topic. Required, and checked for, on anything
   * crisis-adjacent. See psych/check.ts.
   */
  careNote: z.string().default(''),
  /**
   * Where the documents disagreed, and what was decided.
   *
   * NEVER SHOWN TO THE WRITER. For a person reading the run afterwards.
   */
  variants: z.array(z.string()).default([]),
  /** The documents this rests on. Also not shown to the writer. */
  sourceIds: z.array(z.string()).default([]),
});

export type Understanding = z.infer<typeof understandingSchema>;

export const FUSE_SYSTEM = `You are turning notes taken from several documents into ONE
coherent understanding of a psychology topic, which one person will then use to
write a warm, very plain-spoken audio episode.

You are not writing the episode. You are deciding what is true, what the picture
is, and what matters, so that the writer never has to.

WHAT YOU PRODUCE.

ONE LINE: what this is, in a single plain sentence, no jargon at all.

FELT MOMENT: the specific everyday moment a listener will recognise, in the
second person, as a moment and not a description. "You sit down to do one simple
thing and your brain will not start" is a moment. "Difficulty initiating tasks"
is not.

THE PICTURE: one everyday image that carries the whole mechanism, and that the
episode will be built on. This is the most important decision you make.
- It must be ORDINARY: a control panel of blinking buttons, a smoke alarm that
  cannot tell burnt toast from a house fire, a phone stuck on five per cent, a
  browser with fifty tabs open.
- It must be ACCURATE. Every part of it has to stand for a real part of the
  mechanism, and you say which in mapsTo. A picture that flatters but misleads
  is worse than no picture.
- It must be KIND. It explains what the mind is doing, never what is wrong with
  the person.
- Give two to four ordinary keywords from it. The episode's ending is checked
  against them, because the callback is what makes it land.

MECHANISM: what is actually happening, three to five sentences, plain words.
Keep the real specifics - which part of the brain, which chemical, which system
- but say them the way you would to a friend. Name at most three terms that
genuinely cannot be avoided, each with the gloss the episode must give it in the
same breath.

CORRECTIONS: what people commonly believe, and what is true instead. Include the
one about the person themselves if the documents support it: that this is not
laziness, not a lack of willpower, not a character flaw.

REAL LIFE: three to five moments, second person, concrete and physical.

INNER VOICE: the things a person actually says to themselves about this, in
their own words. Short. "Why can't I just do it?"

COMFORT: the compassionate reframe. What the mind is doing FOR them, not to
them, in one or two sentences, and only where the documents support it.

NOT SAYING: the plain sentences the episode should say out loud about what this
is not.

HELPS: three or four things that genuinely help, each as a before and after.
"instead" is the version that sounds impossible to somebody overwhelmed, "tryThis"
is the tiny version that is actually possible, "why" is one clause on why the
small one works. Take them from the documents, never from general self-help.

FIGURES: only ones the notes actually contain.

CARE NOTE: leave it empty unless this subject touches self-harm, suicide, eating
disorders, abuse, psychosis or addiction. If it does, write one warm,
non-dramatic sentence pointing at real help.

RULES.

RESOLVE EVERYTHING. Where the notes disagree, decide, and record what you decided
and why in "variants". The writer never sees variants, so nothing downstream can
hedge. Prefer the clinical and academic sources on mechanism, and the lived
experience sources on what it feels like.

NEVER DIAGNOSE and never imply the listener has a condition. This show explains
an experience that many people have, whether or not anyone has named it for
them.

NO TREATMENT DECISIONS. Never recommend, discourage, start, stop or change any
medication or therapy. Saying that treatments exist and that a professional is
the person to ask is fine.

Everything comes from the notes. Nothing from your own knowledge of the subject,
however confident you are.

Return JSON only, with exactly these fields:
{"subject","oneLine","feltMoment","picture":{"name","build","mapsTo","keywords":[]},
"mechanism","terms":[{"term","gloss"}],"corrections":[{"believed","actually"}],
"realLife":[],"innerVoice":[],"comfort","notSaying":[],
"helps":[{"instead","tryThis","why"}],"figures":[],"careNote","variants":[]}`;

export const buildUnderstanding = async (
  input: { topic: string; findings: Findings; sources: Source[] },
  model: LlmClient,
  onCost?: (pence: number) => void
): Promise<Understanding> => {
  const byId = new Map(input.sources.map((s) => [s.id, s]));
  const notes = input.findings.sources
    .map((found) => {
      const source = byId.get(found.sourceId);
      const list = (label: string, items: string[]) =>
        items.length ? `${label}:\n${items.map((i) => `  - ${i}`).join('\n')}` : '';
      return [
        `----- from: ${source?.title ?? found.sourceId} (${
          source ? new URL(source.url).hostname.replace(/^www\./, '') : 'unknown'
        }, tier ${source?.tier ?? '?'}) -----`,
        list('MECHANISM', found.mechanism),
        list('CORRECTIONS', found.corrections),
        list('EXPERIENCES', found.experiences),
        list('STRATEGIES', found.strategies),
        list('FIGURES', found.figures),
        list(
          'TERMS',
          found.terms.map((t) => `${t.term}: ${t.meaning}`)
        ),
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  const reply = await completeJson<unknown>(
    model,
    {
      system: FUSE_SYSTEM,
      prompt: [`THE SUBJECT: ${input.topic}`, '', 'THE NOTES, document by document:', '', notes].join(
        '\n'
      ),
      maxTokens: 12_000,
      // The one judgement call in the lane - which picture the episode is built
      // on - so it gets more room to think than the extractor does.
      effort: 'medium',
      cacheSystem: true,
      temperature: 0.7,
    },
    onCost
  );

  const parsed = understandingSchema.parse(reply);
  return { ...parsed, sourceIds: input.findings.sources.map((f) => f.sourceId) };
};

/**
 * The understanding as the writer sees it.
 *
 * `variants` and `sourceIds` are deliberately absent, for the reason the myth
 * lane keeps them back: a writer shown a disagreement writes about the
 * disagreement, and a listener who came to feel understood gets a paragraph on
 * what the literature has not settled.
 */
export const renderUnderstanding = (u: Understanding): string => {
  const block = (heading: string, body: string) => (body.trim() ? `${heading}\n${body}` : '');
  const bullets = (items: string[]) => items.map((i) => `- ${i}`).join('\n');

  return [
    `SUBJECT: ${u.subject}`,
    `IN ONE LINE: ${u.oneLine}`,
    '',
    block('THE MOMENT THE LISTENER WILL RECOGNISE (open on this):', u.feltMoment),
    '',
    block(
      `THE PICTURE THIS EPISODE IS BUILT ON - "${u.picture.name}":`,
      [
        `How to build it: ${u.picture.build}`,
        `What it stands for: ${u.picture.mapsTo}`,
        `Come back to it at the end. Words to land on: ${u.picture.keywords.join(', ')}`,
      ].join('\n')
    ),
    '',
    block('WHAT IS ACTUALLY HAPPENING:', u.mechanism),
    '',
    block(
      'WORDS YOU MAY USE, EACH EXPLAINED IN THE SAME BREATH, THE FIRST TIME:',
      bullets(u.terms.map((t) => `${t.term} - say it as: ${t.gloss}`))
    ),
    '',
    block(
      'WHAT PEOPLE GET WRONG:',
      bullets(u.corrections.map((c) => `people think ${c.believed} - actually ${c.actually}`))
    ),
    '',
    block('MOMENTS TO TELL BACK TO THEM:', bullets(u.realLife)),
    '',
    block('WHAT THEY SAY TO THEMSELVES:', bullets(u.innerVoice)),
    '',
    block('THE KIND REFRAME:', u.comfort),
    '',
    block('SAY PLAINLY WHAT THIS IS NOT:', bullets(u.notSaying)),
    '',
    block(
      'WHAT ACTUALLY HELPS, as a before and after:',
      bullets(u.helps.map((h) => `instead of "${h.instead}" - "${h.tryThis}" (why: ${h.why})`))
    ),
    '',
    block('FIGURES YOU MAY SAY:', bullets(u.figures)),
    '',
    u.careNote ? `A LINE POINTING AT REAL HELP, WHICH THIS EPISODE MUST CARRY:\n${u.careNote}` : '',
  ]
    .filter((part) => part !== '')
    .join('\n');
};
