/**
 * Going back for the cards the episode turned out to need.
 *
 * THE QUESTION THIS ANSWERS. "Why is the script fixed to those 28 claims, why
 * not use them and also write extra about other stuff that gets mentioned?"
 *
 * The answer is not that the writer should add things. Anything it adds from
 * its own knowledge is unverified, and in the audio an invented fact sounds
 * exactly like a sourced one - that is the premise the whole studio rests on.
 *
 * But the fence was rigid in the wrong direction. Extraction runs once, against
 * a beat sheet, before anyone knows which names the episode will lean on. It
 * produces a claim saying Arnold Paole was bothering people at night and none
 * saying who he was, and by the time that matters the evidence stage is over
 * and the writer's only options are to say a name it cannot place or to drop
 * him. Both make the episode worse.
 *
 * SO THE PIPELINE GOES BACK, AND IT IS NEARLY FREE. The corpus is already
 * fetched and sitting on disk - fourteen documents, no search, no network. BM25
 * finds the passage that talks about the name, one extraction call turns a
 * batch of gaps into claims, and each is verified like any other. Nothing here
 * relaxes a single check: a gap-filling claim carries its own quote, that quote
 * must occur in the source, and a different model family has to agree it
 * supports the claim.
 *
 * WHAT COUNTS AS A GAP is deliberately narrow: a name the claims MENTION and
 * never IDENTIFY. Not everything a listener might want - that is unbounded, and
 * an episode that explains everything explains nothing. A person who acts in
 * this story and is never placed is a specific, findable, fixable hole.
 */
import { Claim, claimSchema } from './claim';
import { Source } from './source';
import { scorePassages, splitPassages } from './passages';
import { completeJson, LlmClient } from '../models/client';
import { z } from 'zod';

/**
 * Words that are capitalised without being a name worth identifying.
 *
 * Months, days and countries are the common noise. A listener does not need
 * "July, the seventh month" and a claim saying so would be worse than nothing.
 */
const NOT_A_SUBJECT = new Set(
  (
    'january february march april may june july august september october november december ' +
    'monday tuesday wednesday thursday friday saturday sunday ' +
    'england scotland wales ireland britain america europe god lord king queen emperor ' +
    'the this that these those there their they when where what which who'
  ).split(' ')
);

/** A capitalised word that is plausibly somebody or somewhere. */
const NAME = /\b([A-Z][a-zA-Z'À-ɏ-]{2,})\b/g;

/**
 * Phrasings that introduce rather than merely mention.
 *
 * Crude on purpose. The cost of thinking a name is identified when it is not is
 * one missing explanation; the cost of the reverse is a wasted call. Both are
 * cheap, so a simple rule that is right most of the time is the right rule.
 */
const IDENTIFIES = [
  /\bwas (a|an|the)\b/i,
  /\bis (a|an|the)\b/i,
  /\bwere (a|an|the)\b/i,
  /\bworked as\b/i,
  /\bserved as\b/i,
  /\bknown as\b/i,
  /\baged? \d/i,
  /\b\d{1,3} years old\b/i,
  /,\s*(a|an|the)\s+\w+/i,
  /\bis a (village|town|city|river|region|province)\b/i,
  /\blies (in|on|near)\b/i,
];

export interface Gap {
  /** The name nobody has placed. */
  name: string;
  /** How many claims lean on it, so the worst gaps can be filled first. */
  mentions: number;
}

/**
 * Names the claims use and never introduce.
 *
 * Sorted by how often they are leaned on, because a name carrying six claims
 * costs the listener six sentences and a name carrying one costs them one.
 */
export const findGaps = (claims: Claim[], limit = 6): Gap[] => {
  const mentions = new Map<string, number>();
  const identified = new Set<string>();

  for (const claim of claims) {
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    const re = new RegExp(NAME.source, 'g');
    while ((m = re.exec(claim.text))) {
      const name = m[1]!;
      if (NOT_A_SUBJECT.has(name.toLowerCase())) continue;
      seen.add(name);
    }

    for (const name of seen) {
      mentions.set(name, (mentions.get(name) ?? 0) + 1);

      // Identified BY THIS CLAIM only if the introducing phrase sits near the
      // name, not merely somewhere in a claim that happens to mention it.
      const at = claim.text.indexOf(name);
      const window = claim.text.slice(at, at + 90);
      if (IDENTIFIES.some((re2) => re2.test(window))) identified.add(name);
    }
  }

  return [...mentions.entries()]
    .filter(([name]) => !identified.has(name))
    .map(([name, count]) => ({ name, mentions: count }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, limit);
};

/**
 * The stretch of corpus most likely to say who somebody is.
 *
 * Deterministic selection, exactly as in repair.ts: BM25 picks the candidate,
 * costs nothing and cannot invent a passage. Whether it actually identifies
 * anybody is the extractor's problem and then the verifier's.
 */
export const passagesAbout = (name: string, sources: Source[], perSource = 1): Array<{ sourceId: string; text: string }> => {
  const out: Array<{ sourceId: string; text: string; score: number }> = [];

  for (const source of sources) {
    const passages = splitPassages(source.text);
    if (!passages.length) continue;
    const scored = scorePassages(passages, [name])
      .filter((p) => p.text.includes(name))
      .sort((a, b) => b.score - a.score)
      .slice(0, perSource);
    for (const p of scored) out.push({ sourceId: source.id, text: p.text, score: p.score });
  }

  return out
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ sourceId, text }) => ({ sourceId, text }));
};

export const GAP_SYSTEM = `You find out who somebody is, from documents that
mention them.

You are given a NAME and passages from the corpus that mention it. Write ONE
claim saying who or what that name is, and give the verbatim quote that
establishes it.

This is for a listener who has never heard the name and cannot look anything up.
What they need is the thing that lets them hold on to it: a job, a rank, an age,
a place, what somebody had done before, what kind of place somewhere is.

Rules, and they are the same rules every other claim here answers to:
- THE QUOTE MUST BE COPIED EXACTLY from one of the passages. It is checked
  character by character and a paraphrase is rejected.
- THE CLAIM MUST SAY NO MORE THAN THE QUOTE ESTABLISHES. If the quote says
  "Paole, a hajduk", the claim says he was a hajduk and nothing about what a
  hajduk is - that would be a second claim needing its own quote.
- DO NOT RESOLVE WHAT THE QUOTE LEAVES OPEN, and do not add anything from your
  own knowledge, however sure you are.
- IF THE PASSAGES DO NOT SAY WHO THIS IS, return found: false. That is a useful
  answer and a common one. Guessing is the only wrong move available here.

Return JSON only:
{"found": true, "text": "who or what the name is", "sourceId": "the id given with the passage you used", "quote": "verbatim"}`;

const gapReplySchema = z.object({
  found: z.boolean(),
  text: z.string().default(''),
  sourceId: z.string().default(''),
  quote: z.string().default(''),
});

export interface FillDeps {
  sources: Source[];
  model: LlmClient;
  /** Same verifier every other claim answers to. */
  verify: (claim: Claim) => Promise<boolean>;
  onCost?: (pence: number) => void;
  onProgress?: (message: string) => void;
}

/**
 * Turn gaps into claims, or leave them unfilled.
 *
 * One call per gap, capped by the caller. A gap that cannot be filled from the
 * corpus is dropped silently - it means the documents do not say, which the
 * writer already knows how to handle by writing around it.
 */
export const fillGaps = async (
  gaps: Gap[],
  deps: FillDeps,
  beatId: string,
  startingId: number
): Promise<Claim[]> => {
  const filled: Claim[] = [];
  let nextId = startingId;

  for (const gap of gaps) {
    const passages = passagesAbout(gap.name, deps.sources);
    if (!passages.length) continue;

    let reply: z.infer<typeof gapReplySchema>;
    try {
      reply = gapReplySchema.parse(
        await completeJson<unknown>(
          deps.model,
          {
            system: GAP_SYSTEM,
            prompt: [
              `NAME: ${gap.name}`,
              ...passages.map((p) => `PASSAGE [${p.sourceId}]:\n${p.text}`),
            ].join('\n\n'),
            temperature: 0,
            // Low: this is reading a passage for one fact, not a judgement.
            effort: 'low',
            maxTokens: 1200,
          },
          deps.onCost,
          { parse: (v) => gapReplySchema.parse(v), label: `who ${gap.name} is` }
        )
      );
    } catch {
      // A gap that will not fill is not a reason to lose the episode.
      continue;
    }

    if (!reply.found || !reply.text.trim() || !reply.quote.trim()) continue;

    const claim = claimSchema.parse({
      id: `g${nextId}`,
      text: reply.text.trim(),
      type: 'attribution',
      beatId,
      sourceId: reply.sourceId.trim(),
      quote: reply.quote.trim(),
    });

    if (!(await deps.verify(claim))) continue;

    nextId++;
    filled.push(claim);
    deps.onProgress?.(`found who ${gap.name} was`);
  }

  return filled;
};
