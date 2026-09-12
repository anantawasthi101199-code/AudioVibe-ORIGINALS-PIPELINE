/**
 * The story, laid out end to end, before a word of it is written.
 *
 * WHY THIS HAD TO EXIST. Beats were written one at a time, and each one saw
 * TWENTY-FIVE WORDS of what came before it. That is the whole memory a beat had
 * of its own episode.
 *
 * Everything that went wrong with the first real episode follows from that one
 * number. The turn beat says "what you believed a minute ago was wrong" without
 * knowing what the listener was told to believe. The aftermath names a person
 * the setup introduced and introduces them again, or does not introduce them at
 * all. Facts arrive twice. Chronology cannot hold, because nothing in the
 * system knows the sequence - each beat only knows its own job and the last
 * sentence of somebody else's.
 *
 * A listener hears that as disconnection, and no amount of work on the prose
 * fixes it, because the prose is not what is broken.
 *
 * WHY NOT JUST WRITE THE WHOLE SCRIPT IN ONE CALL. It is the obvious answer and
 * it is a real option: three thousand words fits comfortably in one response.
 * What it costs is the per-beat critique and revision loop, and that loop is
 * doing measurable work - every beat of the first episode was rewritten once or
 * twice, which means the deterministic checks caught something every single
 * time. Revising a whole script instead means regenerating three thousand words
 * to fix one paragraph, and watching the model quietly change four things that
 * were fine.
 *
 * So: plan globally, write locally, and give each beat the whole story so far
 * rather than a sentence of it. The plan is one cheap call and it is the thing
 * that holds the chronology.
 */
import { z } from 'zod';
import { Persona } from '../canon/schema';
import { EpisodeFormat } from '../formats/schema';
import { Claim } from '../evidence/claim';
import { completeJson, LlmClient } from '../models/client';

export const storyPlanSchema = z.object({
  /**
   * The episode in one sentence, as a sequence rather than a subject.
   *
   * "Six men drilled through a vault wall over a bank holiday, failed, and came
   * back the next night" - not "the Hatton Garden burglary".
   */
  spine: z.string().min(1),
  /**
   * What happens in each beat, in order, keyed by beat id.
   *
   * Keyed rather than positional so a beat sheet that gains a beat does not
   * silently shift every plan entry by one.
   */
  beats: z.array(
    z.object({
      beatId: z.string().min(1),
      /** What happens here, in two or three sentences, chronologically. */
      happens: z.string().min(1),
      /** What the listener should believe by the end of this beat. */
      leaves: z.string().default(''),
    })
  ),
});

export type StoryPlan = z.infer<typeof storyPlanSchema>;

const PLAN_SYSTEM = `You plan one episode of an audio show before it is written.

You are given the show, the beats it must fill, and every verified fact
available. Lay out what happens in each beat so that the episode is ONE STORY
told in order, rather than ten separate pieces that share a subject.

This matters because each beat is written separately afterwards, by a writer who
can see this plan and what came before, and nothing else. If the plan does not
hold the chronology, nothing will.

Rules:
- CHRONOLOGICAL. Put events in the order they happened. If the beat sheet asks
  for a moment out of order, say so explicitly in that beat's entry.
- Every beat must move the story FORWARD from the one before it. If two beats
  would cover the same ground, change one.
- Say what the listener should BELIEVE at the end of each beat, especially
  before a turn. A turn only works if the thing it overturns was established.
- Introduce each person ONCE, in the earliest beat that needs them, and say in
  that beat's entry that this is where they are introduced.
- Work only from the facts you are given. Do not plan a beat around something
  you know but cannot cite.
- If the facts do not support a beat, say so plainly in its entry rather than
  inventing a way to fill it.

Return JSON only:
{"spine": "the whole episode as one sentence, as a sequence of events",
 "beats": [{"beatId": "...", "happens": "...", "leaves": "what the listener now believes"}]}`;

/**
 * Plan the episode.
 *
 * ONE CALL, BEFORE ANY BEAT. Cheap - a couple of pence - against the thing it
 * fixes, which is every beat being written by someone who has not read the rest
 * of the episode.
 */
export const planStory = async (
  input: {
    persona: Persona;
    format: EpisodeFormat;
    claims: Claim[];
    angle: string;
  },
  writer: LlmClient,
  onCost?: (pence: number) => void
): Promise<StoryPlan> => {
  const beats = input.format.beats
    .map(
      (b) =>
        `- ${b.id} (${b.type}, ${b.seconds[0]}-${b.seconds[1]}s): ${b.function.trim().replace(/\s+/g, ' ')}`
    )
    .join('\n');

  // Every claim, not just the ones routed to a beat. The plan's whole job is to
  // see the story as a whole, and a planner shown a tenth of the facts at a
  // time would reproduce the problem it exists to solve.
  const facts = input.claims
    .map((c) => `[${c.id}] (${c.type}${c.contested ? ', contested' : ''}) ${c.text}`)
    .join('\n');

  const plan = await completeJson<unknown>(
    writer,
    {
      system: PLAN_SYSTEM,
      prompt: [
        `SHOW: ${input.persona.name} - ${input.persona.thesis.trim().replace(/\s+/g, ' ')}`,
        `THIS EPISODE: ${input.angle}`,
        `BEATS TO FILL:\n${beats}`,
        `VERIFIED FACTS:\n${facts}`,
      ].join('\n\n'),
      temperature: 0.4,
      // Medium: this is the judgement call that shapes the whole episode, and
      // it is one call. Skimping here to save a penny would be the definition
      // of a false economy.
      effort: 'medium',
      maxTokens: 6000,
    },
    onCost
  );

  return storyPlanSchema.parse(plan);
};

/**
 * The plan as the beat writer should see it.
 *
 * THE WHOLE PLAN, NOT JUST THIS BEAT'S ENTRY, and that is the point. A writer
 * who can see where the story is going stops writing each beat as though it
 * were the only one - which is how a beat ends up re-introducing a person, or
 * paying off a tension the next beat was supposed to pay off.
 *
 * The current beat is marked so it is unmistakable which one is being written.
 */
export const planBrief = (plan: StoryPlan, currentBeatId: string): string => {
  const lines = plan.beats.map((b) => {
    const marker = b.beatId === currentBeatId ? '>>> ' : '    ';
    const leaves = b.leaves ? ` (leaves the listener believing: ${b.leaves})` : '';
    return `${marker}${b.beatId}: ${b.happens}${leaves}`;
  });

  return [
    `THE WHOLE EPISODE: ${plan.spine}`,
    '',
    'THE PLAN, in order. The beat marked >>> is the one you are writing:',
    ...lines,
  ].join('\n');
};
