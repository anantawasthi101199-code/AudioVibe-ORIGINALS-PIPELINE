/**
 * The psychology writer. An episode from the fused understanding, or a short
 * from one article, each in ONE call.
 *
 * THE RULES BELOW ARE TAKEN FROM A SCRIPT THE OWNER SUPPLIED as the target, an
 * episode about ADHD overwhelm. What follows is what that script actually does,
 * because every one of these turned out to be load-bearing:
 *
 *   It opens on a MOMENT, in the second person, with an everyday comparison
 *   ("your brain feels like a browser with fifty tabs open"), and it does that
 *   before it names the subject.
 *
 *   It removes the blame in the first four sentences. "You're not doing it on
 *   purpose. You're not avoiding the task." Then: "you are not alone", then the
 *   name of the thing, then a promise of three things the episode will do.
 *
 *   It is built on ONE PICTURE, named and sustained: a control panel of
 *   blinking buttons. The picture carries the science ("everything shows up at
 *   the same volume"), and the last lines of the episode come back to it
 *   ("your control panel isn't broken, it's overloaded"). That callback is what
 *   makes an episode memorable a week later, and it is checked for.
 *
 *   It uses exactly one piece of real jargon and glosses it in the same breath:
 *   "the prefrontal cortex, the part of the brain that helps you organize and
 *   initiate tasks". Everything else is ordinary words.
 *
 *   It corrects a belief rather than listing facts: "people often think ADHD is
 *   about distraction, but it's actually about regulation".
 *
 *   It says the listener's own thoughts back to them, in their words: "Why
 *   can't I just do it? Everyone else seems fine."
 *
 *   Its advice is SUBTRACTION, each with a worked before and after: "clean the
 *   kitchen" becomes "pick up one item and throw it away". And its emotional
 *   version of the same move: "you don't need to trust the whole task, just
 *   trust the next two minutes".
 *
 *   It has one small human aside, and it is warm rather than a joke.
 *
 *   It ends with one tiny thing to do, a rhythmic line, and then the goodbye.
 *
 * WHAT IS NOT IN THE SAMPLE AND IS REQUIRED HERE: the safety floor. The sample
 * never diagnoses anybody, never mentions medication and never promises a cure,
 * which is exactly right, and psych/check.ts enforces all three for free rather
 * than trusting a prompt with it.
 */
import { z } from 'zod';
import { Persona } from '../canon/schema';
import { EpisodeFormat } from '../formats/schema';
import { completeJson, LlmClient } from '../models/client';
import { EAR_RULES, Script, ScriptBeat, wordsForBeat } from '../script/write';
import { NETWORK_BANNED_PHRASES } from '../script/style';
import { signoffFor } from '../script/storyScript';
import { turnSchema } from '../script/dialogue';
import { Understanding, renderUnderstanding } from './understand';

/** How the show talks. Shared by both formats, because it is the same person. */
export const PSYCH_VOICE = `HOW YOU TALK.

YOU ARE TALKING TO ONE PERSON, and you say "you" constantly. Not "people with
anxiety", not "sufferers", not "one might". You. This is the single biggest
difference between this show and every other psychology explainer, and it is
what makes somebody feel understood rather than studied.

WARM, CALM, UNHURRIED. The way a friend who happens to know this subject would
explain it to you on a walk. Never clinical, never a lecture, never a
motivational speech, and never bright and breezy about something that is hard.

VALIDATE, THEN EXPLAIN, THEN HELP. In that order, always. Somebody who feels
judged cannot hear an explanation, and somebody who does not understand what is
happening cannot use advice. The sample script spends its first minute entirely
on "this is real, it is not your fault, and it has a name".

SAY THEIR OWN THOUGHTS BACK TO THEM, in their words, as thoughts: "Why can't I
just do it? Everyone else seems fine. What is wrong with me?" Hearing your own
inner voice said out loud by somebody who is not judging it is the most
comforting thing this show does.

TAKE THE BLAME OUT, EXPLICITLY. Say what this is NOT, plainly: "it is not
laziness", "it is not a lack of willpower", "not because you are bad at this".
Do it early, and do it again when the emotional part gets heavy.

EXPLAIN LIKE THIS.
- One idea per sentence. Most sentences eight to eighteen words.
- Contractions everywhere: "it's", "you're", "here's", "doesn't".
- Short sentences and fragments are fine. So are one-line paragraphs.
- Everyday comparisons for anything hard to picture: fifty tabs open, too many
  programs running, a phone on five per cent, a smoke alarm that cannot tell
  toast from a fire. Ordinary life, never another technical thing.
- A term you cannot avoid gets its plain meaning in the SAME sentence: "the
  prefrontal cortex, the part of the brain that helps you organise and start
  things". Never a term without its gloss, and never a gloss in a later
  sentence.
- Worked examples, not categories. "Clean the kitchen becomes pick up one item
  and throw it away" teaches more than a paragraph about breaking tasks down.

RHYTHM, BECAUSE THIS IS HEARD AND NOT READ.
- Repeat a shape when it lands: "It stops motivation. It stops clarity. It
  stops the ability to choose."
- Contrast pairs: "It's not that your brain doesn't know what to do. It's that
  it can't tell where to begin."
- Land a section on a short sentence, then move.

ONE SMALL HUMAN MOMENT somewhere in the middle: a light aside in your own voice,
the way a person interrupts themselves. Warm, quick, never a joke at the
listener's expense, and never more than one.

NEVER.
- Never tell the listener they have a condition, and never imply it. You are
  explaining an experience many people have, whether or not anyone has named it
  for them. "If this is you" and "people who live with this" are fine; "you have
  this" is not.
- Never mention starting, stopping, choosing or changing any medication or
  therapy, and never name a drug. That a professional is the person to ask is
  fine to say.
- Never promise this can be cured, fixed or made to go away.
- Never say "just" about anything difficult. "Just start", "just breathe" is the
  sentence that makes somebody feel worse.
- No hype, no shock, no "science says" without saying who found it, no listicles,
  no life-coach voice, no pretending this is easy.
- Never say "the article", "the source", "the research I read" or "studies
  show" as your authority. Say what is known, plainly, the way you would to a
  friend.`;

export const PSYCH_INSTRUCTION = `You are {HOST}, host of {SHOW}. You explain how the
mind works to one person who is listening with headphones in and nothing to
look at, and who very likely came to this episode because they are living it.

${PSYCH_VOICE}

THE PICTURE. This episode is built on ONE everyday image, given to you below.
Build it early, in your own words. Explain the science THROUGH it, so the
mechanism arrives as part of the picture rather than as a separate paragraph of
biology. Then come back to it in the last part and land the episode on it. Do
not invent a second competing picture; smaller everyday comparisons alongside it
are fine and good.

EVERYTHING FACTUAL COMES FROM THE UNDERSTANDING BELOW. The mechanism, the
corrections, the figures, what helps: all of it. Nothing from your own knowledge
of psychology, however confident you are. What you bring yourself is the telling:
the ordinary comparisons, the rhythm, the warmth, the way it is put in order.

USE ALL OF IT. The understanding was written for this episode; if a whole
section of it never reaches the script, the episode is thinner than the research
it came from.

THE ENDING. One tiny thing they can actually do today, drawn from what helps and
made smaller than they expect. Then the goodbye, which is the last thing said.

A TITLE AND DESCRIPTION. The title names the experience the way somebody would
search for it, plainly, in about eight words. No colon, no question, no
clickbait, no "the science of". The description is two sentences saying what the
episode explains and who will recognise themselves in it.`;

export const PSYCH_SHORT_INSTRUCTION = `You are {HOST}, host of {SHOW}. You have under
three minutes to make one person feel understood and explain one thing about
how their mind works, simply enough that they can use it today.

${PSYCH_VOICE}

THIS IS A SHORT, so everything above still holds and the budget is brutal.
- ONE idea. Not the whole subject: the one part of it that explains the moment.
- ONE comparison, and it carries the explanation.
- NO jargon at all. If a term cannot be avoided, it gets four plain words and
  nothing more.
- No list of strategies. ONE thing to try, small enough to do today.
- The opening is the moment itself, in the second person. No greeting first,
  no naming the show: somebody scrolling gave you about three seconds.

EVERYTHING FACTUAL COMES FROM THE ARTICLE BELOW, and nothing from your own
knowledge. The warmth and the comparison are yours.

A TITLE AND DESCRIPTION. The title is the experience in about eight plain words.
The description is one or two sentences.`;

export const psychDraftSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  beats: z.array(z.object({ beatId: z.string(), turns: z.array(turnSchema).min(1) })),
});

export type PsychDraft = z.infer<typeof psychDraftSchema>;

export const buildPsychSystem = (persona: Persona): string => {
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
    'HOW IT EXPLAINS',
    canon('stylistic_rule') || '- (none recorded)',
    '',
    'WRITING FOR AUDIO',
    ...EAR_RULES.slice(0, 2).map((r) => `- ${r}`),
    '',
    'NEVER USE THESE PHRASES',
    ...NETWORK_BANNED_PHRASES.concat(persona.styleCard.forbiddenPhrases).map((p) => `- ${p}`),
  ].join('\n');
};

const partsOf = (format: EpisodeFormat): string =>
  format.beats
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

const shell = (input: {
  persona: Persona;
  format: EpisodeFormat;
  instruction: string;
  seed: string;
  body: string[];
}): string => {
  const host = input.persona.hosts[0]!;
  const kind = input.format.kind;
  const signoff = signoffFor(input.persona, kind, input.seed);
  const ceiling = input.format.beats.reduce((n, b) => n + wordsForBeat(b).max, 0);
  const floor = input.format.beats.reduce((n, b) => n + wordsForBeat(b).min, 0);

  return [
    input.instruction
      .replace(/\{HOST\}/g, host.name)
      .replace(/\{SHOW\}/g, input.persona.name),
    '',
    signoff
      ? `HOW THIS SHOW SAYS GOODBYE. The last part lands on this, in your own words rather ` +
        `than word for word, and it is the last thing said:\n  ${signoff}`
      : 'The last part ends by asking the listener to follow the show.',
    '',
    `THE WHOLE SCRIPT IS ${floor} TO ${ceiling} WORDS, goodbye included. ` +
      (kind === 'short'
        ? 'Over that it runs past three minutes and cannot be used.'
        : 'Use the room. A thin episode on a subject somebody is living is a failed one.'),
    '',
    `Return JSON only: {"title": "...", "description": "...", "beats": [{"beatId": "...", ` +
      `"turns": [{"speaker": "${host.id}", "text": "..."}]}]}`,
    `THE ONLY SPEAKER ID IS "${host.id}". One turn per part.`,
    '',
    'THE PARTS, in order:',
    '',
    partsOf(input.format),
    '',
    ...input.body,
  ].join('\n');
};

export const buildEpisodePrompt = (input: {
  persona: Persona;
  format: EpisodeFormat;
  understanding: Understanding;
}): string =>
  shell({
    persona: input.persona,
    format: input.format,
    instruction: PSYCH_INSTRUCTION,
    seed: input.understanding.subject,
    body: [
      '=========================================================',
      'THE UNDERSTANDING. Everything factual in the episode comes from here.',
      '=========================================================',
      '',
      renderUnderstanding(input.understanding),
    ],
  });

export const buildShortPrompt = (input: {
  persona: Persona;
  format: EpisodeFormat;
  topic: string;
  article: { title: string; url: string; text: string };
  readChars: number;
}): string =>
  shell({
    persona: input.persona,
    format: input.format,
    instruction: PSYCH_SHORT_INSTRUCTION,
    seed: input.topic,
    body: [
      `THE SUBJECT: ${input.topic}`,
      '',
      '=========================================================',
      'THE ARTICLE. Everything factual comes from here.',
      '=========================================================',
      '',
      `TITLE: ${input.article.title}`,
      '',
      input.article.text.slice(0, input.readChars),
    ],
  });

export const REVISE_PSYCH = `Your previous draft failed the checks listed below. Write
the whole script again, fixing every one of them and changing nothing that was
not wrong.`;

/**
 * One call, both formats. Mirrors the other lanes: free checks always run, and
 * a rewrite is only ever paid for when it has been asked for.
 */
export const writePsychScript = async (
  input: { persona: Persona; format: EpisodeFormat; prompt: string },
  writer: LlmClient,
  check: (draft: PsychDraft) => string[],
  onCost?: (pence: number) => void,
  onProgress?: (message: string) => void,
  allowRevisions = false
): Promise<{ script: Script; problems: string[] }> => {
  const system = buildPsychSystem(input.persona);
  const speaker = input.persona.hosts[0]!.id;
  const budget = allowRevisions ? 1 : 0;
  const short = input.format.kind === 'short';

  let draft: PsychDraft | undefined;
  let problems: string[] = [];
  let revisions = 0;

  for (let attempt = 0; attempt <= budget; attempt += 1) {
    const ask =
      attempt === 0
        ? input.prompt
        : `${input.prompt}\n\n${REVISE_PSYCH}\n\nWHAT FAILED:\n${problems
            .map((p) => `- ${p}`)
            .join('\n')}`;

    const reply = await completeJson<unknown>(
      writer,
      {
        system,
        prompt: ask,
        maxTokens: short ? 6_000 : 14_000,
        // LOW, AS ON EVERY CHEAP LANE. Thinking bills at output rates, and the
        // understanding has already done the deciding this script needs.
        effort: 'low',
        cacheSystem: true,
        // Warm writing, and the facts are held by the understanding and the
        // free checks rather than by a cold temperature.
        temperature: 0.85,
      },
      onCost
    );

    draft = psychDraftSchema.parse(reply);
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
