/**
 * A business story, written from ONE source in ONE call: an episode (12 to 15
 * minutes) or a short (under three).
 *
 * WHY ONE CALL FOR THE WHOLE EPISODE. The owner's instruction: "it needs to be
 * systematic, and therefore the story part is generated at once". The myth lane
 * found the same thing from the other side: five parts written from five
 * briefs came back as five essays butted together, each restarting the story.
 * One mind writing the whole life in order is what makes it followable by ear.
 *
 * WHAT THE SHAPE IS BUILT FROM. Founder-story shows (How I Built This, and the
 * business explainer channels) share one arc: a hook that shows the stakes,
 * where it began, the hard years where it nearly failed, the break that
 * changed everything, and where it stands now. They do not make the founder a
 * hero; the setbacks are the story. Audio-only writing adds its own rules,
 * from the podcast-scripting guides: signpost every move ("so that's how it
 * started, now the hard part"), give the listener a beat to take in what just
 * happened, define jargon or cut it, and short spoken sentences.
 *
 * MOTIVATIONAL, EMBEDDED IN REALITY. The inspiration comes from real years,
 * real numbers and real setbacks, never from invented scenes, feelings or
 * quotes. The free checks in business/check.ts hold every figure and every
 * quotation to the source.
 */
import { z } from 'zod';
import { Persona } from '../canon/schema';
import { EpisodeFormat } from '../formats/schema';
import { completeJson, LlmClient } from '../models/client';
import { EAR_RULES, Script, ScriptBeat, wordsForBeat } from '../script/write';
import { NETWORK_BANNED_PHRASES } from '../script/style';
import { signoffFor } from '../script/storyScript';
import { turnSchema } from '../script/dialogue';

export const BUSINESS_INSTRUCTION = `You are {HOST}, host of {SHOW}. You're a friendly,
curious storyteller who does deep dives into how businesses from around the
world were built, and explains them so simply that anybody can follow. You're
talking to one person with headphones in and nothing to look at, so the story
has to be followable by ear alone.

TELL ONE COMPLETE STORY, IN ORDER. From where it began to where it stands now,
chronologically, with the year said out loud at every new step ("By 1958...",
"Ten years later, in 1968..."). Never jump back and forth in time after the
hook. The listener should be able to retell the whole life story afterwards.

THE FACTS COME FROM ONE PLACE: THE SOURCE BELOW. Every event, name, year,
figure, deal and decision comes from it. Nothing from your own memory, however
sure you are. What you MAY add yourself: plain explanations of general things,
where places are, and everyday comparisons that help a listener picture it.

MOTIVATIONAL, AND REAL. Let the facts carry the inspiration: the real
setbacks, the real risks, the real numbers. Never invent a scene, a line of
dialogue, a feeling ("he must have felt"), or a quotation. Only put words in
quotation marks if the source quotes them exactly. No rags-to-riches
exaggeration beyond what the source says. If the source records a serious
controversy, legal trouble or family dispute, mention it briefly and fairly
where it happened in the timeline; do not hide it, do not dwell on it.

MAKE IT EASY TO FOLLOW BY EAR.
- Signpost every move between parts: "So that's how it began. Now, here's where
  it nearly all fell apart." Each part picks up from the last, never restarts.
- Say the founder's name often, rather than "he" or "she" after a gap.
- Short spoken sentences, most of them 8 to 18 words, with contractions. A
  sentence with two commas in it is two sentences.
- Numbers as digits so the voice reads them right ("1937", "5,000 crore",
  "40 million dollars"). Say amounts in the currency the source uses. NEVER
  convert currencies or adjust for inflation; that would invent a number.
- No semicolons, dashes or brackets.

{JARGON}

A HEADLINE AND DESCRIPTION. The title names the business and the arc in plain
words, like "How a Bikaner Sweet Shop Became Haldiram's". No question, no
colon, no clickbait. The description is two sentences saying what the story
covers.`;

export const JARGON_EPISODE = `BUSINESS TERMS. The first time a genuinely tricky term comes up, follow it
immediately with a short plain explanation, as part of the same flow: "They
went public with an IPO, which is when a company first sells its shares to
ordinary investors." "A joint venture, that's two companies building something
together and sharing it." Tricky means an IPO, a debenture, vertical
integration, a hostile takeover, a franchise model, market capitalisation, a
crore or a lakh. Everyday words like profit, factory, customers or brand need
no explanation.`;

export const JARGON_SHORT = `BUSINESS TERMS. This is a quick one, so avoid jargon altogether. If a term
cannot be avoided, explain it in five words or fewer.`;

export const businessDraftSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  beats: z.array(z.object({ beatId: z.string(), turns: z.array(turnSchema).min(1) })),
});

export type BusinessDraft = z.infer<typeof businessDraftSchema>;

export interface BusinessScriptInput {
  persona: Persona;
  format: EpisodeFormat;
  subject: string;
  source: { title: string; url: string; text: string };
  readChars: number;
}

export const buildBusinessSystem = (persona: Persona): string => {
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
    `THE HOST: ${host.name}. ${host.role.trim().replace(/\s+/g, ' ')}`,
    '',
    'THIS SHOW BELIEVES',
    canon('belief') || '- (none recorded)',
    '',
    'THIS SHOW NEVER',
    canon('taboo') || '- (none recorded)',
    '',
    'HOW IT TELLS A STORY',
    canon('stylistic_rule') || '- (none recorded)',
    '',
    'WRITING FOR AUDIO',
    ...EAR_RULES.slice(0, 2).map((r) => `- ${r}`),
    '',
    'NEVER USE THESE PHRASES',
    ...NETWORK_BANNED_PHRASES.concat(persona.styleCard.forbiddenPhrases).map((p) => `- ${p}`),
  ].join('\n');
};

export const buildBusinessPrompt = (input: BusinessScriptInput): string => {
  const kind = input.format.kind;
  const host = input.persona.hosts[0]!;
  const signoff = signoffFor(input.persona, kind, input.subject);
  const ceiling = input.format.beats.reduce((n, b) => n + wordsForBeat(b).max, 0);
  const floor = input.format.beats.reduce((n, b) => n + wordsForBeat(b).min, 0);

  const parts = input.format.beats
    .map((beat) => {
      const { min, max } = wordsForBeat(beat);
      return [
        `--- ${beat.id} ---`,
        `MUST: ${beat.function.trim().replace(/\s+/g, ' ')}`,
        beat.constraints.map((c) => `- ${c.trim().replace(/\s+/g, ' ')}`).join('\n'),
        `LENGTH: ${min} to ${max} words.`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  return [
    BUSINESS_INSTRUCTION.replace(/\{HOST\}/g, host.name)
      .replace(/\{SHOW\}/g, input.persona.name)
      .replace('{JARGON}', kind === 'short' ? JARGON_SHORT : JARGON_EPISODE),
    '',
    `THE SUBJECT: ${input.subject}`,
    '',
    signoff
      ? `HOW THIS SHOW SIGNS OFF. The last part ends on this, in your own words rather than ` +
        `word for word, and it is the last thing said:\n  ${signoff}`
      : 'The last part ends by asking the listener to follow for more business stories.',
    '',
    `THE WHOLE SCRIPT IS ${floor} TO ${ceiling} WORDS, goodbye included. ` +
      (kind === 'short'
        ? 'Over that it runs past three minutes and cannot be used. Cut detail, never the ending.'
        : 'Use the room: this is a deep dive, and a short episode is a failed one.'),
    '',
    `Return JSON only: {"title": "...", "description": "...", "beats": [{"beatId": "...", ` +
      `"turns": [{"speaker": "${host.id}", "text": "..."}]}]}`,
    `THE ONLY SPEAKER ID IS "${host.id}". One turn per part.`,
    '',
    'THE PARTS, in order:',
    '',
    parts,
    '',
    '=========================================================',
    'THE SOURCE. Every fact in the story comes from here.',
    '=========================================================',
    '',
    `TITLE: ${input.source.title}`,
    `URL: ${input.source.url}`,
    '',
    input.source.text.slice(0, input.readChars),
  ].join('\n');
};

export const REVISE_BUSINESS = `Your previous draft failed the specific checks below.
Write the whole script again, fixing every one of them and changing nothing that
was not wrong. A figure or quotation that is not in the source must be removed
or corrected to what the source says.`;

export const writeBusinessScript = async (
  input: BusinessScriptInput,
  writer: LlmClient,
  check: (draft: BusinessDraft) => string[],
  onCost?: (pence: number) => void,
  onProgress?: (message: string) => void,
  allowRevisions = false
): Promise<{ script: Script; problems: string[] }> => {
  const system = buildBusinessSystem(input.persona);
  const prompt = buildBusinessPrompt(input);
  const speaker = input.persona.hosts[0]!.id;
  const budget = allowRevisions ? 1 : 0;

  let draft: BusinessDraft | undefined;
  let problems: string[] = [];
  let revisions = 0;

  for (let attempt = 0; attempt <= budget; attempt += 1) {
    const ask =
      attempt === 0
        ? prompt
        : `${prompt}\n\n${REVISE_BUSINESS}\n\nWHAT FAILED:\n${problems.map((p) => `- ${p}`).join('\n')}`;

    const reply = await completeJson<unknown>(
      writer,
      {
        system,
        prompt: ask,
        // An episode is ~2,400 words out, about 3,300 tokens, plus thinking.
        maxTokens: input.format.kind === 'short' ? 6_000 : 14_000,
        // LOW, as on every cheap lane: thinking bills at output rates.
        effort: 'low',
        cacheSystem: true,
        temperature: 0.8,
      },
      onCost
    );

    draft = businessDraftSchema.parse(reply);
    revisions = attempt;
    problems = check(draft);
    if (!problems.length) break;
    onProgress?.(
      budget === 0
        ? `${problems.length} problem(s), and revisions are OFF so none were fixed: ${problems.join('; ')}`
        : `${problems.length} problem(s)${attempt < budget ? ', rewriting' : ' still there'}: ${problems.join('; ')}`
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
