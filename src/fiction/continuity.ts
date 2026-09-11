/**
 * Continuity checking: the fiction lane's answer to verification.
 *
 * WHAT REPLACES WHAT. In the factual lane a claim is bound to a verbatim quote,
 * a deterministic check confirms the quote exists, and a different model family
 * then judges entailment. Fiction has no quotes, so the shape is kept and the
 * ground truth swapped:
 *
 *   deterministic pass  - does every named thing exist in the bible, and does
 *                         the episode contradict a FIXED fact on its face
 *   model pass          - a different family reads the new script against the
 *                         established facts and reports contradictions
 *
 * THE DETERMINISTIC PASS RUNS FIRST AND ITS FAILURES ARE FREE. Same reason as
 * the evidence lane: an episode that invents a character nobody has met does
 * not need a model to notice, and finding it here costs nothing while finding
 * it at the model stage costs a call.
 *
 * WHY THE CHECKER IS THE VERIFIER AND NOT THE WRITER. Unchanged from the
 * factual lane, and for the identical reason. A writer asked whether its own
 * episode contradicts the series reconstructs why it does not. This is the one
 * place fiction is MORE prone to the failure, because a plausible-sounding
 * reconciliation is exactly what a story writer is good at producing.
 *
 * A NOTE ON WHAT THIS DOES NOT CHECK. Whether the story is any good. Nothing
 * here scores plot, and nothing should: the style, hook, loop and voice checks
 * already run on fiction unchanged, and beyond those, "is this a good episode"
 * is a question for the person reading the gate report.
 */
import { z } from 'zod';
import { completeJson, LlmClient } from '../models/client';
import { Script, fullText } from '../script/write';
import { Bible, Entity, allFacts } from './bible';

export const continuityVerdictSchema = z.enum(['consistent', 'contradicts', 'unclear']);

export type ContinuityVerdict = z.infer<typeof continuityVerdictSchema>;

export interface ContinuityFinding {
  /** What established fact this is about, as the bible states it. */
  established: string;
  /** Which entity it belongs to. */
  entityName: string;
  verdict: ContinuityVerdict;
  reason: string;
}

export interface ContinuityReport {
  findings: ContinuityFinding[];
  /** Findings that must stop a publish. */
  blocking: ContinuityFinding[];
  /** Names the episode uses that are not in the bible. */
  unknownEntities: string[];
  costPence: number;
  checkerModel: string;
}

/**
 * `unclear` blocks.
 *
 * Same call as the evidence lane makes on `partially_entailed`: a checker that
 * cannot tell whether the episode contradicts the series has not established
 * that it does not. Fiction is if anything the easier place to be wrong here,
 * because prose that half-contradicts something still reads perfectly well.
 */
export const BLOCKING_VERDICTS: ContinuityVerdict[] = ['contradicts', 'unclear'];

/**
 * Names in the script that the bible has never heard of.
 *
 * A HEURISTIC, AND DELIBERATELY ADVISORY BECAUSE OF IT. Capitalised words are
 * a poor proxy for proper nouns: sentence openers, dialogue openers and any
 * ordinary word after a full stop all qualify. So this reports rather than
 * blocks, and the gate treats it as something for a person to glance at.
 *
 * It is still worth having. The failure it catches - a character introduced in
 * episode nine who was never introduced at all, because the writer forgot which
 * ones exist - is invisible to every other check and obvious once named.
 */
export const unknownNames = (script: Script, bible: Bible): string[] => {
  const known = new Set<string>();
  for (const entity of bible.entities) {
    for (const word of entity.name.split(/\s+/)) known.add(word.toLowerCase());
  }

  const text = fullText(script);
  const found = new Set<string>();

  // Only mid-sentence capitals, which removes the sentence-opener false
  // positives that would otherwise drown the real ones.
  const midSentence = /(?<![.!?]\s|^)\b([A-Z][a-z]{2,})\b/gm;
  for (const match of text.matchAll(midSentence)) {
    const word = match[1]!;
    if (!known.has(word.toLowerCase())) found.add(word);
  }

  return [...found].sort();
};

/**
 * Facts the script contradicts on its face, found without a model.
 *
 * Narrow on purpose. It only fires when the bible states a fact using a number
 * or a proper noun and the script states a DIFFERENT one in the same frame -
 * the "her brother Tomas" / "her brother Petar" case. Anything subtler is left
 * to the model pass rather than guessed at here, because a deterministic check
 * that produces false positives gets switched off, and then it catches nothing.
 */
export const obviousContradictions = (
  script: Script,
  bible: Bible
): Array<{ entity: Entity; established: string; reason: string }> => {
  const text = fullText(script).toLowerCase();
  const out: Array<{ entity: Entity; established: string; reason: string }> = [];

  for (const { entity, fact } of allFacts(bible)) {
    if (fact.revisable) continue;

    // Numbers in an established fact are the checkable part: ages, counts,
    // distances, years. If the script talks about this entity and uses a
    // different number in the same phrasing, that is worth surfacing.
    const numbers = fact.text.match(/\b\d+\b/g);
    if (!numbers || !text.includes(entity.name.toLowerCase())) continue;

    for (const number of numbers) {
      // The word AFTER the number, and only that. It is the noun the number
      // counts - "3 sisters", "20 years", "2 hours" - and it is what makes
      // three sisters different from three miles.
      //
      // The word BEFORE was tried and removed. "Ruth has 3 sisters" anchors on
      // "has", and then "Ruth has 9 brothers" reads as a contradiction about
      // her sisters. A deterministic check that produces false positives is one
      // somebody switches off, and then it catches nothing at all.
      const frame = new RegExp(`\\b${number}\\s+(\\w+)`, 'i');
      const context = frame.exec(fact.text);
      if (!context) continue;

      const anchor = (context[1] ?? '').toLowerCase();
      if (anchor.length < 3) continue;

      const inScript = new RegExp(`\\b(\\d+)\\s+${anchor}\\b`, 'gi');
      for (const hit of text.matchAll(inScript)) {
        const said = hit[1];
        if (said && said !== number) {
          out.push({
            entity,
            established: fact.text,
            reason: `the bible says ${number} ${anchor}, the script says ${said}`,
          });
        }
      }
    }
  }

  return out;
};

const CHECK_SYSTEM = `You check one episode of a serial audio drama against what
earlier episodes established.

You are given the established facts and the new episode's script. You are NOT
given the earlier episodes, and you must not assume anything about them beyond
what the facts say.

For each established fact, answer whether the new script contradicts it.

  consistent  - the script agrees with the fact, or does not touch on it
  contradicts - the script says something that cannot be true alongside it
  unclear     - the script touches on it and you cannot tell

Rules that matter:
- Not mentioning a fact is CONSISTENT, not unclear. Episodes are allowed to be
  about other things.
- A character being WRONG about something is not a contradiction. People in
  stories misremember, lie, and are lied to. What matters is what the episode
  presents as true.
- New information that fits alongside a fact is consistent. Only say
  contradicts when both cannot be true at once.
- Answer only from the fact and the script in front of you. Do not reason about
  what would make a better story.

Return JSON only: [{"index": 0, "verdict": "consistent", "reason": "one sentence"}]`;

/**
 * Check a new episode against the series bible.
 *
 * One call for the whole bible rather than one per fact. The factual lane goes
 * per claim because each has its own quote and its own source document, and
 * batching would let one bleed into another. Here every fact is checked against
 * the SAME script, so the script would be re-sent on every call - which is the
 * expensive half of the prompt, paid once per fact for no gain in isolation.
 */
export const checkContinuity = async (
  script: Script,
  bible: Bible,
  checker: LlmClient,
  onCost?: (pence: number) => void
): Promise<ContinuityReport> => {
  const facts = allFacts(bible).filter(({ fact }) => !fact.revisable);

  // THE DETERMINISTIC PASS, FIRST AND FREE. Same ordering as the evidence
  // lane's quote check: what arithmetic can settle should never cost a call,
  // and a contradiction found here is found whether or not the model pass
  // later agrees with itself.
  const obvious: ContinuityFinding[] = obviousContradictions(script, bible).map((o) => ({
    established: o.established,
    entityName: o.entity.name,
    verdict: 'contradicts' as const,
    reason: o.reason,
  }));

  const base: ContinuityReport = {
    findings: obvious,
    blocking: [...obvious],
    unknownEntities: unknownNames(script, bible),
    costPence: 0,
    checkerModel: checker.model,
  };

  // A first episode has nothing to contradict. Not an early return that skips
  // the report: the unknown-name list is still worth having, because a first
  // episode is exactly where the cast gets decided.
  if (!facts.length) return base;

  const numbered = facts.map(({ entity, fact }, i) => `${i}. [${entity.name}] ${fact.text}`);

  // Tracked separately because the report carries its own cost, and
  // completeJson may make two calls.
  let spent = 0;
  const raw = await completeJson<unknown>(
    checker,
    {
      system: CHECK_SYSTEM,
      prompt: [`ESTABLISHED:\n${numbered.join('\n')}`, `NEW EPISODE:\n${fullText(script)}`].join(
        '\n\n'
      ),
      temperature: 0,
      maxTokens: Math.max(1000, facts.length * 80),
    },
    (pence) => {
      spent += pence;
      onCost?.(pence);
    }
  );

  const parsed = z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        verdict: continuityVerdictSchema,
        reason: z.string().default(''),
      })
    )
    .parse(raw);

  const byIndex = new Map(parsed.map((p) => [p.index, p]));

  const findings: ContinuityFinding[] = facts.map(({ entity, fact }, i) => {
    const answer = byIndex.get(i);
    return {
      established: fact.text,
      entityName: entity.name,
      // A fact the checker skipped is NOT consistent by default. Silence about
      // a fact is the same as being unable to tell, and defaulting the other
      // way would let a truncated response pass the whole bible.
      verdict: answer?.verdict ?? 'unclear',
      reason: answer?.reason ?? 'the checker did not return a verdict for this fact',
    };
  });

  // The deterministic findings are kept alongside the model's rather than
  // replaced by it. A model that reads "her 2 sisters" as consistent with "3
  // sisters" is wrong, and its opinion does not get to overturn arithmetic.
  const all = [...obvious, ...findings];

  return {
    ...base,
    findings: all,
    blocking: all.filter((f) => BLOCKING_VERDICTS.includes(f.verdict)),
    costPence: spent,
  };
};

const EXTRACT_SYSTEM = `You read one episode of a serial audio drama and record
what it ESTABLISHED, so later episodes do not contradict it.

Record only what the episode presents as TRUE. Not what a character believes,
guesses, hopes, or claims - unless the episode confirms it.

For each thing recorded, say which person, place, object or organisation it is
about. Reuse an existing id when the episode is about something already on the
list; invent a new id only for something genuinely new.

Mark revisable: true for anything the episode presents as true but leaves room
to overturn - a character's account of an event nobody else witnessed, an
identity nobody has confirmed. Everything solid is revisable: false.

Be sparing. Five to twelve facts for an episode. Recording every detail makes a
bible nothing can be written against.

Return JSON only:
{"newEntities": [{"id": "...", "kind": "character|place|object|organisation",
                  "name": "...", "summary": "one line"}],
 "facts": [{"entityId": "...", "text": "...", "revisable": false}],
 "synopsis": "two or three sentences on what happened"}`;

export const extractedEpisodeSchema = z.object({
  newEntities: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]+$/),
        kind: z.enum(['character', 'place', 'object', 'organisation']),
        name: z.string().min(1),
        summary: z.string().min(1),
      })
    )
    .default([]),
  facts: z
    .array(
      z.object({
        entityId: z.string().min(1),
        text: z.string().min(1),
        revisable: z.boolean().default(false),
      })
    )
    .default([]),
  synopsis: z.string().min(1),
});

export type ExtractedEpisode = z.infer<typeof extractedEpisodeSchema>;

/**
 * Read a finished episode and record what it established.
 *
 * RUNS AFTER THE GATE, NEVER BEFORE. An episode that failed must not enter the
 * bible, because every later episode would then be checked against something
 * that was never published - and would be marked as contradicting the series
 * for disagreeing with an episode nobody heard.
 */
export const extractEstablished = async (
  script: Script,
  bible: Bible,
  writer: LlmClient,
  onCost?: (pence: number) => void
): Promise<ExtractedEpisode> => {
  const existing = bible.entities.map((e) => `${e.id} (${e.kind}): ${e.name} - ${e.summary}`);

  return extractedEpisodeSchema.parse(
    await completeJson(
      writer,
      {
        system: EXTRACT_SYSTEM,
        prompt: [
          `ALREADY ON THE LIST:\n${existing.join('\n') || '(nothing yet)'}`,
          `EPISODE: ${script.title}`,
          fullText(script),
        ].join('\n\n'),
        temperature: 0.2,
        maxTokens: 2000,
      },
      onCost
    )
  );
};

/**
 * Fold an episode's established facts into the bible.
 *
 * Pure: returns a new bible rather than mutating, so a caller can check the
 * result before writing it and a test can assert on both.
 *
 * A fact whose entityId matches nothing is DROPPED rather than creating a
 * ghost entity. Silently inventing an entity to hang an orphan fact on is how
 * a bible fills with one-fact entities nobody named, and the fact itself is
 * recoverable from the run artifact if it mattered.
 */
export const applyEpisode = (
  bible: Bible,
  extracted: ExtractedEpisode,
  episode: { id: string; title: string }
): Bible => {
  const entities: Entity[] = bible.entities.map((e) => ({ ...e, facts: [...e.facts] }));
  const byId = new Map(entities.map((e) => [e.id, e]));

  for (const fresh of extracted.newEntities) {
    // An id that already exists is the extractor reusing rather than inventing,
    // which is what it was asked to do. Keep the original.
    if (byId.has(fresh.id)) continue;
    const entity: Entity = { ...fresh, facts: [], introducedIn: episode.id };
    entities.push(entity);
    byId.set(entity.id, entity);
  }

  for (const fact of extracted.facts) {
    const entity = byId.get(fact.entityId);
    if (!entity) continue;
    entity.facts.push({
      text: fact.text,
      episodeId: episode.id,
      revisable: fact.revisable,
    });
  }

  return {
    ...bible,
    entities,
    episodes: [
      ...bible.episodes,
      { id: episode.id, title: episode.title, synopsis: extracted.synopsis },
    ],
  };
};
