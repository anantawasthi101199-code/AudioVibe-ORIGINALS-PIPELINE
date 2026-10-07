/**
 * Filling beats with conversation.
 *
 * EVERY BEAT IS TURNS. A narrated show is a cast of one and produces beats with
 * a single turn; a two-host show produces an exchange. One code path, because a
 * special case for monologue is a special case that rots.
 *
 * WRITTEN FOR THE EAR, which is a real constraint rather than a style note. A
 * listener cannot re-read a sentence, cannot see a parenthesis, and cannot tell
 * a semicolon from a full stop.
 *
 * THE WRITER SEES ONLY WHAT IT NEEDS. The beat it is writing, the claims for
 * that beat, and what the previous beat ended on. Not the whole corpus, because
 * a writer holding fourteen documents starts summarising them instead of
 * writing the beat. Not the whole script, because that is how a ten minute
 * episode drifts into a different show halfway through.
 *
 * IT CANNOT INTRODUCE FACTS. Every factual assertion has to come from the claims
 * it is handed, which are already bound to verified quotes. That is why claims
 * are passed in and sources are not.
 *
 * AND IT GETS A SECOND CHANCE. Writing once and judging is how the first
 * version of this worked, and it wasted every rejection: the gate knew exactly
 * what was wrong and the only available response was a human. Now a beat that
 * fails its deterministic checks is handed those failures and rewritten. The
 * literature on long-form generation is consistent that draft-critique-revise
 * is where quality comes from, and it costs one extra call on the beats that
 * need it rather than on every beat.
 */
import { z } from 'zod';
import { Persona, canonAsOf, isDialogueShow } from '../canon/schema';
import { Beat, EpisodeFormat } from '../formats/schema';
import { Claim } from '../evidence/claim';
import { completeJson, LlmClient } from '../models/client';
import { NETWORK_BANNED_PHRASES, checkStyle } from './style';
import { loopBrief, openBefore } from './loops';
import { checkVoices, voiceBrief } from './voices';
import { writeHook } from './hooks';
import { SHORT_FORM_GUIDANCE } from './shorts';
import { NARRATION_GUIDANCE, narrationTagsFor } from './narration';
import { StoryPlan, checkCast, planBrief, planStory, storyPlanSchema } from './plan';
import { FORWARD_GUIDANCE, checkBridge, checkForward, checkRepetition } from './forward';
import { PLAIN_GUIDANCE, checkPlainWords } from './plain';
import { CONTEXT_GUIDANCE } from './context';
import { PRONOUN_RULE } from '../qa/pronouns';
import {
  checkDialogue,
  DIALOGUE_GUIDANCE,
  DialogueProblem,
  stripUnknownTags,
  Turn,
  turnSchema,
  withoutTags,
} from './dialogue';

export const scriptBeatSchema = z.object({
  beatId: z.string(),
  beatType: z.string(),
  turns: z.array(turnSchema).min(1),
  /** Claim ids this beat used, so the ledger can be traced to the audio. */
  claimIds: z.array(z.string()).default([]),
  /** How many revision passes this beat needed. Useful signal about a format. */
  revisions: z.number().int().nonnegative().default(0),
});

export type ScriptBeat = z.infer<typeof scriptBeatSchema>;

export const scriptSchema = z.object({
  personaId: z.string(),
  formatId: z.string(),
  title: z.string().min(1),
  description: z.string().min(1),
  beats: z.array(scriptBeatSchema).min(1),
  writerModel: z.string(),
  /**
   * The plan the episode was written to, kept with the script.
   *
   * IT USED TO LIVE ONLY IN A CHECKPOINT, which is deleted when the run
   * finishes - so by the time the gate ran, the cast roster that every beat had
   * been written against no longer existed anywhere. The pronoun check needs
   * it, and so does anybody reading a finished run afterwards and asking why a
   * beat introduced somebody where it did.
   *
   * Optional so that scripts written before this parse unchanged.
   */
  plan: storyPlanSchema.optional(),
});

export type Script = z.infer<typeof scriptSchema>;

/**
 * Words per second of speech, for turning a target duration into a word count.
 *
 * MEASURED, NOT GUESSED, AND THE GUESS WAS 9% LOW. Two finished episodes came
 * in at 2.83 and 2.87 words per second of rendered audio against an assumed
 * 2.6, so every beat was given a word target that under-fills its slot even
 * when the writer hits it exactly. Compounded across six beats that is most of
 * a minute, and it is why an episode written to a 13-17 minute format rendered
 * at 8 minutes 24.
 *
 * Worth re-measuring whenever the voice provider changes: this is a property of
 * the speaking rate, and Eleven at 0.35 stability will not be OpenAI's.
 */
export const WORDS_PER_SECOND = 2.85;

/**
 * How many times a beat may be rewritten before the run gives up on it.
 *
 * Two. A first rewrite fixes the ordinary case; a second catches a beat that
 * traded one violation for another. Past that the failure is usually in the
 * claims or the beat definition rather than the prose, and burning calls on it
 * spends money to arrive at the same place.
 */
export const MAX_REVISIONS = 2;

/**
 * How far past the card's sentence-length target a beat may sit before it is
 * rewritten rather than merely noted.
 *
 * 1.45, which is a fault threshold and not a bullseye. The card target is what
 * good prose for this show measures; this is the point at which a beat has
 * stopped being followable by ear. For a card of 13 that is 18.9 words a
 * sentence: a beat at 16 is left alone, a beat at 21 is sent back.
 *
 * Set from three measured scripts at 23.7, 26.1 and 21.2 against references at
 * 12.2 and 12.6. Anything tighter would fire on every draft and spend the
 * revision budget chasing a decimal place.
 */
export const REWRITE_SENTENCE_MULTIPLE = 1.45;

/**
 * How many of a beat's own facts it may leave unused while running short.
 *
 * ONE. A beat routinely has a fact that does not fit the telling, and arguing
 * about it would be arguing about taste. Two or more, in a beat that has also
 * come in under its length guide, is not taste: it is material that was
 * researched, verified, routed to this beat and then skipped.
 *
 * Measured on three runs of one topic. The story beat used 15 of 16, then 17 of
 * 18, then 19 of 25 - and the run that left six behind is the run that lost the
 * seven gates, which is the spine of the myth.
 */
export const SKIPPED_CLAIMS_ALLOWED = 1;

export const wordsForBeat = (beat: Beat): { min: number; max: number } => ({
  min: Math.round(beat.seconds[0] * WORDS_PER_SECOND),
  max: Math.round(beat.seconds[1] * WORDS_PER_SECOND),
});

/** Everything a beat's turns say, tags removed, for scoring and for length. */
export const beatText = (beat: { turns: Turn[] }): string =>
  beat.turns.map((t) => withoutTags(t.text)).join('\n');

export const fullText = (script: Script): string =>
  script.beats.map((b) => beatText(b)).join('\n\n');

/** What the writer wrote: fullText without fixed channel text (the outro). For style scoring. */
export const writtenText = (script: Script): string =>
  script.beats
    .map((b) => beatText({ turns: b.turns.filter((t) => !t.fixed) }))
    .filter(Boolean)
    .join('\n\n');

/**
 * The few things about audio a good writer would not otherwise know.
 *
 * CUT FROM EIGHT RULES TO FOUR, and the cut is the point. This list had grown
 * into craft instruction - vary your sentence length, keep under twenty-five
 * words, put the person first, prefer concrete nouns - and every one of those
 * was telling a language model how to write, which is the one thing it does not
 * need telling. What came back was a show that measured well and sounded
 * managed, because it was.
 *
 * The test for anything in this list: would a good writer get it wrong WITHOUT
 * being told, for a reason specific to audio or to this pipeline? A semicolon
 * is inaudible, so that stays. "Vary sentence length" is what writing is, so it
 * goes - and the style card still measures the result, which is the right place
 * for it: measuring an outcome leaves the writer free to reach it their own
 * way, while instructing the technique does not.
 *
 * The FACTS block below this in the prompt is a different kind of rule and is
 * not being relaxed. Constraining what may be asserted is the job; constraining
 * how it is phrased is not.
 */
export const EAR_RULES = [
  'Write for the ear. This will be spoken aloud by one voice to somebody who cannot see the page and cannot rewind.',
  'Nothing that only works in print: no dashes of any kind holding a sentence together, no parentheses, no semicolons, no bullet points, no headings, no "firstly, secondly, finally". A listener cannot hear any of them.',
  'Numbers as a person says them out loud. "About three in ten", not "31.4 per cent". The exact figure lives in the sources list.',
  'Write whatever length of sentence the moment wants. A long one that gathers several things and lands them together is usually the best sentence in a beat.',
];

export const buildSystem = (persona: Persona, isoDate: string, kind: 'long' | 'short'): string => {
  const canon = canonAsOf(persona, isoDate);
  const say = (kind: string) =>
    canon
      .filter((c) => c.kind === kind)
      .map((c) => `- ${c.text.trim().replace(/\s+/g, ' ')}`)
      .join('\n');

  // Roles AND measurable speech habits. The habits are what stop two hosts
  // converging into one person by the fourth beat.
  const cast = voiceBrief(persona.hosts);

  const dialogue = isDialogueShow(persona);

  return `You write one beat of an audio show, as spoken turns.

SHOW: ${persona.name}
THESIS: ${persona.thesis.trim().replace(/\s+/g, ' ')}
AUDIENCE: ${persona.audience.trim().replace(/\s+/g, ' ')}
REGISTER: ${persona.register.trim().replace(/\s+/g, ' ')}

THE CAST
${cast}

WHAT THIS SHOW BELIEVES
${say('belief') || '- (none recorded)'}

WHAT THIS SHOW NEVER DOES
${say('taboo') || '- (none recorded)'}

HOW IT WRITES
${say('stylistic_rule') || '- (none recorded)'}

WRITING FOR AUDIO
${EAR_RULES.map((r) => `- ${r}`).join('\n')}

KEEPING THE STORY MOVING FORWARD
${FORWARD_GUIDANCE.map((r) => `- ${r}`).join('\n')}

PLAIN WORDS
${PLAIN_GUIDANCE.map((r) => `- ${r}`).join('\n')}

PLACING THINGS FOR A LISTENER
${CONTEXT_GUIDANCE.map((r) => `- ${r}`).join('\n')}
${
  dialogue
    ? `\nWRITING A CONVERSATION\n${DIALOGUE_GUIDANCE.map((r) => `- ${r}`).join('\n')}`
    : // A SOLO SHOW IS NOT A DIALOGUE SHOW WITH ONE SPEAKER. Dialogue gets
      // varied pace, rhetorical questions and changes of register for free,
      // because two people interrupting each other produce them. A narrator has
      // none of that, so every one of those effects has to be written in - and a
      // model handed the dialogue rules and one speaker writes an essay.
      `\nWRITING NARRATION FOR ONE VOICE\n${NARRATION_GUIDANCE.map((r) => `- ${r}`).join('\n')}` +
      `\n\nDELIVERY\n${narrationTagsFor(persona).map((r) => `- ${r}`).join('\n')}`
}
${
  kind === 'short'
    ? `\nTHIS IS A SHORT, NOT AN EPISODE\n${SHORT_FORM_GUIDANCE.map((r) => `- ${r}`).join('\n')}`
    : ''
}

NEVER USE THESE PHRASES
${NETWORK_BANNED_PHRASES.concat(persona.styleCard.forbiddenPhrases)
  .map((p) => `- ${p}`)
  .join('\n')}

FACTS
${PRONOUN_RULE}

You may state a fact ONLY if it appears in the CLAIMS you are given. Do not add
figures, dates, names or causes from your own knowledge, however confident you
are. If a claim is not there, write around it. Claims are pre-verified against
their sources; anything you add is not.

SAY THE WORDS OUT LOUD WHERE A CLAIM CARRIES THEM. A claim marked WORDS is a
verbatim line from the text this episode is about, and reading it aloud is the
single strongest sentence available to you. Introduce it the way a person would
- who wrote it, or what it is from, in a handful of words - and then say it, and
then stop. Do not paraphrase it first and quote it second, that is the same
thing twice. Do not quote more than two or three of them in one beat, because
the effect is contrast and a beat that is all quotation has none.

CONNECT A CLAIM TO WHAT THE EPISODE HAS ALREADY SAID. A claim is written to be
true standing on its own, because it cannot know what has been said before it.
You do know. So a claim reading "three of the six ringleaders were each
sentenced to seven years in prison", in a beat that has already given sentences
for Reader, Wood and Doyle, is spoken as "the OTHER three each got seven years".
Same fact, and it lands in the story instead of beside it. Never do this unless
the connection is actually true of what you have written.

Some claims are marked NOT SETTLED. Use them - they are often the most
interesting thing in a beat - and say plainly what the record does not
establish, in your own words, at the point in the story where it matters.
"Nobody wrote down which of them decided" is a better sentence than a confident
guess and a better sentence than a silence, and it is most of what this show is
for. A beat that uses one of these without saying what is unsettled is rejected.

Return JSON only:
{"turns": [{"speaker": "${persona.hosts[0]!.id}", "text": "..."}], "claimIds": ["ids used"]}`;
};

export interface BeatContext {
  /**
   * Whether a beat that fails its critique is PAID TO BE REWRITTEN.
   *
   * The critique itself is deterministic and free and runs either way. This
   * decides whether a model is bought to act on it. Default false - see
   * config/stages.ts.
   */
  allowRevisions?: boolean;
  persona: Persona;
  format: EpisodeFormat;
  beat: Beat;
  claims: Claim[];
  /** The tail of the previous beat, so the join does not read as a seam. */
  previousTail?: string;
  /**
   * Everything already written, in order.
   *
   * TWENTY-FIVE WORDS WAS NOT ENOUGH, and that one number caused most of what
   * was wrong with the first real episode. A beat that can only see the last
   * sentence cannot know what the listener believes, who has been introduced,
   * or what has already been said - so it re-introduces people, repeats facts,
   * and overturns things that were never established.
   */
  storySoFar?: string;
  /** The plan for the whole episode, with this beat marked. Prompt text. */
  plan?: string;
  /**
   * The same plan as data, for the checks that need it.
   *
   * Kept alongside the rendered brief rather than replacing it: the writer
   * wants prose, and checkCast wants the roster and the beat order. Deriving
   * one from the other at either end would be parsing something we already
   * have structured.
   */
  storyPlan?: StoryPlan;
  angle: string;
  isoDate: string;
  /**
   * Which story this beat tells, for an anthology only.
   *
   * Ten beats expanded from one definition share a function, so without this a
   * writer handed claims for beat four has nothing saying it is the Nandi one.
   * See storyForBeat.
   */
  subject?: string;
  /**
   * What this beat must leave unanswered, and what it must answer.
   *
   * Handed over as an instruction rather than left to inference. "Do not answer
   * this" is followable; "be intriguing" is not.
   */
  loops?: string;
  /**
   * A pre-selected opening line for the first beat.
   *
   * Chosen by a competition the writer never sees, so it cannot talk itself out
   * of a strong opening. See writeScript and hooks.ts.
   */
  openWith?: string;
}

/**
 * Claims as the writer sees them.
 *
 * UNVERIFIED CLAIMS ARE MARKED, NOT HIDDEN. They survived extraction, the
 * deterministic quote check, verification, a narrowing pass and a rebinding
 * pass, and what is left is a gap the record genuinely does not close. Dropping
 * them cost real content - one episode named six men and gave sentences for two
 * - so they are handed over together with the thing that has to be said about
 * them.
 *
 * Shared with the one-pass writer, so the two ways of writing a script describe
 * the evidence in exactly the same words. A difference here would show up as a
 * difference in the output and be read as a difference between the methods.
 */
export const renderClaims = (claims: Claim[]): string => {
  // AN UNVERIFIED CLAIM IS NOT OFFERED AT ALL, and this reverses an earlier
  // decision that turned out to cost far more than it saved.
  //
  // They used to be handed over marked NOT SETTLED, with a hedge the script was
  // required to say and a gate check that blocked the beat if it did not. The
  // reasoning was that dropping them cost real content - and it had, once, when
  // every failing claim was dropped outright and an episode named six men and
  // gave sentences for two.
  //
  // What changed is that narrowing and rebinding now save most of them, so what
  // is left unverified is genuinely unsupported. And the cost of keeping them
  // is visible in the prose. A set of ten Hindu myths came back with story one
  // as a story and story seven as a literature review about a story: "one line
  // in the record names his mother as Chhaya", "the sources do not settle why
  // that substitution happened", "the record does not name her, does not
  // confirm which text the story properly belongs to". Three unverified claims,
  // three sentences of epistemics, and a listener who never met Shani.
  //
  // So: if the record does not support it, do not say it. That is simpler than
  // saying it and then saying you cannot support it, and it is what a person
  // who knew the subject would do. The claims are still in the ledger and still
  // on the run's page, where the human reading the script before it is voiced
  // can see exactly what did not survive.
  const usable = claims.filter((c) => c.status !== 'unverified');

  // A QUOTATION CLAIM CARRIES ITS WORDS, and until now it did not.
  //
  // THE BIGGEST UNUSED ASSET IN THE PIPELINE. Every claim is bound to a verbatim
  // span that provably occurs in a fetched document, the span is checked twice,
  // and the writer was never shown a single one of them. So a studio whose whole
  // claim is that somebody went and read the file was paraphrasing the file, and
  // the strongest sentence available in any episode - the line from the text,
  // read out - was sitting in claims.json where no listener could reach it.
  //
  // Measured on the transcripts this network is trying to stand beside: one gives
  // 4.5% of its sentences to primary text spoken at length, and those block quotes
  // ARE the show. One of this studio's own scripts quotes nothing at all.
  //
  // Only for `quotation` claims, deliberately. Handing over the supporting span
  // for every claim would invite the writer to reproduce source prose generally,
  // which is how a told story turns back into a literature review. A quotation
  // claim exists precisely because somebody said words worth hearing.
  const render = (c: Claim): string => {
    const line = `[${c.id}] (${c.type}) ${c.text}`;
    return c.type === 'quotation'
      ? `${line}\n      WORDS, exactly as the text has them: "${c.quote.replace(/\s+/g, ' ').trim()}"`
      : line;
  };

  return usable.length
    ? usable.map(render).join('\n')
    : '(none available - write this beat without stating new facts)';
};

export const buildPrompt = (ctx: BeatContext): string => {
  const { min, max } = wordsForBeat(ctx.beat);
  const claims = renderClaims(ctx.claims);

  return [
    `EPISODE ANGLE: ${ctx.angle}`,
    `BEAT: ${ctx.beat.id} (${ctx.beat.type})`,
    ctx.subject ? `THIS BEAT TELLS: ${ctx.subject}` : '',
    `THIS BEAT MUST: ${ctx.beat.function}`,
    ctx.beat.constraints.length
      ? `CONSTRAINTS:\n${ctx.beat.constraints.map((c) => `- ${c}`).join('\n')}`
      : '',
    // A GUIDE, SAID TO BE A GUIDE. Given as a hard target, a beat with four
    // claims' worth of material to cover writes to the number instead of to the
    // material, and what fills the gap is a second description of something
    // already described.
    `LENGTH: roughly ${min} to ${max} words, but this is a guide and not a ` +
      `target. Say what the claims support, as fully as they support it, and ` +
      `then stop. A short beat that says everything once is right. Never reach ` +
      `for length.`,
    ctx.plan ?? '',
    // THE WHOLE SCRIPT SO FAR, not a sentence of it. Sent in the prompt rather
    // than the system block because it changes every beat and would invalidate
    // the cached prefix; as input tokens it is trivial next to what it fixes.
    ctx.storySoFar
      ? `THE EPISODE SO FAR, word for word. Do not repeat any of it, do not ` +
        `re-introduce anybody already introduced, and continue from where it ` +
        `leaves off:\n${ctx.storySoFar}`
      : 'This is the opening beat. Nothing has been said yet.',
    ctx.previousTail ? `IT ENDED ON:\n"...${ctx.previousTail}"` : '',
    ctx.loops ? `CURIOSITY - what this beat must and must not answer:\n${ctx.loops}` : '',
    ctx.openWith ? `OPEN WITH EXACTLY THIS LINE, then continue:\n"${ctx.openWith}"` : '',
    `CLAIMS:\n${claims}`,
    // SPELL NAMES EXACTLY AS THE CLAIMS SPELL THEM. Beats are written
    // separately and cannot see each other, so a name the sources give three
    // ways - Geillis, Gillis, Gilly - comes out three ways across one episode
    // and a listener hears two different people. The claims are the one thing
    // every beat of an episode does share, so they are the authority.
    'Spell every name exactly as the CLAIMS above spell it, even if you know ' +
      'another spelling. The other beats of this episode are written from the ' +
      'same claims and have to agree with you.',
    // Beats cannot see each other, so nothing stops four of them opening the
    // same way. The gate blocks it; saying so here is cheaper than a rewrite.
    'Do not open with "Start with", "Here is", "So", or any phrase that sounds ' +
      'like the beginning of a section. Open inside the thought.',
  ]
    .filter(Boolean)
    .join('\n\n');
};

/** The shape a beat must come back in. Shared with completeJson so a wrong one is retried. */
const beatReplySchema = z.object({
  turns: z.array(turnSchema).min(1),
  claimIds: z.array(z.string()).default([]),
});

const parseTurns = (raw: unknown, hostTags: readonly string[] = []): { turns: Turn[]; claimIds: string[] } => {
  const parsed = beatReplySchema.parse(raw);

  return {
    // Unknown tags are stripped here rather than rejected. The renderer speaks
    // anything bracketed it does not recognise, so an invented tag becomes a
    // host saying "thoughtful" out loud mid-sentence.
    turns: parsed.turns.map((t) => ({
      speaker: t.speaker.trim(),
      text: stripUnknownTags(t.text, hostTags).replace(/\s+/g, ' ').trim(),
    })),
    claimIds: parsed.claimIds,
  };
};

/**
 * Everything wrong with a draft beat, deterministically.
 *
 * Style and dialogue structure only. Factuality is not checked here because the
 * writer was only given verified claims in the first place, and re-checking it
 * per draft would multiply the verifier's cost by the revision count.
 */
export const critiqueBeat = (
  turns: Turn[],
  persona: Persona,
  beat: Beat,
  /**
   * The episode plan, when there is one.
   *
   * Optional because the checks that need it are the only ones in this function
   * that look OUTSIDE the beat, and a caller without a plan should still get
   * every check that does not need one.
   */
  plan?: StoryPlan,
  /**
   * Everything the episode has already said.
   *
   * The only input to this function that comes from outside the beat, and the
   * only way repetition can be caught at all - a beat written on its own
   * genuinely cannot tell that its best phrasing for something is also the
   * phrasing two beats ago reached for.
   */
  storySoFar?: string,
  /**
   * The claims this beat was given, so the check can tell which are unsettled.
   *
   * Defaulted to empty rather than required: every other check in here works
   * without claims, and a caller that has none should still get them all.
   */
  claims: Claim[] = [],
  /** What the draft said it used, so a beat with no provenance is caught here. */
  claimIds: string[] = []
): { blocking: string[]; advisory: string[] } => {
  const blocking: string[] = [];
  const advisory: string[] = [];

  const dialogueProblems: DialogueProblem[] = checkDialogue(
    turns,
    persona.hosts.map((h) => h.id)
  );
  for (const p of dialogueProblems) blocking.push(p.detail);

  // Whether the two hosts still sound like two people. The most common way an
  // AI two-hander falls apart, and invisible to read-through because every
  // individual line is fine.
  const { problems: voiceProblems } = checkVoices(turns, persona.hosts);
  for (const p of voiceProblems) (p.blocking ? blocking : advisory).push(p.detail);

  const text = turns.map((t) => withoutTags(t.text)).join('\n');

  // The two ways a told story stops going forward: denying something nobody
  // said, and discussing the episode instead of telling it. Both were found by
  // a listener rather than by a check, on an episode that passed every style
  // metric there is - which is why they are counted here rather than hoped for
  // in the prompt.
  for (const p of checkForward(text, { isOrientation: beat.type === 'orientation' })) {
    (p.blocking ? blocking : advisory).push(p.detail);
  }

  // Whether this beat leaves the next one anything to arrive at. Advisory: a
  // bridge is a craft judgement and a regex sees only the commonest shapes of
  // one, so blocking it would teach the writer to produce those shapes. The work
  // is done by the instruction; this reports whether it worked.
  //
  // The closing beat is exempt, because an ending that points forward is the
  // "next time on" the outro is explicitly told not to write.
  // ADVISORY HERE, AND ENFORCED AS A BUDGET OVER THE WHOLE SCRIPT INSTEAD.
  //
  // It was briefly made blocking, on the good argument that instruction had been
  // tried and measured and had made the bridge rate WORSE (0.52 per thousand
  // words after the instruction, against 0.93 before it), while the revision loop
  // demonstrably fixes eleven of fourteen named faults in one pass. Feedback
  // works on this writer and instruction does not.
  //
  // MEASURING IT STOPPED THAT BEING THE RIGHT FIX. Per beat, the check fires on
  // 92% of ours - which is the fault, honestly reported - but it also recognises
  // only five of the seven real section endings in the reference transcripts. A
  // check with two known blind spots, made blocking at every boundary, would
  // reject good endings it does not recognise and teach the writer to produce the
  // shapes it does. That is how a house style is born, and this file already
  // carries the scar of one.
  //
  // So: reported per beat, and required in the aggregate. See describeFailures in
  // onePass.ts, where more than one flat ending in a script is a rewrite. A
  // script may end one beat quietly; it may not end all of them that way.
  for (const p of checkBridge(text, { isFinal: beat.type === 'outro' })) {
    advisory.push(p.detail);
  }

  // MATERIAL THE BEAT WAS GIVEN AND SKIPPED, which is the check that protects the
  // content from everything else in this function.
  //
  // WHY IT HAD TO EXIST. Adding rewrite pressure for sentence length, handovers
  // and questions moved every one of those metrics to reference level, and the
  // episode it produced DROPPED THE SEVEN GATES: no crown, no earrings, no
  // necklace, no measuring rod, no robe, no "naked before Ereshkigal". The single
  // most concrete and memorable sequence in the myth, present and correct in an
  // earlier and much worse-written draft, gone. Its own plan had said "stripped of
  // one garment or piece of regalia at each, arriving naked before Ereshkigal".
  //
  // That is Goodhart's law arriving on schedule. Every check in this function
  // measures the PROSE, so a writer under rewrite pressure buys compliance with
  // the cheapest thing it has, which is material. Nothing was looking at whether
  // the story still got told.
  //
  // WHY THIS SIGNAL RATHER THAN A WORD FLOOR. A floor makes a beat pad, which is
  // settled policy and the owner was explicit about it. This is a different
  // question: not "is the beat long enough" but "did it use what it was given".
  // Measured across three runs of one topic, the story beat used 15 of 16 claims,
  // then 17 of 18, then 19 of 25 - and the third is the one that lost the gates.
  //
  // BOTH CONDITIONS ARE REQUIRED. A beat that is at or over its guide and still
  // left claims has more material than fits, which is an editorial decision and
  // none of this function's business. A beat that is SHORT and left claims behind
  // has skipped them.
  if (claims.length) {
    const cited = new Set(claimIds);
    const unused = claims.filter((c) => c.status !== 'unverified' && !cited.has(c.id));
    const words = text.split(/\s+/).filter(Boolean).length;
    const guide = wordsForBeat(beat);

    if (unused.length >= SKIPPED_CLAIMS_ALLOWED + 1 && words < guide.min) {
      blocking.push(
        `runs ${words} words, short of the ${guide.min} this beat has room for, and leaves ` +
          `${unused.length} of its ${claims.length} facts unused: ` +
          unused
            .slice(0, 4)
            .map((c) => `[${c.id}] ${c.text.replace(/\s+/g, ' ').slice(0, 90)}`)
            .join('; ') +
          `. Do not pad and do not reach for length. Tell the things you were given and left out, ` +
          `because a listener would rather hear them than hear the rest said better.`
      );
    }
  }

  // Anything said twice, inside this beat or anywhere earlier in the episode.
  // Blocking, and deliberately strict: the listener's instruction was "don't
  // say anything twice", and a check that allowed a little repetition would be
  // back to arguing about how much.
  // The closing beat is allowed one callback, because returning to something
  // the listener already has is what an ending is. See CALLBACK_ALLOWANCE.
  for (const p of checkRepetition(text, storySoFar, { isClose: beat.type === 'outro' })) {
    (p.blocking ? blocking : advisory).push(p.detail);
  }

  // A name used before the listener has been told whose it is. Blocking,
  // because the cost lands on the sentence it appears in and the listener
  // spends the rest of the beat catching up rather than listening.
  if (plan) {
    for (const problem of checkCast(text, plan, beat.id)) blocking.push(problem);
  }

  // A BEAT THAT USED ITS CLAIMS AND DID NOT SAY WHICH is a beat with no
  // provenance, and it reaches the gate looking like a beat with no evidence.
  // One episode's longest beat - five and a half minutes, full of names and
  // dates - reported zero claim ids, so the ledger could not trace a word of it
  // back to a source and the published Sources sheet would have been empty for
  // it.
  //
  // Caught here rather than only at the gate because the fix is one cheap
  // rewrite, and at the gate it is a whole episode of audio already paid for.
  if (claims.length && !claimIds.length) {
    blocking.push(
      `states facts but lists no claim ids. Every claim you used goes in "claimIds", ` +
        `or nothing can trace this beat back to a source.`
    );
  }

  // THE UNSETTLED-CLAIM RULE IS GONE, with the thing it policed.
  //
  // It required a beat using an unverified claim to say out loud that the
  // record did not settle it, and blocked the beat otherwise. That was coherent
  // while unverified claims were handed over WITH a hedge to speak; it produced
  // stories about what the sources say rather than stories. The writer is no
  // longer offered them (see renderClaims), so there is nothing left to hedge.

  // Vocabulary, which no other check looks at. Mostly advisory: there are
  // already ten blocking checks on the writing, and every rejection pushes
  // prose toward the safe and the flat. The prompt does the work; this reports
  // whether it worked, and blocks only where the beat has stopped being speech.
  for (const p of checkPlainWords(text)) (p.blocking ? blocking : advisory).push(p.detail);

  const { violations, measurement } = checkStyle(text, persona.styleCard);
  for (const v of violations) (v.blocking ? blocking : advisory).push(v.detail);

  // SENTENCE LENGTH DRIVES A REWRITE ONCE IT IS BADLY OUT, for the same reason
  // as the bridge above: instruction has been tried and measured, and it did not
  // work. Three long scripts averaged 23.7, 26.1 and then, with an explicit
  // instruction to write around thirteen, 21.2 - against the 12.2 and 12.6 of the
  // transcripts this show is aimed at. The writer is not ignoring the rule out of
  // malice, it is one bullet among ninety-nine.
  //
  // A GENEROUS MULTIPLE, NOT THE TARGET. Asking a beat to hit 13 exactly would
  // fire on nearly every draft and spend two rewrites chasing a decimal. At 1.45x
  // the card, a beat has to be genuinely long-winded before this says anything:
  // for this show that is 18.9 words a sentence, which passes 16 and catches the
  // 21 that made an episode hard to follow. The gate still only whispers about
  // it, so nothing is refused over prose rhythm.
  if (measurement.sentences >= 8 && measurement.sentenceWordsMean > persona.styleCard.sentenceWordsMean * REWRITE_SENTENCE_MULTIPLE) {
    blocking.push(
      `averages ${measurement.sentenceWordsMean.toFixed(1)} words a sentence against a target of ` +
        `${persona.styleCard.sentenceWordsMean}. Break the long ones up. A listener cannot go back ` +
        `to the front of a sentence, so anything built out of clauses joined by "and" or ", which" ` +
        `is lost by the time the verb arrives. Same facts, more sentences.`
    );
  }

  // THERE IS NO LONGER A FLOOR, and removing it is a correction rather than a
  // relaxation. It was raised to 0.85 of the minimum one commit after an
  // episode came in short, and the very next episode was described as "forced
  // to be long" - which is exactly what a floor produces when a beat has said
  // everything its claims support. A writer told to reach a word count with
  // nothing left to say pads, and the cheapest padding is describing something
  // it has already described.
  //
  // The listener settled it: "it should be information heavy, not repeating
  // situation and things again and again, no need to match any length, based on
  // the amount of information the episode length can be anything."
  //
  // So length follows the material. What survives is a ceiling, because a beat
  // running half again over its slot is a beat that has started rambling, and
  // that is a real fault rather than an arithmetic one.
  const words = text.split(/\s+/).filter(Boolean).length;
  const { min, max } = wordsForBeat(beat);
  if (words > max * 1.5) {
    blocking.push(`runs ${words} words, well past the ${max} this beat has room for`);
  } else if (words < min || words > max) {
    advisory.push(`runs ${words} words against a guide of ${min} to ${max}`);
  }

  return { blocking, advisory };
};

export const REVISE_INSTRUCTION = `Your previous draft of this beat failed specific
checks. Rewrite it so it does not.

Fix ONLY what is listed. Do not rewrite what was working, do not change the
facts, and do not add claims. Keep the same claim ids unless a fix genuinely
removes one.

KEEP THE JOIN. Every check you are fixing looks at this beat ON ITS OWN -
sentence variance, opening words, how the voices differ. None of them can see
whether the beat still follows from the one before it, so a rewrite that fixes
the style and breaks the join passes every check and makes the episode worse.

So: the first sentence must still follow from what the episode has said so far,
the same people must still be the people already introduced, and events must
still be in the order the plan puts them. If fixing a check would break the
join, fix it a different way.`;

/**
 * Write one beat, then revise it until it passes or the budget of attempts runs
 * out.
 *
 * The revision prompt carries the previous draft AND the specific failures.
 * Handing back only the failures produces a fresh draft that fails differently;
 * handing back both produces a repair.
 */
export const writeBeat = async (
  ctx: BeatContext,
  writer: LlmClient,
  onCost?: (pence: number) => void
): Promise<ScriptBeat> => {
  const system = buildSystem(ctx.persona, ctx.isoDate, ctx.format.kind);
  const prompt = buildPrompt(ctx);

  // Calls made, not revisions made. The first is a draft, so revisions are
  // calls minus one - counting attempts directly is how this reported three
  // revisions for one draft plus two rewrites.
  let calls = 0;
  let current: { turns: Turn[]; claimIds: string[] } | null = null;
  let lastFailures: string[] = [];

  const revisionBudget = ctx.allowRevisions ? MAX_REVISIONS : 0;

  while (calls <= revisionBudget) {
    const isRevision = current !== null;
    calls++;

    // completeJson, not complete: a beat that runs out of room comes back as
    // valid JSON cut off mid-sentence, and the parse failure says
    // "unterminated JSON" rather than "give it more room". Beats are the most
    // likely place to hit a ceiling, because their length is set from the beat
    // sheet's word budget and a model that runs long overshoots it.
    const parsed = await completeJson<unknown>(
      writer,
      {
        system,
        // The one call site in the pipeline where caching pays, and it pays a
        // lot. `system` is built once above and reused for every beat and every
        // revision of this episode - typically twelve to fifteen calls against
        // a prefix of well over a thousand tokens. See LlmRequest.cacheSystem.
        //
        // It stays valid because buildSystem takes the persona, the date and
        // the format kind, all fixed for the run. If anything per-beat is ever
        // moved into it, the cache silently stops hitting and the episode gets
        // more expensive rather than failing - which is why runs report cached
        // tokens.
        cacheSystem: true,
        prompt: isRevision
          ? [
              prompt,
              '',
              REVISE_INSTRUCTION,
              '',
              `YOUR PREVIOUS DRAFT:\n${JSON.stringify({ turns: current!.turns }, null, 2)}`,
              '',
              `WHAT FAILED:\n${lastFailures.map((f) => `- ${f}`).join('\n')}`,
            ].join('\n')
          : prompt,
        // Lower on revision: the first draft wants range, a repair wants
        // precision, and a hot rewrite tends to discard the parts that worked.
        temperature: isRevision ? 0.4 : 0.85,
        // Medium rather than high. A beat is constrained work - the beat sheet
        // says what it must do, the style card says how, and the critique loop
        // catches what neither did. Thinking at length about a beat is paying
        // output rates to re-derive constraints that are already written down.
        effort: 'medium',
        maxTokens: Math.max(4000, wordsForBeat(ctx.beat).max * 6),
      },
      onCost,
      // A beat that comes back as valid JSON with no `turns` in it is the
      // third kind of failure - not truncated, not malformed, just the wrong
      // shape - and until this it was the only one nothing retried. It happened
      // on a real run, on the longest beat of the sheet, and all anybody saw
      // was a bare Zod path with no sight of what the model had returned.
      { parse: (v) => beatReplySchema.parse(v), label: `the "${ctx.beat.id}" beat` }
    );

    current = parseTurns(parsed, ctx.persona.audioTags?.use);
    const { blocking } = critiqueBeat(
      current.turns,
      ctx.persona,
      ctx.beat,
      ctx.storyPlan,
      ctx.storySoFar,
      ctx.claims,
      current.claimIds
    );

    if (!blocking.length) break;
    lastFailures = blocking;
  }

  return {
    beatId: ctx.beat.id,
    beatType: ctx.beat.type,
    turns: current!.turns,
    claimIds: current!.claimIds,
    revisions: calls - 1,
  };
};

/** The last few words of a beat, used to join the next one without a seam. */
export const tailOf = (text: string, words = 25): string =>
  text.split(/\s+/).slice(-words).join(' ');

export const TITLE_SYSTEM = `You write the title and description for one episode.

The title is what someone sees in a feed. Make it specific and concrete: name
the thing. No colons introducing a subtitle, no "How X changed Y forever", no
question titles, no numbers-in-a-list framing.

The description is two sentences, plain, saying what the episode establishes.

Return JSON only: {"title": "...", "description": "..."}`;

export const writeTitle = async (
  persona: Persona,
  angle: string,
  beats: ScriptBeat[],
  writer: LlmClient,
  onCost?: (pence: number) => void
): Promise<{ title: string; description: string }> => {
  const parsed = await completeJson<unknown>(
    writer,
    {
      system: TITLE_SYSTEM,
      prompt: [
        `SHOW: ${persona.name}`,
        `ANGLE: ${angle}`,
        `OPENING: ${beats[0] ? beatText(beats[0]) : ''}`,
        `PAYOFF: ${(() => {
          const payoff = beats.find((b) => b.beatType === 'payoff');
          return payoff ? beatText(payoff) : '';
        })()}`,
      ].join('\n\n'),
      temperature: 0.8,
      effort: 'low',
      // RAISED FROM 1,500, WHICH TRUNCATED A REAL RUN. The reply is two short
      // fields, but `low` effort is not `no` effort and the thinking comes out
      // of the same ceiling - so a model that reasons for a moment about the
      // description returns JSON cut off mid-sentence, and the whole episode
      // fails at the very last call after the script has been paid for. Room
      // costs nothing when it is not used. See models/client.ts.
      maxTokens: 6000,
    },
    onCost
  );

  return z
    .object({ title: z.string().min(1), description: z.string().min(1) })
    .parse(parsed);
};

/**
 * Write every beat in order.
 *
 * Sequential rather than parallel, and that costs wall-clock time on purpose:
 * each beat is given the tail of the one before it, which is what stops the
 * joins reading as seams between separately-written paragraphs.
 */
/**
 * Work already done, so a failure halfway through a script does not throw it
 * away.
 *
 * WHY THIS IS WORTH THE COMPLICATION. Writing a ten-beat script is thirty model
 * calls and ten to fifteen minutes. Before this, a failure on beat eight -
 * a rate limit, a dropped connection, a laptop lid - discarded the twenty-one
 * calls that had already succeeded and started again from nothing. Stage-level
 * resumability does not help, because the whole script is one stage.
 *
 * The hook competition is checkpointed alongside the beats because it is
 * sixteen generations plus a judgement, which is the single most expensive call
 * in the stage and the most annoying one to pay for twice.
 */
export const scriptProgressSchema = z.object({
  hook: z.string().optional(),
  /**
   * The story plan, so a resumed run writes the second half of the same episode
   * the first half was written for.
   */
  plan: storyPlanSchema.optional(),
  beats: z.array(scriptBeatSchema).default([]),
});

export type ScriptProgress = z.infer<typeof scriptProgressSchema>;

export interface ScriptCheckpoint {
  /** What a previous attempt already wrote. */
  progress: ScriptProgress;
  /** Called after the hook and after every beat. */
  save: (progress: ScriptProgress) => void;
}

export const writeScript = async (
  input: {
    persona: Persona;
    format: EpisodeFormat;
    claims: Claim[];
    angle: string;
    isoDate: string;
    /** Which story each beat tells, by position. Anthologies only. */
    subjects?: Array<string | undefined>;
  },
  writer: LlmClient,
  onCost?: (pence: number) => void,
  checkpoint?: ScriptCheckpoint,
  onProgress?: (message: string) => void,
  /** Whether a failing beat is paid to be rewritten. See BeatContext. */
  allowRevisions = false
): Promise<Script> => {
  // Beats are resumed BY INDEX, and only a prefix is trusted. A checkpoint
  // holding beats 1, 2 and 5 would be a checkpoint from a different format, and
  // stitching those together would produce a script whose beats do not match
  // its own beat sheet. Taking the prefix is the conservative reading.
  const resumed = (checkpoint?.progress.beats ?? []).filter(
    (b, i) => input.format.beats[i]?.id === b.beatId
  );

  const beats: ScriptBeat[] = [...resumed];
  let previousTail = beats.length ? tailOf(beatText(beats[beats.length - 1]!)) : undefined;

  /** Every beat written so far, labelled, for the next one to read. */
  /**
   * THE LABEL FORMAT MATTERS, AND THE OBVIOUS ONE IS WRONG. This read
   * `[before]`, which collides with two things at once: it is how a JSON array
   * opens, and it is exactly the shape of an audio tag. A model shown a
   * transcript formatted that way copied it, and returned a beat beginning
   * "[before]" - which failed to parse as JSON, failed to repair, and killed
   * the run on the beat after the two that had worked.
   *
   * A row of hyphens is neither of those things.
   */
  const storySoFar = () =>
    beats.length
      ? beats.map((b) => `--- ${b.beatId} ---\n${beatText(b)}`).join('\n\n')
      : undefined;

  if (beats.length) {
    onProgress?.(`resuming after ${beats.length} beat(s) already written`);
  }

  let plan: StoryPlan | undefined = checkpoint?.progress.plan;

  const persist = (hook?: string) => checkpoint?.save({ hook, beats, plan });

  // THE PLAN COMES FIRST, before a word is written, because it is the only
  // thing in the system that sees the episode as one story. Skipped on a resume
  // that already has one - it is deterministic enough that re-planning midway
  // would risk the second half being written against a different story from the
  // first.
  if (!plan) {
    try {
      onProgress?.('planning the whole story before writing any of it');
      plan = await planStory(
        {
          persona: input.persona,
          format: input.format,
          claims: input.claims,
          angle: input.angle,
        },
        writer,
        onCost
      );
      persist(checkpoint?.progress.hook);
      onProgress?.(`the story: ${plan.spine}`);
    } catch (err) {
      // A failed plan must not cost the episode. Without one, every beat falls
      // back to what it had before - the previous beat's tail - which is worse
      // but is not nothing.
      onProgress?.(`planning failed, writing beat by beat instead: ${(err as Error).message}`);
    }
  }

  // THE OPENING IS WRITTEN DIFFERENTLY FROM EVERY OTHER BEAT.
  //
  // More listeners are lost in the first eight seconds than anywhere else, and
  // an opening is short enough that writing sixteen of them and choosing costs
  // almost nothing. Every other beat gets one draft plus revisions; this one
  // gets a competition it has to win on measurable curiosity-gap properties.
  let openingHook: string | undefined = checkpoint?.progress.hook;
  const firstLoop = input.format.loops[0];

  if (!openingHook && !beats.length && firstLoop && input.format.beats[0]?.type === 'cold_open') {
    try {
      onProgress?.('writing sixteen openings and judging them');
      const hook = await writeHook(
        {
          angle: input.angle,
          loopQuestion: firstLoop.question,
          register: input.persona.register.trim().replace(/\s+/g, ' '),
        },
        writer,
        onCost
      );
      openingHook = hook.text;
      persist(openingHook);
    } catch {
      // A failed competition must not cost the episode. The cold open is then
      // written normally, which is exactly what happened before this existed.
      onProgress?.('the opening competition failed; writing the cold open normally');
    }
  }

  for (const [index, beat] of input.format.beats.entries()) {
    if (index < beats.length) continue;

    onProgress?.(`beat ${index + 1}/${input.format.beats.length}: ${beat.id}`);

    const written = await writeBeat(
      {
        allowRevisions,
        persona: input.persona,
        format: input.format,
        beat,
        subject: input.subjects?.[index],
        claims: input.claims.filter((c) => c.beatId === beat.id),
        previousTail,
        storySoFar: storySoFar(),
        plan: plan ? planBrief(plan, beat.id) : undefined,
        storyPlan: plan,
        angle: input.angle,
        isoDate: input.isoDate,
        loops: input.format.loops.length
          ? loopBrief(beat, input.format.loops, openBefore(input.format.beats, index))
          : undefined,
        openWith: index === 0 ? openingHook : undefined,
      },
      writer,
      onCost
    );
    beats.push(written);
    previousTail = tailOf(beatText(written));

    // Saved after EVERY beat, not every few. The whole point is that whatever
    // succeeded is kept, and a batching interval would be a window in which it
    // is not.
    persist(openingHook);

    if (written.revisions) {
      onProgress?.(`  rewritten ${written.revisions} time(s) before it passed`);
    }
  }

  onProgress?.('writing the title');
  const { title, description } = await writeTitle(input.persona, input.angle, beats, writer, onCost);

  return {
    personaId: input.persona.id,
    formatId: input.format.id,
    title,
    description,
    beats,
    writerModel: writer.model,
    plan,
  };
};
