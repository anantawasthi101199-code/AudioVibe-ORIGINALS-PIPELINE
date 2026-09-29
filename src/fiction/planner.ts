/**
 * Breaking the season: the one paid call that plans a whole serial.
 *
 * SEPARATE FROM season.ts SO THAT FILE STAYS MODEL-FREE. Everything in there is
 * arithmetic over a small object and is tested without a network, which is what
 * makes the free checks trustworthy. Putting a model import beside them would
 * cost that for nothing.
 *
 * WHAT IT COSTS, AND WHY THAT IS THE POINT. An outline is small. Eight cards of
 * a paragraph each, a cast, a spine and a promise list come to a couple of
 * thousand words, so this lands near ten pence against roughly fifty pence for
 * a single written episode. That ratio is the argument for the whole design: it
 * buys a place to be wrong cheaply, and a place for a person to say no before
 * the expensive part starts.
 *
 * THE PLAN IS NOT THE SHOW. Nothing here writes a line of dialogue. The cards
 * are aimed at a writer, not at a listener, and a writer that follows one
 * exactly has misread it - the card says where the episode has to arrive, and
 * getting there is the episode's business.
 */
import { Persona, canonAsOf } from '../canon/schema';
import { voiceBrief } from '../script/voices';
import { completeJson, LlmClient } from '../models/client';
import {
  MAX_CARRY_CAST,
  SEASON_EPISODES,
  SeasonPlan,
  seasonPlanSchema,
} from './season';

/**
 * How a season is shaped, in the words a writers' room uses.
 *
 * THREE MOVEMENTS RATHER THAN A CURVE PER EPISODE. The beat sheets already own
 * the shape INSIDE an episode; this owns the shape ACROSS them, and the two
 * must not both try to do the same job. What a season needs from this level is
 * only that the middle escalates and the end converges.
 */
const SEASON_SHAPE = [
  'The first third establishes the ordinary and introduces the thing that will break it. End it with the listener certain of something.',
  'The middle third makes it worse in ways that cannot be undone. Every episode here takes something away. This is where a season usually sags, so it is where the irreversible changes belong.',
  'The last third converges. Threads that were separate turn out to be the same thread, and the finale lands rather than opens.',
];

/**
 * What a cliffhanger has to be, as opposed to what it usually is.
 *
 * TAKEN STRAIGHT FROM serial-reversal.yaml, because the argument there is the
 * strongest single piece of craft reasoning in the repo and it belongs at the
 * planning stage rather than only at the writing one. A season planned around
 * open questions cannot be rescued by a writer asked for reversals; the cards
 * have to contain the reversals or there are none.
 */
const CLIFFHANGER_RULES = [
  'A cliffhanger is not an episode that stops early. Any episode that stops early leaves a question open, and a listener feels the withholding.',
  'The strong form is a REVERSAL: the episode spends its length making the listener certain of something, and its last minute makes that thing untrue. They had the answer and it has been taken away, which is different from never being given it.',
  'It must come out of what just happened, not from a new threat arriving in the last thirty seconds.',
  'Not every episode can carry a reversal, and a faked one is worse than an honest open question. Where the episode is genuinely connective, say so in the card rather than inventing a twist for it.',
];

/**
 * The rules that come from this being heard rather than read.
 *
 * MOST STORY PLANNING ADVICE ASSUMES A SCREEN, and the failures that assumption
 * causes are not stylistic, they are comprehension failures: a listener who has
 * lost track of who is speaking has lost the scene, and nothing later recovers
 * it. These are constraints on the PLAN because a plan that needs six people in
 * a room cannot be written out of trouble afterwards.
 */
const EAR_RULES_FOR_PLANNING = [
  `At most ${MAX_CARRY_CAST} people the listener has to remember across the season. Anyone else is named once where they act, or replaced by what they did.`,
  'At most three people in any scene that matters. Four is the ceiling and it costs something every time.',
  'No two carry characters may have names that rhyme, alliterate, or share a first syllable. On the page Dana and Diana are distinct; in the ear they are one person.',
  'Nothing may turn on a detail the listener has to see. No written notes read silently, no lookalikes, no character recognising someone across a room without saying so.',
  'A twist that depends on the listener having noticed one word in episode two will not land. Plant things at least twice, in different ways, before they pay off.',
  'Time and place changes have to be speakable. If a card needs four locations, the episode will spend its length announcing where it is.',
];

export const SEASON_INSTRUCTION = `You are breaking a season of an audio serial, the way a writers' room breaks a season before anybody writes a script.

You are NOT writing the show. No dialogue, no prose, no scenes. You are producing the board: who this is about, what the season is doing, and what each episode has to achieve.

HOW A SEASON IS SHAPED
${SEASON_SHAPE.map((s, i) => `${i + 1}. ${s}`).join('\n')}

PROMISES ARE THE SPINE OF THE PLAN
A promise is something the season makes the listener wonder. Every promise is planted in one episode and paid off in a LATER one. You list them separately with ids, then reference those ids from the episode cards.

- Every promise you name must be paid off before the season ends. A season that ends owing the listener an answer is the commonest way a serial loses the people who stayed to the end, and those are the only people worth keeping.
- A promise paid in the same episode that plants it is a scene, not a thread. Do not list those.
- Between three and six promises for a season. Fewer and it is a set of episodes; more and the finale becomes a list of answers.
- Write the promise as the QUESTION A LISTENER HOLDS, in their words. "Why did Ruth lie about the Tuesday shift" and not "the Tuesday reveal arc".

WHAT MAKES SOMEBODY START THE NEXT EPISODE
${CLIFFHANGER_RULES.map((r) => `- ${r}`).join('\n')}

THIS IS HEARD, NOT READ
${EAR_RULES_FOR_PLANNING.map((r) => `- ${r}`).join('\n')}

EACH EPISODE CARD
- opens: the first MOMENT, not a summary. Something already happening that somebody wants and cannot have yet.
- story: what happens, one paragraph, concrete. Name the people and what they do.
- changes: what is irreversibly different by the end. If you cannot fill this in, the episode is not pulling its weight and should be merged with its neighbour.
- cliffhanger: the last thing the listener hears. Leave it EMPTY on the final episode only.
- plants / paysOff: promise ids, and nothing that is not in your promise list.`;

const RETURN_SHAPE = `Return ONLY this JSON object.

{
  "title": "the season's name",
  "premise": "one sentence, how a listener would describe this to a friend",
  "spine": "the one thing the season is about and how it settles",
  "world": ["a rule of this place the story leans on", "another"],
  "carryCast": [
    {"name": "Ruth", "who": "one line on who they are"}
  ],
  "promises": [
    {"id": "the-tuesday-shift", "text": "Why did Ruth lie about where she was"}
  ],
  "episodes": [
    {
      "number": 1,
      "title": "the episode's name",
      "opens": "the first moment, already in progress",
      "story": "what happens, one paragraph",
      "changes": "what is irreversibly different by the end",
      "cliffhanger": "the last thing the listener hears",
      "plants": ["the-tuesday-shift"],
      "paysOff": []
    }
  ]
}`;

/** The planner's half of the plan. The rest is known before the call. */
const draftSchema = seasonPlanSchema.omit({ personaId: true, seasonNumber: true });

export interface PlanSeasonInput {
  persona: Persona;
  seasonNumber: number;
  /** How many episodes. Within SEASON_EPISODES. */
  episodes: number;
  /** Minutes per episode, so the cards are sized to what an episode can hold. */
  episodeMinutes: number;
  /** A steer from the person running it, or nothing at all. */
  premise?: string;
  isoDate: string;
}

export const planSeason = async (
  input: PlanSeasonInput,
  model: LlmClient,
  onCost?: (pence: number) => void
): Promise<SeasonPlan> => {
  const { persona, episodes, episodeMinutes } = input;
  const canon = canonAsOf(persona, input.isoDate);
  const say = (kind: string) =>
    canon
      .filter((c) => c.kind === kind)
      .map((c) => `- ${c.text.trim().replace(/\s+/g, ' ')}`)
      .join('\n');

  const [minEps, maxEps] = SEASON_EPISODES;
  if (episodes < minEps || episodes > maxEps) {
    throw new Error(`a season is ${minEps} to ${maxEps} episodes, not ${episodes}`);
  }

  const system = `${SEASON_INSTRUCTION}

SHOW: ${persona.name}
THESIS: ${persona.thesis.trim().replace(/\s+/g, ' ')}
AUDIENCE: ${persona.audience.trim().replace(/\s+/g, ' ')}
REGISTER: ${persona.register.trim().replace(/\s+/g, ' ')}

WHAT THIS SHOW BELIEVES
${say('belief') || '- (none recorded)'}

WHAT THIS SHOW NEVER DOES
${say('taboo') || '- (none recorded)'}
These are absolute. A plan that requires one of them to be broken is the wrong plan, not a reason to break it.

THE SHOW ALREADY HAS THESE PEOPLE, AND THEY ARE CAST
${voiceBrief(persona.hosts)}

They are not suggestions and they are not placeholders. Each one is a recorded voice a listener has already heard, or will hear on every episode of this season, and their speech habits above are measured rather than described. Build the season on them.

You may add people the season needs, but every one you add spends part of a budget of ${MAX_CARRY_CAST} names the listener can carry, and the people above are already inside it. Renaming one of them, or planning a season in which one of them is absent, is the single most expensive mistake available at this stage: the voices are bought and registered before a season is planned, and a plan that does not use them cannot be recorded.`;

  const prompt = `Break season ${input.seasonNumber} of ${persona.name}.

${episodes} episodes, about ${episodeMinutes} minutes each, so roughly ${episodes * episodeMinutes} minutes of story in total. Size each card to what ${episodeMinutes} minutes of audio can actually hold, which is less than it looks: one substantial scene, one shorter one, and the turn.

${
  input.premise
    ? `THE STEER, which you follow: ${input.premise}`
    : `No steer has been given, so the season comes from the show's own thesis.`
}

${RETURN_SHAPE}`;

  const reply = await completeJson<unknown>(
    model,
    {
      system,
      prompt,
      // Room for the thinking, not for the answer. The answer is a couple of
      // thousand words; a season structure is worth reasoning about at length
      // and this is the one call in the lane where that is cheap.
      maxTokens: 20_000,
      effort: 'medium',
      cacheSystem: true,
      // Plot wants to wander a little. Not as far as prose does.
      temperature: 0.8,
    },
    onCost
  );

  const draft = draftSchema.parse(reply);

  return seasonPlanSchema.parse({
    ...draft,
    personaId: persona.id,
    seasonNumber: input.seasonNumber,
  });
};
