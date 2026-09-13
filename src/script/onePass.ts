/**
 * Writing the whole script in one call instead of a beat at a time.
 *
 * WHY THIS EXISTS. Beat-by-beat writing has one structural weakness that no
 * amount of prompting fixes: a beat is written by a model that has been told
 * what came before but is still being asked, right now, to produce four hundred
 * words about this beat's job. When the job is "answer the question from the
 * opening" or "land it by returning to something", the only material it has is
 * material already spent, so it restates. A real episode did exactly that -
 * eleven of twenty-five facts appeared in two beats, and the last third of the
 * episode was the first two thirds again in different words.
 *
 * Written in one pass, a beat cannot repeat what it can see. The whole script is
 * one object being produced at once, so "I already said that" is available as a
 * fact rather than as an instruction, and the writer can spend the closing beat
 * on whatever it decided not to say earlier.
 *
 * WHAT IS GIVEN UP, HONESTLY. Per-beat writing gets a critique-and-rewrite loop
 * on every beat, and that loop catches something on nearly every run. One pass
 * gets the same checks but repairs everything in a single revision, so a beat
 * with one fixable fault is rewritten alongside six that were fine. It is one
 * revision rather than up to two per beat, and a model rewriting seven beats
 * pays less attention to each than one rewriting one.
 *
 * SO THIS IS AN OPTION, NOT A REPLACEMENT. The two are meant to be compared on
 * real episodes of the same show:
 *
 *   npm run foundry -- make --show <id> --topic "..." --one-pass
 *   npm run foundry -- compare --a <beat-by-beat run> --b <one-pass run>
 *
 * The trigger for making it the default, written down in advance so it is not
 * decided by whichever episode was listened to most recently: if the faults in
 * one-pass episodes are sentence-level and the faults in beat-by-beat episodes
 * are joins, repetition and continuity, one pass wins.
 */
import { z } from 'zod';
import { Persona } from '../canon/schema';
import { Claim } from '../evidence/claim';
import { EpisodeFormat } from '../formats/schema';
import { LlmClient, completeJson } from '../models/client';
import { turnSchema } from './dialogue';
import { StoryPlan, planStory } from './plan';
import {
  Script,
  ScriptBeat,
  WORDS_PER_SECOND,
  beatText,
  buildSystem,
  critiqueBeat,
  renderClaims,
  wordsForBeat,
  writeTitle,
} from './write';

/**
 * How many times the whole script may be rewritten.
 *
 * ONE, against MAX_REVISIONS of two per beat. A second full rewrite costs as
 * much as the draft did and arrives with the same problems in different places,
 * because what fails a whole-script critique is usually a decision about the
 * episode rather than a sentence somebody can fix by trying again.
 */
export const MAX_SCRIPT_REVISIONS = 1;

const scriptReplySchema = z.object({
  beats: z
    .array(
      z.object({
        beatId: z.string(),
        turns: z.array(turnSchema).min(1),
        claimIds: z.array(z.string()).default([]),
      })
    )
    .min(1),
});

export const ONE_PASS_INSTRUCTION = `Write the WHOLE episode now, every beat, in one go.

You are writing one continuous thing that somebody listens to from start to
finish, not seven pieces that will be joined later. That is the point of writing
it this way, and it changes two things:

NOTHING IS SAID TWICE. You can see the whole script because you are writing the
whole script. A fact stated in one beat is spent, and stating it again anywhere
later is the single worst thing you can do to a listener who was paying
attention. Where a later beat needs to point at an earlier one, point at it in
three or four words and add something that was not said before.

THE BEATS ARE ONE STORY. Each beat below has a job, and the jobs are in the
right order, but the joins between them belong to you. A listener should not be
able to hear where one ends and the next begins.

Two more things, which matter more here than anywhere:

SAY THINGS. You have been given more facts than will fit. Choosing the strongest
and stating them plainly is the job. Filling the time by saying more about a
fact already stated is what makes an episode sound like it is padding, because
it is.

DO NOT WORK AT BEING INTERESTING. The material is interesting or it is not, and
a sentence whose job is to make the listener feel something is a sentence not
spent on what actually happened. No preamble about why this matters, no telling
them what they are about to hear, no reaching for a human story that is not in
the sources.

Return JSON: {"beats": [{"beatId": "...", "turns": [{"speaker": "...", "text":
"..."}], "claimIds": ["c1", "c4"]}]}

One entry per beat, in the order given, using exactly the beat ids given. Every
claim you actually state goes in that beat's claimIds, or nothing can trace the
sentence back to a source.`;

export const REVISE_SCRIPT = `Your draft failed specific checks. Rewrite the WHOLE script,
keeping everything that was not named as a problem exactly as it is, and fixing
what was.

Do not rewrite beats nobody complained about. Do not fix a problem by deleting
the sentence that carried the fact - the fact is the reason the episode exists.
Fix the sentence.`;

/** The beat sheet as the writer sees it: every beat, its job and its budget. */
const renderBeats = (format: EpisodeFormat, claims: Claim[]): string =>
  format.beats
    .map((beat) => {
      const { min, max } = wordsForBeat(beat);
      const mine = claims.filter((c) => c.beatId === beat.id);
      return [
        `--- ${beat.id} (${beat.type}) ---`,
        `MUST: ${beat.function.trim()}`,
        beat.constraints.length
          ? `CONSTRAINTS:\n${beat.constraints.map((c) => `- ${c.trim()}`).join('\n')}`
          : '',
        // A GUIDE, SAID TO BE A GUIDE, for the same reason it is one per beat:
        // given as a target, a beat with four facts' worth of material writes to
        // the number rather than to the material.
        `LENGTH: roughly ${min} to ${max} words. A guide, not a target - say what ` +
          `the facts support and then stop.`,
        `FACTS RESEARCHED FOR THIS BEAT:\n${renderClaims(mine)}`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

const buildOnePassPrompt = (input: {
  format: EpisodeFormat;
  claims: Claim[];
  angle: string;
  plan?: StoryPlan;
}): string =>
  [
    `EPISODE ANGLE: ${input.angle}`,
    input.plan
      ? `THE STORY, decided before any of it was written:\n${input.plan.spine}`
      : '',
    '',
    ONE_PASS_INSTRUCTION,
    '',
    `THE BEATS, in order:`,
    '',
    renderBeats(input.format, input.claims),
    '',
    // SAID ONCE MORE AT THE END, because the beat listing above is long and the
    // facts are the last thing read before writing starts. A claim assigned to
    // one beat may genuinely belong in another; what may not happen is a fact
    // being stated in two.
    `A fact is listed under the beat it was researched for. If it clearly belongs ` +
      `in a different beat, use it there instead - but use it ONCE, in one beat, ` +
      `and list it in that beat's claimIds.`,
  ]
    .filter((line) => line !== '')
    .join('\n');

/**
 * Write every beat of an episode in one call.
 *
 * Deliberately the same signature as writeScript minus the checkpoint. There is
 * nothing to checkpoint inside a single call: it either returns a script or it
 * does not, and a failed one has produced nothing to keep. That is a real cost
 * of this method on a long episode and it is why the plan is still made
 * separately - a failed write does not throw away a good plan.
 */
export const writeScriptOnePass = async (
  input: {
    persona: Persona;
    format: EpisodeFormat;
    claims: Claim[];
    angle: string;
    isoDate: string;
  },
  writer: LlmClient,
  onCost?: (pence: number) => void,
  onProgress?: (message: string) => void
): Promise<Script> => {
  const system = buildSystem(input.persona, input.isoDate, input.format.kind);

  let plan: StoryPlan | undefined;
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
    onProgress?.(`the story: ${plan.spine}`);
  } catch (err) {
    onProgress?.(`planning failed, writing without a plan: ${(err as Error).message}`);
  }

  const prompt = buildOnePassPrompt({
    format: input.format,
    claims: input.claims,
    angle: input.angle,
    plan,
  });

  // Room for every beat at its maximum, plus half again. A script that runs out
  // of room comes back as JSON cut off mid-sentence, and on this method that
  // costs the entire episode rather than one beat.
  const budget = input.format.beats.reduce((n, b) => n + wordsForBeat(b).max, 0);
  const maxTokens = Math.max(8000, Math.round(budget * 6 * 1.5));

  let beats: ScriptBeat[] = [];
  let revisions = 0;

  for (let attempt = 0; attempt <= MAX_SCRIPT_REVISIONS; attempt++) {
    const isRevision = attempt > 0;
    onProgress?.(
      isRevision ? 'rewriting the script' : `writing all ${input.format.beats.length} beats in one call`
    );

    const raw = await completeJson<unknown>(
      writer,
      {
        system,
        cacheSystem: true,
        prompt: isRevision
          ? [
              prompt,
              '',
              REVISE_SCRIPT,
              '',
              `YOUR PREVIOUS DRAFT:\n${JSON.stringify({ beats }, null, 2)}`,
              '',
              `WHAT FAILED:\n${describeFailures(beats, input)}`,
            ].join('\n')
          : prompt,
        temperature: isRevision ? 0.4 : 0.85,
        // Higher than a beat gets, and this is the one place it is worth it.
        // Deciding what goes where across a whole episode, and what to leave
        // out, is the work this method exists to do; a beat is constrained
        // enough that thinking about it re-derives the beat sheet.
        effort: 'high',
        maxTokens,
      },
      onCost,
      {
        parse: (v: unknown) => scriptReplySchema.parse(v),
        label: `the script (${input.format.beats.length} beats)`,
      }
    );

    beats = orderBeats(scriptReplySchema.parse(raw), input.format);
    revisions = attempt;

    const failures = describeFailures(beats, input);
    if (!failures) break;
    onProgress?.(`  ${failures.split('\n').length} problem(s) to fix`);
  }

  onProgress?.('writing the title');
  const { title, description } = await writeTitle(
    input.persona,
    input.angle,
    beats,
    writer,
    onCost
  );

  return {
    personaId: input.persona.id,
    formatId: input.format.id,
    title,
    description,
    beats: beats.map((b) => ({ ...b, revisions })),
    writerModel: writer.model,
    plan,
  };
};

/**
 * The beats in the beat sheet's order, whatever order they came back in.
 *
 * A model returning them out of order, or returning one twice, would produce a
 * script whose beats do not match its own beat sheet - which the gate would
 * catch, but only after the audio had been rendered. A missing beat is an error
 * rather than a gap, because a script missing its payoff is not an episode.
 */
const orderBeats = (
  reply: z.infer<typeof scriptReplySchema>,
  format: EpisodeFormat
): ScriptBeat[] => {
  const byId = new Map(reply.beats.map((b) => [b.beatId, b]));

  return format.beats.map((beat) => {
    const written = byId.get(beat.id);
    if (!written) {
      throw new Error(
        `the script came back without the "${beat.id}" beat. It returned: ` +
          `${reply.beats.map((b) => b.beatId).join(', ')}`
      );
    }
    return {
      beatId: beat.id,
      beatType: beat.type,
      turns: written.turns,
      claimIds: written.claimIds,
      revisions: 0,
    };
  });
};

/**
 * Every blocking problem in the script, named by beat, or empty.
 *
 * THE SAME CHECKS THE PER-BEAT WRITER USES, run with the same "everything
 * before this" context, so the two methods are held to one standard. If they
 * were not, a comparison between them would be measuring the checks rather than
 * the writing.
 */
const describeFailures = (
  beats: ScriptBeat[],
  input: { persona: Persona; format: EpisodeFormat; claims: Claim[] }
): string => {
  const problems: string[] = [];

  beats.forEach((written, i) => {
    const beat = input.format.beats[i];
    if (!beat) return;

    const storySoFar = beats
      .slice(0, i)
      .map((b) => `--- ${b.beatId} ---\n${beatText(b)}`)
      .join('\n\n');

    const { blocking } = critiqueBeat(
      written.turns,
      input.persona,
      beat,
      undefined,
      storySoFar || undefined,
      input.claims.filter((c) => c.beatId === beat.id),
      written.claimIds
    );

    for (const problem of blocking) problems.push(`- ${written.beatId}: ${problem}`);
  });

  return problems.join('\n');
};

/** Rough spoken length of a whole script, for reporting before it renders. */
export const scriptSeconds = (beats: ScriptBeat[]): number =>
  Math.round(beats.map(beatText).join(' ').split(/\s+/).length / WORDS_PER_SECOND);
