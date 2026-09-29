/**
 * Whether the script says anything the evidence does not support.
 *
 * THE GAP THIS CLOSES, AND IT IS THE MOST SERIOUS ONE FOUND SO FAR.
 *
 * Every factual assertion is supposed to come from a claim, and every claim is
 * bound to a verified quote. But nothing has ever checked the SCRIPT against the
 * claims. The evidence apparatus proves that each claim is entailed by its quote;
 * it says nothing about the prose written between them.
 *
 * An episode of the Descent of Inanna made that concrete. It told the seven gates
 * beautifully: the crown, the earrings, the necklace, the ornaments on the breast,
 * the gold ring, the measuring rod, the robe, in order, each at its own gate. Of
 * the thirty-nine claims behind that episode, TWO mentioned the regalia, and both
 * were generic - that she passes through seven gates and is stripped, and that she
 * stands naked before Ereshkigal. The enumeration came from the model's own
 * knowledge of the poem.
 *
 * It was also correct, which is what makes it dangerous. A plausible, accurate,
 * unsourced passage is indistinguishable from a sourced one in the audio, it is
 * the single best passage in the episode, and every deterministic check passed it.
 * It was praised as a success before anybody looked at the ledger.
 *
 * WHY THIS CANNOT BE A REGEX. Numbers and names are checkable and were checked:
 * across four runs, every figure in every script traced to the claims or the
 * corpus, so a numbers-grounding check would find nothing. The invention was in
 * COMMON NOUNS - earrings, a necklace, a measuring rod - and no pattern separates
 * "a noun the evidence supports" from "a noun that belongs to this story and is
 * not in the evidence". It needs something that can read.
 *
 * SO IT IS A MODEL CALL, AND A DIFFERENT FAMILY FROM THE WRITER. The same rule
 * the verifier follows, for the same reason: a model scores its own output higher,
 * and asking the writer whether it invented anything is asking the wrong witness.
 *
 * WHAT IT DOES NOT DO. It does not block. An episode is not refused over this,
 * because the check is a judgement and judgements are wrong sometimes, and because
 * the owner's standing instruction is that a finding should be highlighted rather
 * than used to stop a script that is otherwise good. It marks the run as needing a
 * human and names the sentences, which is what a person reading before the render
 * actually needs.
 */
import { z } from 'zod';
import { Claim } from '../evidence/claim';
import { completeJson, LlmClient } from '../models/client';
import { Script, beatText } from '../script/write';

export const groundingFindingSchema = z.object({
  beatId: z.string().default(''),
  /** The sentence as the script has it, so a person can find it. */
  sentence: z.string().default(''),
  /** What specifically is unsupported, in a clause. */
  detail: z.string().default(''),
});

export type GroundingFinding = z.infer<typeof groundingFindingSchema>;

export const groundingReportSchema = z.object({
  findings: z.array(groundingFindingSchema).default([]),
  /** So a run that could not be checked is distinguishable from a clean one. */
  checked: z.boolean().default(true),
  /** Why it could not be checked, when it could not. */
  failure: z.string().optional(),
});

export type GroundingReport = z.infer<typeof groundingReportSchema>;

export const GROUNDING_SYSTEM = `You are checking a finished audio script against the
evidence it was allowed to use. You are not judging the writing.

You are given every verified CLAIM available to the writer, and the SCRIPT. Find
the places where the script states a specific fact that no claim supports.

WHAT TO REPORT. A named object, a count, a sequence of items, a date, a place, a
title, a cause, or a piece of dialogue that appears in the script and is not in
the claims. The commonest and most important case is an ENUMERATION: the claims
say something happened at each of seven stages, and the script lists what happened
at all seven. Six of those are invented, however right they sound.

WHAT NOT TO REPORT, and this is most of the script:
- Connective prose. "She walks forward", "and then", "which is why" - a writer has
  to join sentences and joining them is not a factual claim.
- A claim's own content rephrased, summarised, or made plainer. That is the job.
- Two claims combined into one sentence.
- Ordinary inference a listener would make anyway from the claims given.
- Anything in the claims but worded differently. Match on the FACT, not the words.

Be conservative. A false accusation here costs somebody a search through a script
for a problem that is not there, and it teaches them to ignore you. If you are not
sure the claims fail to support it, leave it out.

Return JSON only:
{"findings": [{"beatId": "which beat", "sentence": "the sentence from the script, verbatim", "detail": "what the claims do not support"}]}

An empty findings array is a good and common answer.`;

/**
 * Read the script against the claims.
 *
 * ONE CALL FOR THE WHOLE SCRIPT, not one per beat. The question is whether a fact
 * appears anywhere in the evidence, so a per-beat call would have to be handed
 * every claim anyway and would pay for the claims list several times over.
 */
export const reviewGrounding = async (
  input: { script: Script; claims: Claim[] },
  model: LlmClient,
  onCost?: (pence: number) => void
): Promise<GroundingReport> => {
  const usable = input.claims.filter((c) => c.status !== 'unverified');
  if (!usable.length) return { findings: [], checked: false };

  const claims = usable.map((c) => `[${c.id}] ${c.text.replace(/\s+/g, ' ')}`).join('\n');
  const script = input.script.beats
    .map((b) => `--- ${b.beatId} ---\n${beatText(b)}`)
    .join('\n\n');

  try {
    const reply = await completeJson<unknown>(
      model,
      {
        system: GROUNDING_SYSTEM,
        prompt: [`CLAIMS:\n${claims}`, `SCRIPT:\n${script}`].join('\n\n'),
        temperature: 0,
        // LOW EFFORT AND A LARGE CEILING, WHICH IS NOT THE COMPROMISE IT LOOKS
        // LIKE. Two wrong answers got here, and the second was worse.
        //
        // First attempt: medium effort, 4000 tokens. It cost 55.6p on one episode
        // against 67.2p for the entire rest of it.
        //
        // Second attempt: I cut the ceiling to 1500 to cut the cost. That made it
        // FAIL, twice, and cost 25.6p to fail. Thinking tokens count against
        // max_tokens on this model family, so a small ceiling is spent reasoning
        // and the response comes back truncated. completeJson then does the right
        // thing and retries with the ceiling doubled - which is why both attempts
        // appear in the journal as two charges each. 81.2p total for a check that
        // never once returned a result. This exact failure is recorded in
        // docs/DECISIONS.md under the streaming decision, and I walked into it.
        //
        // The ceiling is not a budget. Nothing is charged for room that goes
        // unused, and the truncation retry is what actually costs money, so a
        // GENEROUS ceiling is both cheaper and more reliable than a tight one.
        // Low effort is where the saving really comes from, and client.ts says so
        // in as many words: lower effort is cheaper and more reliable for
        // structured output.
        effort: 'low',
        maxTokens: 8000,
      },
      onCost,
      { parse: (v) => groundingReportSchema.parse(v), label: 'the grounding review' }
    );

    return groundingReportSchema.parse(reply);
  } catch (err) {
    // A FAILED REVIEW IS NOT A CLEAN ONE, and saying so is the whole point of
    // `checked`. A run whose grounding call died must not read as a run whose
    // script was found to be fully sourced.
    //
    // THE REASON IS KEPT, because without it this failed silently twice and the
    // only visible symptom was `checked: false` in a JSON file nobody had a
    // reason to open. An advisory check that breaks quietly is worse than one
    // that does not exist, since the run still says the script was reviewed.
    return { findings: [], checked: false, failure: (err as Error).message.slice(0, 300) };
  }
};
