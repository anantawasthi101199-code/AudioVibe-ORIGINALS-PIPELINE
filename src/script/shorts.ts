/**
 * Shorts, derived from an episode that already exists.
 *
 * THIS IS THE BIGGEST COST LEVER IN THE PIPELINE, and it is worth being explicit
 * about why. A standalone short would need its own brief, its own search, its
 * own corpus, its own extraction, its own verification and its own
 * counter-evidence pass - the entire expensive half of the system - to produce
 * seventy-five seconds of audio. A DERIVED short inherits all of that from its
 * parent episode, because those claims are already bound to quotes that were
 * already checked.
 *
 *   Standalone short  ~ £1.10   (research dominates)
 *   Derived short     ~ £0.12   (one selection call, five short beats, render)
 *
 * Same verified facts, same voices, roughly a ninth of the cost. So the rule is
 * that shorts are derived by default, and a standalone short is something you
 * ask for deliberately.
 *
 * A SHORT IS NOT A TRAILER. It has to be worth hearing by somebody who will
 * never play the long one. A short that summarises the episode is an advert,
 * and adverts get scrolled. So the selection below asks for the strongest
 * SELF-CONTAINED moment, not the most representative one.
 *
 * IT ALSO HAS TO SOUND LIKE THE FEED, NOT LIKE A PODCAST. That is what
 * SHORT_FORM_GUIDANCE is for: a listener in a feed arrived by accident, the
 * first word is competing with a thumb, and every convention that makes long
 * form comfortable - the greeting, the setup, the sign-off - is what gets a
 * short skipped.
 */
import { z } from 'zod';
import { Claim } from '../evidence/claim';
import { completeJson, LlmClient } from '../models/client';
import { Script, beatText } from './write';

/**
 * How a short is written, as distinct from an episode.
 *
 * Phrased as things to DO. "Don't sound like a podcast" produces a model's idea
 * of not-a-podcast, which is exclamation marks and false urgency.
 */
export const SHORT_FORM_GUIDANCE = [
  'Start mid-thought. The first word is already part of the fact - no greeting, no "so", no setup, never the name of the show.',
  'Assume the listener arrived by accident and owes you nothing. Nothing is "as we discussed" and nothing is "you might remember".',
  'One idea. A short that carries two ideas carries neither.',
  'No sign-off, no thanks, no call to action, no "follow for more". Land the last line and stop talking.',
  'Present tense wherever the facts allow it. It puts the listener in the room.',
  'Shorter sentences than the long show uses, but still varied - three short then one long is a rhythm; four short is a machine gun.',
  'It must stand alone. Someone who never hears the full episode should still have received something whole.',
  'Do not summarise the episode. Do not tease it. Tell one thing properly.',
];

export const shortSelectionSchema = z.object({
  /** The single moment worth seventy-five seconds. */
  angle: z.string().min(1),
  /** Claims from the parent that this short may state. */
  claimIds: z.array(z.string()).min(1),
  /** Why this one, kept in the run artifact so a weak choice is diagnosable. */
  reason: z.string().default(''),
});

export type ShortSelection = z.infer<typeof shortSelectionSchema>;

const SELECT_SYSTEM = `You pick the single strongest moment from a finished
audio episode, to be told on its own as a seventy-five second short.

You are given the episode's script and the verified facts it was built from.

Pick the moment that is most worth hearing BY SOMEONE WHO WILL NEVER HEAR THE
EPISODE. That is a different question from "what is this episode about".

A good pick:
- Is one specific, surprising thing, not a theme.
- Can be understood with no setup at all.
- Has a real answer inside the facts you were given, not in the rest of the episode.
- Would make someone say "wait, what?" rather than "that's interesting".

A bad pick:
- Summarises the episode.
- Needs the episode's context to make sense.
- Is the episode's conclusion. A conclusion without its argument is just an assertion.

Pick TWO to FOUR facts. One is not enough to state the thing and then answer
it; more than four is a list rather than one idea.

Return JSON only:
{"angle": "the one thing this short is about, in a sentence",
 "claimIds": ["ids the short may state"],
 "reason": "one sentence on why this one"}`;

/**
 * Choose what a short should be about, from a parent episode.
 *
 * One call, and the only model spend a derived short adds over writing it.
 */
export const selectShortAngle = async (
  parent: Script,
  claims: Claim[],
  writer: LlmClient,
  onCost?: (pence: number) => void
): Promise<ShortSelection> => {
  const script = parent.beats.map((b) => `[${b.beatId}] ${beatText(b)}`).join('\n\n');
  const facts = claims.map((c) => `[${c.id}] (${c.type}) ${c.text}`).join('\n');

  const selection = shortSelectionSchema.parse(
    await completeJson(
      writer,
      {
        system: SELECT_SYSTEM,
        prompt: [
          `EPISODE: ${parent.title}`,
          `SCRIPT:\n${script}`,
          `VERIFIED FACTS:\n${facts}`,
        ].join('\n\n'),
        temperature: 0.6,
        maxTokens: 800,
      },
      onCost
    )
  );

  // A short may only state facts the parent already verified. Anything else is
  // an unverified claim wearing a verified episode's clothes, and the whole
  // point of deriving is that the checking has already happened.
  const known = new Set(claims.map((c) => c.id));
  const unknown = selection.claimIds.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new Error(
      `the short selected claims that are not in the parent episode: ${unknown.join(', ')}. ` +
        `A derived short may only restate facts that were already verified.`
    );
  }

  return selection;
};

/** A short beat and how many claims it is required to carry. */
export interface ShortBeatSlot {
  id: string;
  minClaims: number;
}

/**
 * The claims a derived short is allowed to use, re-pointed at its own beats.
 *
 * Claims carry the beat they were written for, and a short's beats have
 * different ids. Without this the writer is handed claims for `mechanism` while
 * writing `pivot`, sees none for the beat in front of it, and writes a beat with
 * no facts in it - which passes silently and reads as filler.
 *
 * FLOORS FIRST, THEN SPREAD, and the order is the whole point. A plain
 * round-robin looks fair and is wrong: with two claims and four beats it can
 * put both on the beats that did not need one and leave the two that did
 * empty, so the gate fails a short that had exactly the facts it needed. So
 * every beat with a floor is filled to its floor in beat order first, and only
 * what is left over gets spread.
 *
 * Throws when there are not enough claims to meet the floors at all. That is a
 * real failure - a short with nothing to say in the beat that answers the
 * question - and it belongs here, where the parent's claims are still in hand
 * and a different selection is one cheap call away, rather than at the gate
 * after a render has been paid for.
 */
export const redistributeClaims = (
  claims: Claim[],
  selection: ShortSelection,
  beats: ShortBeatSlot[]
): Claim[] => {
  const chosen = claims.filter((c) => selection.claimIds.includes(c.id));
  if (!chosen.length || !beats.length) return [];

  const required = beats.reduce((sum, b) => sum + b.minClaims, 0);
  if (chosen.length < required) {
    throw new Error(
      `the short selected ${chosen.length} claim(s) but its beats require ${required}: ` +
        beats
          .filter((b) => b.minClaims > 0)
          .map((b) => `${b.id} needs ${b.minClaims}`)
          .join(', ')
    );
  }

  const out: Claim[] = [];
  const queue = [...chosen];

  for (const beat of beats) {
    for (let i = 0; i < beat.minClaims; i++) {
      out.push({ ...queue.shift()!, beatId: beat.id });
    }
  }

  // Whatever is left spreads across every beat, floors included, so a short
  // with more facts than floors still gives its middle beats something
  // concrete rather than leaving them to improvise.
  queue.forEach((claim, i) => {
    out.push({ ...claim, beatId: beats[i % beats.length]!.id });
  });

  return out;
};
