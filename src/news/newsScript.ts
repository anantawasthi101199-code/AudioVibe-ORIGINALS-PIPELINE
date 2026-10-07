/**
 * A news report under three minutes, written from one article in one call.
 *
 * TWO HALVES THAT ARE NOT ALLOWED TO MIX. The FACTS follow broadcast news
 * discipline: one source named on air, attribution before the claim, neutral
 * verbs, nothing from memory. The VOICE follows explainer news (a presenter who
 * says hello, sets up the ongoing story, then breaks down what happened as
 * cause and effect with an everyday comparison). The owner heard the first
 * rendered report, a correct wire-service read, and called it robotic: no
 * greeting, no context, nothing explained. Personality lives in HOW it is
 * explained, never in what is claimed, and the free checks in news/check.ts
 * still hold every figure and every "unknown" to the article.
 *
 * TITLE IN THE SAME CALL, so a report is one paid call.
 */
import { z } from 'zod';
import { Persona } from '../canon/schema';
import { EpisodeFormat } from '../formats/schema';
import { completeJson, LlmClient } from '../models/client';
import { EAR_RULES, Script, ScriptBeat, wordsForBeat } from '../script/write';
import { NETWORK_BANNED_PHRASES } from '../script/style';
import { signoffFor } from '../script/storyScript';
import { OUTRO_RULE } from '../script/outro';
import { tagGuidance } from '../script/narration';
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

/** "6:23pm", in UK time. */
export const ukClock = (when: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Europe/London',
  })
    .format(when)
    .replace(/\s/g, '');

export const NEWS_INSTRUCTION = `You are {HOST}, the presenter of {SHOW}. You are
talking to one person who has headphones in and a few minutes to spare, and you
are telling them what happened in the world and what it actually means, the way
a well-informed friend would over coffee. Warm, clear, a little personality,
never breathless. Under three minutes, read aloud by one voice.

THE SHAPE, which is how the best explainer-style news shows sound:
1. HELLO AND THE BIG PICTURE. Open with a greeting in your own words ("Hi, it's
   {HOST}", "Hey everyone") and, in a sentence or two, the ongoing story this
   belongs to, so a listener who has not followed it knows where they are: "Let's
   look at the latest in the war between the US and Iran, which is now in its
   eighth month." Then hand into the news: "So here's what happened."
2. WHAT HAPPENED. The new development, with when it was reported, said naturally
   ("late on Monday evening", "this morning") and who reported it: "{OUTLET}
   reported that...". Who did what, plainly.
3. WHAT IT MEANS, IN SIMPLE TERMS. The heart of the report. Break it down so a
   fifteen-year-old could follow it. This part EXPLAINS what has already been
   said; it does not pile on more facts. At most two facts that were not in
   part 2, and only if they are needed to understand it. Leave side stories out.
   - The chain of events as cause and effect: this happened, so that happened,
     which is why this now matters. Walk it step by step.
   - One simple everyday comparison where it genuinely helps, clearly your own
     illustration and not a fact: "Think of the strait as a single-lane bridge
     that a fifth of the world's oil has to cross." Never more than two.
   - Explain any unfamiliar thing in plain words the first time: what a blockade
     is, what sanctions do, who the mediators are.
   - Each side's position, fairly, with who said it.
4. WRAP UP. Pull it together in a sentence or two in fresh words: where things
   stand now, and what happens next if the source says. Then the goodbye, which
   asks the listener to follow and is the last thing said.
Each part CONTINUES from the one before, like one person talking, never a fresh
start. Use small spoken joins: "So", "Now", "Here's the thing", "And that
matters because". A question to the listener is fine once or twice, if you
answer it straight away: "So why does this matter? Because..."

THE FACTS COME FROM ONE PLACE: THE ARTICLE BELOW. Every event, name, figure,
quotation, date, cause and intention comes from it. Never add events, numbers,
names or later developments from memory. What you MAY bring yourself: plain
explanations of general things (what a strait is, what a ceasefire means), where
places are, and your everyday comparisons. That is explaining, not reporting,
and it never contains a new fact about this story.

REPORT ONLY THE STORY IN THE HEADLINE. Ignore links and asides about other
stories on the page.

NAME THE SOURCE ON AIR, once, early: "{OUTLET} reported", "according to
{OUTLET}". Never start two parts with the outlet's name. Never say "the
article"; say the outlet. Never suggest this channel confirmed anything itself.
Mention another news organisation only where the article attributes something
to it, and say so as the article does.

NEVER INVENT AN UNKNOWN. "No date has been set", "it is unclear when", "behind
the scenes" are claims and are only said if the source says them. A gap in the
source is simply left out.

STAY FAIR. Personality is in how you explain, never in taking a side.
- Attribution before the claim: "Iran's foreign minister says the offer still
  stands", not the other way round.
- "Said" and "says", never "claimed", "admitted", "slammed". No opinion of your
  own, no prediction, no moral, no "only time will tell".
- Both sides the article carries. An allegation stays an allegation.
- Title before the name the first time, at most four names in the whole thing.

HOW IT SOUNDS OUT LOUD.
- SHORT SENTENCES. Most of them eight to eighteen words, the way people talk.
  Contractions: "it's", "they're", "here's". Nothing over 25 words. A sentence
  with two commas in it is two sentences.
- Numbers as digits so the voice reads them right ("40,000", "12 billion
  dollars"), rounded only the way people round, never changed.
- Only abbreviations people say out loud: UN, NATO, EU, US, UK.
- No semicolons, dashes or brackets.

A HEADLINE AND DESCRIPTION. The headline is the news in about eight words,
specific and plain. No question, no colon, no clickbait, no date. The
description is one or two sentences saying what happened.`;

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
  /** A ready-made prompt, for the rapid-fire roundup. See news/roundup.ts. */
  prompt?: string;
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
  const ceiling = input.format.beats.reduce((n, b) => n + wordsForBeat(b).max, 0);

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
    NEWS_INSTRUCTION.replace(/\{OUTLET\}/g, input.article.outlet)
      .replace(/\{HOST\}/g, input.persona.hosts[0]!.name)
      .replace(/\{SHOW\}/g, input.persona.name),
    '',
    `TODAY IS ${spokenDate(input.now)}, UK time.`,
    `IT WAS REPORTED ${spokenDate(published)}, at ${ukClock(published)} UK time. Say that ` +
      `naturally relative to today ("this morning", "late last night", "on Monday evening").`,
    `THE SOURCE, AS YOU SAY IT ON AIR: ${input.article.outlet}`,
    `THIS CHANNEL'S BEAT: ${input.beat}`,
    '',
    signoff
      ? OUTRO_RULE
      : `The last part ends by asking the listener to follow for more on ${input.beat}, then goodbye.`,
    tagGuidance(input.persona),
    '',
    `Return JSON only: {"title": "...", "description": "...", "beats": [{"beatId": "...", ` +
      `"turns": [{"speaker": "${speaker}", "text": "..."}]}]}`,
    `THE ONLY SPEAKER ID IS "${speaker}". One turn per part is right for a report.`,
    '',
    // THE TOTAL, SAID OUTRIGHT. Per-part budgets alone came back 36 words over
    // on the first live run, which is thirteen seconds, which is the difference
    // between under three minutes and not.
    `THE WHOLE REPORT IS AT MOST ${ceiling} WORDS, goodbye included. Over that, it runs ` +
      'past three minutes and cannot be used. Cut background before cutting the news.',
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
  const prompt = input.prompt ?? buildNewsPrompt(input);
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
        // Warm enough to sound like a person; the facts are held by the free
        // checks, not by a low temperature.
        temperature: 0.8,
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
