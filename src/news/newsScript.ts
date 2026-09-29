/**
 * A news report under three minutes, written from one article in one call.
 *
 * WRITTEN THE WAY RADIO NEWS IS WRITTEN, not the way a story is told. The two
 * are close to opposites, and the story writers elsewhere in this repo would do
 * this job badly for exactly the reasons they do their own job well:
 *
 *   A story builds to its ending.       News puts the ending first. The lede is
 *                                       the newest, most important fact, and
 *                                       everything after it is detail.
 *   A storyteller has a view.           A reporter has a source. Every contested
 *                                       claim is attributed, and the words are
 *                                       neutral: "said", never "claimed".
 *   A story may explain freely.         A report adds nothing its source does
 *                                       not say, because a listener will take
 *                                       it as this channel's reporting.
 *
 * The rules below are the broadcast conventions every newsroom style guide
 * teaches (BBC, NPR, AP broadcast, and the university broadcast texts that
 * codify them): attribution BEFORE the claim, because a listener cannot glance
 * back to see who said it; present or present-perfect tense for immediacy;
 * one idea to a sentence; titles before names; numbers rounded the way a
 * newsreader says them; and the key fact said again at the end, because
 * somebody tuned in halfway.
 *
 * TITLE IN THE SAME CALL. The story lanes pay a second call for a title. A
 * headline is the lede in eight words, and the writer has just written the
 * lede, so asking again elsewhere would pay to re-read the script.
 */
import { z } from 'zod';
import { Persona } from '../canon/schema';
import { EpisodeFormat } from '../formats/schema';
import { completeJson, LlmClient } from '../models/client';
import { EAR_RULES, Script, ScriptBeat, wordsForBeat } from '../script/write';
import { NETWORK_BANNED_PHRASES } from '../script/style';
import { signoffFor } from '../script/storyScript';
import { turnSchema } from '../script/dialogue';

/**
 * How much of the article the writer is shown.
 *
 * A news article is three to eight thousand characters; this is room for a
 * long one plus the page furniture the text extractor leaves in. Reading is
 * most of this lane's cost, and the tail of a news page is related links.
 */
export const NEWS_ARTICLE_CHARS = 16_000;

/** The date as a British newsreader would say it: "Tuesday the 29th of September". */
export const spokenDate = (when: Date): string => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/London',
  }).formatToParts(when);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = Number(get('day'));
  const suffix =
    day % 100 >= 11 && day % 100 <= 13
      ? 'th'
      : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th';
  return `${get('weekday')} the ${day}${suffix} of ${get('month')}`;
};

export const NEWS_INSTRUCTION = `You are a broadcast news reporter. You are writing
ONE complete news report, to be read aloud by one voice, under three minutes,
for somebody scrolling a feed who has nothing to look at and cannot rewind.

YOUR ONLY SOURCE IS THE ARTICLE BELOW. Every event, name, figure, quotation,
date, cause and intention in the report comes from it. Do not add anything from
your own memory, above all not later developments, casualty figures, or what
anyone is expected to do next. You MAY use ordinary knowledge to place things
for a listener in a few words: where a country or city is, what an organisation
is. Nothing more. If the article does not say it, the report does not say it.

REPORT ONLY THE STORY IN THE ARTICLE'S HEADLINE. Pages carry links and
paragraphs about other stories. Ignore them.

NAME THE SOURCE ON AIR. Early in the report, say once where this comes from, the
way a newsreader does: "according to reporting by {OUTLET}", or "{OUTLET}
reports that". Do not mention any other news organisation, and never suggest
this channel confirmed anything itself.

HOW RADIO NEWS IS WRITTEN. Follow every one of these.
- THE LEDE FIRST. The first sentence is the single most important new
  development: who did what, in the present or present perfect tense, active
  voice. Not background, not a quotation, not a statistic, not an unfamiliar
  name. A listener who hears only that sentence has the news.
- ATTRIBUTION BEFORE THE CLAIM. "Ukraine's military says it shot down forty
  drones", never "Forty drones were shot down, Ukraine's military said". The
  listener must know who is speaking before they hear what was said. Anything
  one side asserts, a figure one side counted, an accusation, an intention: all
  attributed. What the article reports as established fact may be said plainly.
- NEUTRAL WORDS. "Said" and "says". Never "claimed", "admitted", "insisted",
  "slammed", "blasted", "vowed". No adjectives of judgement, such as brutal,
  shocking, historic, controversial, unless they are inside a quotation and
  attributed. No opinion, no prediction of your own, no "it remains to be seen",
  no moral, no "only time will tell".
- BOTH SIDES THE ARTICLE CARRIES. If the article gives a response, denial or
  refusal to comment from the other party, the report includes it.
- AN ALLEGATION IS AN ALLEGATION. "Accused of", "alleged", "charged with". If the
  article says material has not been independently verified, say so.
- PEOPLE. Title before the name, the first time: "Britain's foreign secretary,
  <name>". Never a surname alone the first time. At most four names in the whole
  report. Everybody else is their role.
- NUMBERS as digits, so the voice reads them correctly: "40,000", "3.5 billion
  dollars", "1991". Round the way a newsreader does, "about 40,000", "more than
  200", but never change what a number is.
- QUOTATIONS. At most one, short, introduced first: "In a statement, the
  ministry said the talks were, in its words, a waste of time." Everything else
  is paraphrased and attributed.
- ONLY ABBREVIATIONS PEOPLE SAY OUT LOUD: UN, NATO, EU, US, UK. Everything else
  spelled out the first time or replaced by a description.
- ONE IDEA TO A SENTENCE. Mostly short sentences, some longer ones where a thing
  needs gathering. No semicolons, no dashes, no brackets.
- TIME. Name days, not "today" or "yesterday", because this will be heard for
  days. Say the day once near the top: "On {WEEKDAY}, ...". If the events are
  on an earlier day, name that day.

THE REPORT MUST BE COMPLETE. Somebody who hears only this knows what happened,
who is involved, where, when, why it matters, and what happens next, so far as
the article says. No teasers, no "more on this later", no "stay tuned".

THE LAST PART says what happens next if the article says, then says the key
development once more in fresh words for anybody who joined halfway, then the
goodbye. The goodbye asks the listener to follow for more on the beat, in your
own words, warm and quick, and it is the last thing said.

A HEADLINE AND DESCRIPTION. The headline is the lede in about eight words,
specific and plain, as a news site would print it. No question, no colon, no
clickbait, no date. The description is one or two sentences saying what
happened.`;

export const newsDraftSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  beats: z.array(z.object({ beatId: z.string(), turns: z.array(turnSchema).min(1) })),
});

export type NewsDraft = z.infer<typeof newsDraftSchema>;

export interface NewsScriptInput {
  persona: Persona;
  format: EpisodeFormat;
  article: { title: string; url: string; text: string; outlet: string; publishedAt: string };
  beat: string;
  now: Date;
}

export const buildNewsSystem = (persona: Persona): string => {
  const canon = (kind: string) =>
    persona.canon
      .filter((c) => c.kind === kind)
      .map((c) => `- ${c.text.trim().replace(/\s+/g, ' ')}`)
      .join('\n');
  const host = persona.hosts[0]!;

  return [
    `SHOW: ${persona.name}`,
    `WHAT IT IS: ${persona.thesis.trim().replace(/\s+/g, ' ')}`,
    `LISTENER: ${persona.audience.trim().replace(/\s+/g, ' ')}`,
    `HOW IT SOUNDS: ${persona.register.trim().replace(/\s+/g, ' ')}`,
    `THE REPORTER: ${host.name}. ${host.role.trim().replace(/\s+/g, ' ')}`,
    '',
    'THIS DESK BELIEVES',
    canon('belief') || '- (none recorded)',
    '',
    'THIS DESK NEVER',
    canon('taboo') || '- (none recorded)',
    '',
    'HOW IT WRITES',
    canon('stylistic_rule') || '- (none recorded)',
    '',
    'WRITING FOR AUDIO',
    // The first two only. The others are about letting a sentence run long and
    // about "three in ten" rather than digits, which is right for a story and
    // wrong for a report whose numbers are checked against its source.
    ...EAR_RULES.slice(0, 2).map((r) => `- ${r}`),
    '',
    'NEVER USE THESE PHRASES',
    ...NETWORK_BANNED_PHRASES.concat(persona.styleCard.forbiddenPhrases).map((p) => `- ${p}`),
  ].join('\n');
};

export const buildNewsPrompt = (input: NewsScriptInput): string => {
  const signoff = signoffFor(input.persona, 'short', input.article.url);
  const speaker = input.persona.hosts[0]!.id;
  const published = new Date(input.article.publishedAt);

  const parts = input.format.beats
    .map((beat) => {
      const { min, max } = wordsForBeat(beat);
      return [
        `--- ${beat.id} ---`,
        `MUST: ${beat.function.trim().replace(/\s+/g, ' ')}`,
        beat.constraints.length
          ? beat.constraints.map((c) => `- ${c.trim().replace(/\s+/g, ' ')}`).join('\n')
          : '',
        `LENGTH: ${min} to ${max} words. A hard budget: the whole report must stay under three minutes.`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  return [
    NEWS_INSTRUCTION.replace(/\{OUTLET\}/g, input.article.outlet).replace(
      /\{WEEKDAY\}/g,
      spokenDate(published).split(' ')[0]!
    ),
    '',
    `TODAY IS ${spokenDate(input.now)}, UK time.`,
    `THE ARTICLE WAS PUBLISHED ${spokenDate(published)}, at ${published.toISOString().slice(11, 16)} UTC.`,
    `THE SOURCE, AS YOU SAY IT ON AIR: ${input.article.outlet}`,
    `THIS CHANNEL'S BEAT: ${input.beat}`,
    '',
    signoff
      ? `HOW THIS CHANNEL SIGNS OFF. The last part ends on this, in your own words rather than ` +
        `word for word, and it is the last thing said:\n  ${signoff}`
      : `The last part ends by asking the listener to follow for more on ${input.beat}, then goodbye.`,
    '',
    `Return JSON only: {"title": "...", "description": "...", "beats": [{"beatId": "...", ` +
      `"turns": [{"speaker": "${speaker}", "text": "..."}]}]}`,
    `THE ONLY SPEAKER ID IS "${speaker}". One turn per part is right for a report.`,
    '',
    'THE PARTS, in order:',
    '',
    parts,
    '',
    '=========================================================',
    `THE ARTICLE, from ${input.article.outlet}. Everything in the report comes from here.`,
    '=========================================================',
    '',
    `HEADLINE: ${input.article.title}`,
    `URL: ${input.article.url}`,
    '',
    input.article.text.slice(0, NEWS_ARTICLE_CHARS),
  ].join('\n');
};

export const REVISE_NEWS = `Your previous draft of this report failed the specific
checks listed below. Write the whole report again, fixing every one of them, and
change nothing that was not wrong. A figure that is not in the article must be
removed or corrected to what the article says.`;

/**
 * Write the report. Free checks are passed in rather than imported, so the
 * pipeline decides which run and a test can see exactly what was asked.
 */
export const writeNewsScript = async (
  input: NewsScriptInput,
  writer: LlmClient,
  check: (draft: NewsDraft) => string[],
  onCost?: (pence: number) => void,
  onProgress?: (message: string) => void,
  allowRevisions = false
): Promise<{ script: Script; problems: string[] }> => {
  const system = buildNewsSystem(input.persona);
  const prompt = buildNewsPrompt(input);
  const speaker = input.persona.hosts[0]!.id;
  const budget = allowRevisions ? 1 : 0;

  let draft: NewsDraft | undefined;
  let problems: string[] = [];
  let revisions = 0;

  for (let attempt = 0; attempt <= budget; attempt += 1) {
    const ask =
      attempt === 0
        ? prompt
        : `${prompt}\n\n${REVISE_NEWS}\n\nWHAT FAILED:\n${problems.map((p) => `- ${p}`).join('\n')}`;

    const reply = await completeJson<unknown>(
      writer,
      {
        system,
        prompt: ask,
        maxTokens: 6_000,
        // LOW, FOR THE SAME REASON AS THE MYTH SHORT: thinking bills at output
        // rates, and on a few-pence report it is the easiest way to double the
        // bill. The rules above are explicit enough not to need deliberation.
        effort: 'low',
        cacheSystem: true,
        // Lower than the story writers. A report is not meant to surprise.
        temperature: 0.5,
      },
      onCost
    );

    draft = newsDraftSchema.parse(reply);
    revisions = attempt;
    problems = check(draft);
    if (!problems.length) break;
    onProgress?.(
      budget === 0
        ? `${problems.length} problem(s), and revisions are OFF so none were fixed: ${problems.join('; ')}`
        : attempt < budget
          ? `${problems.length} problem(s), rewriting: ${problems.slice(0, 3).join('; ')}`
          : `${problems.length} problem(s) still there after the rewrite: ${problems.join('; ')}`
    );
  }

  const beats: ScriptBeat[] = input.format.beats.map((beat) => {
    const written = draft!.beats.find((b) => b.beatId === beat.id);
    return {
      beatId: beat.id,
      beatType: beat.type,
      turns: (written?.turns ?? [{ speaker, text: '' }]).map((t) => ({ ...t, speaker })),
      claimIds: [],
      revisions,
    };
  });

  return {
    script: {
      personaId: input.persona.id,
      formatId: input.format.id,
      title: draft!.title,
      description: draft!.description,
      beats,
      writerModel: writer.model,
    },
    problems,
  };
};
