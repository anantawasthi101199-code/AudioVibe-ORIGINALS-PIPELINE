/**
 * Asking the model what this channel should cover next.
 *
 * A CONVENIENCE THAT MUST NOT BECOME THE DEFAULT. The topic queues are
 * hand-written and the comment at the top of each explains what makes a good
 * entry, because a studio that picks its own subjects converges on whatever the
 * model finds most available - which is the same handful of stories everybody
 * else is already telling. This exists to get a blank page moving, and what it
 * returns is a list to choose from and edit, never a queue it writes to itself.
 *
 * SO IT SUGGESTS AND RETURNS. It does not save, it does not start a run, and
 * nothing downstream reads it. A suggestion becomes real when a person puts it
 * in the box and presses the button.
 *
 * IT IS TOLD WHAT THE SHOW ALREADY COVERS, which is the difference between a
 * useful list and ten variations on the show's own description. That includes
 * what is queued and what has already been made, because the second most useless
 * suggestion is one the channel published last week.
 */
import { Persona } from '../canon/schema';
import { EpisodeFormat } from '../formats/schema';
import { LlmClient, completeJson } from '../models/client';
import { z } from 'zod';

export const suggestionsSchema = z.object({
  suggestions: z
    .array(
      z.object({
        /** The topic itself, written the way it would be typed into the box. */
        topic: z.string().min(1),
        /** One line on why this one, which is what makes a list choosable. */
        why: z.string().min(1),
      })
    )
    .min(1),
});

export type Suggestions = z.infer<typeof suggestionsSchema>;

export const EPISODE_SUGGEST_SYSTEM = `You propose subjects for one episode of an audio show.

You are not writing anything. You are handing somebody a short list to choose
from, and they will edit whichever they pick.

Return JSON only: {"suggestions": [{"topic": "...", "why": "..."}]}

WHAT MAKES A GOOD ONE HERE:

- IT IS A SUBJECT, NOT A TITLE. "Why a bad night's sleep makes you forget
  things" is a subject. "The Sleep Thief" is a title, and a title given to the
  research stage produces a worse episode than a plain question would.
- THERE IS SOMETHING TO FIND. The show binds every assertion to a document it
  can fetch, so a subject with nothing written about it cannot be made at all.
  Prefer subjects with published research, primary records, or translated texts.
- IT IS NOT WHAT THE SHOW JUST DID. You are told what is queued and what has
  been made. A suggestion already on either list is wasted.
- IT SUITS THIS SHOW. Not the category, the show: its thesis, its audience and
  the things it has said it does not do.

The "why" is one line, and it says what is actually in the subject - the
finding, the document, the disagreement - rather than why it is interesting.`;

export const SET_SUGGEST_SYSTEM = `You propose subjects for a SET of short, self-contained pieces.

You are not writing anything. You are handing somebody a short list to choose
from, and they will edit whichever they pick.

Return JSON only: {"suggestions": [{"topic": "...", "why": "..."}]}

A SET IS NOT AN EPISODE, and the test is almost the opposite:

- IT NAMES A BODY OF MATERIAL, not one story. A tradition, a period, a
  collection, a category. Something with ten genuinely different stories in it.
- TEN STORIES HAVE TO EXIST AND BE FINDABLE. This is where a set fails in
  practice: a subject everybody has heard of whose minor stories were never
  written down leaves seven of the ten with nothing to bind to.
- EACH ONE HAS TO STAND ALONE. Somebody meets one of these in a feed having
  heard none of the others, so a single continuous saga is the wrong shape
  however good it is.
- NOT A THEME THAT FORCES TEN ANGLES ON ONE THING. "Ten cultures looking at the
  same night sky" sounds good and produces ten versions of one idea.

The "why" says what the ten would be drawn from, and how sure you are that ten
of them have surviving material.`;

export const suggestTopics = async (
  input: {
    persona: Persona;
    format: EpisodeFormat;
    /** Already queued, so it does not offer them back. */
    queued: string[];
    /** Already made, for the same reason. */
    made: string[];
    count: number;
  },
  writer: LlmClient,
  onCost?: (pence: number) => void
): Promise<Suggestions> => {
  const listOrNone = (items: string[]): string =>
    items.length ? items.map((i) => `- ${i}`).join('\n') : '(nothing yet)';

  return suggestionsSchema.parse(
    await completeJson(
      writer,
      {
        system: input.format.sourceOnly ? SET_SUGGEST_SYSTEM : EPISODE_SUGGEST_SYSTEM,
        prompt: [
          `SHOW: ${input.persona.name}`,
          `THESIS: ${input.persona.thesis.trim().replace(/\s+/g, ' ')}`,
          `AUDIENCE: ${input.persona.audience.trim().replace(/\s+/g, ' ')}`,
          `FORMAT: ${input.format.name} - ${input.format.intent.trim().replace(/\s+/g, ' ')}`,
          '',
          // WHAT IT MUST NOT SAY BACK TO US. Cheap to include and the single
          // biggest difference between a usable list and a list of near-misses.
          `ALREADY QUEUED, do not suggest these:\n${listOrNone(input.queued)}`,
          '',
          `ALREADY MADE, do not suggest these either:\n${listOrNone(input.made)}`,
          '',
          `Give exactly ${input.count} suggestions.`,
        ].join('\n'),
        temperature: 0.9,
        // The judgement here is "what is worth covering", which is the kind of
        // thing thinking helps with and is cheap at this size.
        effort: 'medium',
        maxTokens: 4000,
      },
      onCost
    )
  );
};
