/**
 * The performance pass: the last thing that happens to a script before it is
 * voiced.
 *
 * WHAT IT IS FOR. Everything before this stage is about being RIGHT - the claims
 * are bound to quotes, the chronology is planned, the beats are checked. None of
 * that makes a thing somebody wants to listen to. A script can be accurate, in
 * order, plain, and still arrive as a well-organised report read aloud.
 *
 * So one pass over the finished script whose only job is how it SOUNDS: where a
 * sentence breaks, where a breath goes, which word lands last, where a listener
 * needs a place or a time before the next thing can mean anything.
 *
 * THE ONE HARD RULE, AND IT IS WHY THIS IS SAFE. It may not add a fact. Not a
 * number, not a name, not a date, not a place, not a detail. The pipeline spent
 * the whole run proving what it is allowed to say, and a polish pass that can
 * invent would undo all of it in one call - which is exactly the failure the
 * grounding review was built to catch. So the rule is stated in the prompt AND
 * enforced afterwards by `checkNoNewFacts`, deterministically, because a rule
 * that is only in a prompt is a hope. See the note on that function.
 *
 * WHY IT RUNS BEFORE THE GROUNDING REVIEW rather than after. Grounding reads the
 * script that will actually be spoken. If the polish ran afterwards, its output
 * would be the only text nobody had checked, which is the one place invention
 * would be invisible.
 *
 * WHY THE WRITER AND NOT THE VERIFIER. This is a writing job, and the verifier is
 * chosen for being a different family from the writer rather than for prose. The
 * risk of handing it back to the writer is invention, and that risk is handled by
 * the guard rather than by choosing a worse writer.
 */
import { z } from 'zod';
import { Persona, isDialogueShow } from '../canon/schema';
import { EpisodeFormat } from '../formats/schema';
import { completeJson, LlmClient } from '../models/client';
import { NARRATION_TAGS } from './narration';
import { StoryPlan } from './plan';
import { Script, ScriptBeat, beatText, scriptSchema } from './write';
import { Turn, stripUnknownTags, turnSchema, withoutTags } from './dialogue';

/**
 * What the pass is told, and it is deliberately about DELIVERY rather than craft.
 *
 * Every line here is something a good writer would not know from the text alone:
 * that this will be spoken once, by one voice, to somebody doing something else,
 * who cannot go back. None of it is "write well", because the script has already
 * been written well and telling a model to write well again produces a model's
 * idea of well-written, which is the flat thing this network keeps cutting out.
 */
export const PERFORMANCE_GUIDANCE = [
  'ONE IDEA PER SENTENCE, and the idea the sentence is about goes first. A listener builds meaning as the words arrive, so a sentence that holds its subject back makes them hold everything else in the air until it turns up.',
  'PUT THE LANDING WORD LAST. The word a sentence is really about should be the one it finishes on, because that is the word that stays in the air. "They found the vault open" lands on open. "The vault was found open by the men who arrived at six" lands on six, which is not the point.',
  'BREAK EVERY SENTENCE YOU CAN HEAR YOURSELF RUNNING OUT OF BREATH IN. Not because short is better, but because a comma-spliced chain has no place for the voice to rest and no place for a listener to catch up. Where a long sentence is doing real work, gathering things to land them together, keep it and put short ones either side.',
  'PLACE A THING BEFORE IT ACTS. If a listener meets a place, a person, a title or an object at the moment it does something, they spend that moment working out what it is instead of hearing what it did. A clause is enough, and it belongs in the sentence before.',
  'GO IN THE ORDER IT HAPPENED, and where the script reaches back to fill something in, move the fill-in to where it was first needed. A sentence that qualifies something said thirty seconds ago stops the story to do it.',
  'MARK THE TURN, DO NOT ANNOUNCE IT. Where the story changes direction, the change belongs in the sentences - a short one after a long one, a plain statement after a built-up scene. Never in a sentence about the episode.',
  'END EACH PART POINTING AT THE NEXT. The last two sentences of a stretch should leave something open, named and unexplained, so the next part is something the listener wants rather than something that merely follows.',
  'CUT ANY WORD THE SENTENCE STILL WORKS WITHOUT. Spoken prose carries less than written prose does. "Very", "quite", "actually", "of course", "it is worth noting", "in terms of", and any clause that restates the one before it.',
  'READ IT AS IF ALOUD AND FIX WHAT YOU STUMBLE ON. A cluster of similar-sounding names, a sentence where the same word appears twice for two different reasons, a number that needs a second to parse. Those are not visible on the page and they are the whole problem in audio.',
];

export const performanceSystem = (persona: Persona): string => {
  const dialogue = isDialogueShow(persona);

  return `You are preparing a finished script to be spoken aloud. You are not rewriting it.

SHOW: ${persona.name}
REGISTER: ${persona.register.trim().replace(/\s+/g, ' ')}

Somebody has already researched this, decided what it may say, and written it. Your
job is the last one before a voice reads it: make it land in the ear.

THE RULE THAT OVERRIDES EVERYTHING ELSE. You may not add a fact. No number, no
name, no date, no place, no title, no object, no quotation, no cause, no detail of
any kind that is not already in the text you are given. Every fact in this script
was traced to a document before it got to you, and anything you add has not been.
If a sentence seems to be missing something, that absence is deliberate - leave it
missing. This is checked afterwards and a pass that adds anything is discarded
whole.

WHAT YOU MAY DO:
- Split, join, reorder and re-punctuate sentences.
- Move a clause to where the listener needs it.
- Reorder sentences WITHIN a beat so events run in the order they happened.
- Cut words, and cut whole sentences that restate another.
- Change wording, as long as the fact is the same fact.
- Add delivery marks.

WHAT YOU MAY NOT DO:
- Add or remove a beat, or move text between beats.
- Change which claim ids a beat lists.
- Add a fact, as above.
- Make it longer. This pass should come out the same length or shorter.

HOW IT SHOULD SOUND
${PERFORMANCE_GUIDANCE.map((r) => `- ${r}`).join('\n')}

DELIVERY
${NARRATION_TAGS.map((r) => `- ${r}`).join('\n')}
${dialogue ? '\nThis show has more than one host. Keep every line with the speaker who says it.\n' : ''}
THE SPEAKER IDS ARE FIXED AND THERE ARE ONLY THESE: ${persona.hosts.map((h) => `"${h.id}"`).join(', ')}.
Use them exactly. Do not invent a label, do not translate one into a role name.

Return JSON only, every beat, in the order given, with the beat ids unchanged:
{"beats": [{"beatId": "...", "turns": [{"speaker": "${persona.hosts[0]!.id}", "text": "..."}]}]}`;
};

/**
 * What is measurably wrong with the draft, per beat, in the writer's own units.
 *
 * Only sentence length, because it is the one thing this pass can fix by
 * rewriting and the one thing three episodes in a row got wrong. Beats already at
 * or under the target are named as such, so the pass does not "fix" prose that is
 * already right, which is how a polish turns into damage.
 */
export const measuredBrief = (script: Script, persona: Persona): string => {
  const target = persona.styleCard.sentenceWordsMean;

  const rows = script.beats.map((b) => {
    const text = withoutTags(beatText(b));
    const sentences = text.split(/(?<=[.!?])\s+/).filter((x) => x.trim());
    const words = text.split(/\s+/).filter(Boolean).length;
    const mean = sentences.length ? words / sentences.length : 0;
    return { id: b.beatId, mean, over: mean > target * OVER_TARGET };
  });

  const over = rows.filter((r) => r.over);
  if (!over.length) {
    return (
      `SENTENCE LENGTH IS ALREADY WHERE IT SHOULD BE, around ${target} words a ` +
      `sentence. Do not shorten for the sake of it.`
    );
  }

  return [
    `WHAT IS MEASURABLY WRONG. This show reads at about ${target} words a sentence.`,
    'These beats are well over it, and bringing them down is the main thing you are here to do:',
    ...over.map((r) => `- ${r.id}: averages ${r.mean.toFixed(1)} words a sentence`),
    'Split the long ones. Same facts, more sentences. Leave the beats not listed alone.',
  ].join('\n');
};

const performReplySchema = z.object({
  beats: z
    .array(z.object({ beatId: z.string(), turns: z.array(turnSchema).min(1) }))
    .min(1),
});

/**
 * Anything in the polished text that is a fact and was not there before.
 *
 * WHY THIS IS THE LOAD-BEARING PART OF THE WHOLE STAGE. A pass that can rewrite
 * prose can invent, and this pipeline has already been caught inventing something
 * that read beautifully and was perfectly plausible: the seven items taken from
 * Inanna at the seven gates, of which the evidence supported one. A prompt saying
 * "do not add facts" is the same kind of instruction that failed on the writer,
 * the extractor and the question rate, and it will fail here too.
 *
 * So the check is arithmetic. Numbers and capitalised words are the two forms a
 * concrete fact almost always takes, they are cheap to extract, and a polish pass
 * has no legitimate reason to introduce either: rephrasing for the ear never needs
 * a number or a name that was not already being said.
 *
 * WHAT IT DELIBERATELY DOES NOT CATCH. A common noun, which is what the gates
 * were. Nothing deterministic separates a plausible common noun from a supported
 * one, which is why the grounding review exists and why this pass runs before it
 * rather than after. This guard is the cheap floor, not the ceiling.
 */
export const checkNoNewFacts = (
  before: string,
  after: string
): { added: string[] } => {
  const numbers = (text: string): Set<string> => {
    const out = new Set<string>();
    for (const m of text.matchAll(/\b\d[\d,.:]*\b/g)) out.add(m[0].replace(/[,.:]+$/, ''));
    return out;
  };

  /**
   * Every word in a text, lower-cased, wherever it sat.
   *
   * THE COMPARISON IS AGAINST ALL THE WORDS, not against the capitalised ones,
   * and the first version of this got it wrong in a way a test caught.
   *
   * It skipped sentence-initial capitals, on the correct reasoning that a capital
   * at the start of a sentence says nothing about whether the word is a name. But
   * skipping them on the AFTER side meant a fabricated name inserted at the front
   * of a sentence was invisible: "Neti the gatekeeper let her through" passed
   * against a draft that never mentioned Neti.
   *
   * Comparing against every word in the draft, in any position and any case, fixes
   * both halves at once. A name moved to the front of a sentence was already in the
   * draft somewhere, so it is not an addition. A name that is genuinely new is not
   * in the draft in any form, wherever it now sits.
   */
  /**
   * A word's forms, so a contraction is not mistaken for a new fact.
   *
   * THE THIRD FALSE POSITIVE A GUARD OF MINE PRODUCED TODAY, and this one rejected
   * an entire performance pass. The pass turned "that is" into "that's" - exactly
   * the spoken-English edit it exists to make - and the guard reported it as an
   * invented fact, because "that's" was not in the draft and is not a connective.
   *
   * So a word contributes both its full form and its stem before any apostrophe.
   * "that's" carries "that", "Inanna's" carries "inanna". That fixes contractions
   * and possessives in one move, and possessives were the commoner risk: a pass
   * rewriting "the crown of Inanna" as "Inanna's crown" is doing its job.
   */
  const forms = (word: string): string[] => {
    const lower = word.toLowerCase();
    const stem = lower.split(/['’]/)[0] ?? lower;
    return stem && stem !== lower ? [lower, stem] : [lower];
  };

  const allWords = (text: string): Set<string> => {
    const out = new Set<string>();
    for (const raw of text.replace(/\[[^\]]{0,40}\]/g, ' ').split(/\s+/)) {
      const word = raw.replace(/[^A-Za-z'’-]/g, '');
      if (word) for (const f of forms(word)) out.add(f);
    }
    return out;
  };

  /**
   * Words a polish may legitimately bring in while splitting a sentence.
   *
   * Breaking one sentence into two often needs a connective that was not there,
   * and flagging "Then" as an invented fact would make the guard cry wolf on the
   * commonest legitimate edit it exists to allow.
   */
  const CONNECTIVES = new Set(
    (
      'and but so then now yet still also because while when where after before ' +
      'once since though although however meanwhile instead the this that these ' +
      'those there here they them their it its he she his her him one two both ' +
      'each every all what which who'
    ).split(' ')
  );

  const beforeNumbers = numbers(before);
  const beforeWords = allWords(before);

  const capitalised = (text: string): string[] => {
    const out: string[] = [];
    for (const raw of text.replace(/\[[^\]]{0,40}\]/g, ' ').split(/\s+/)) {
      const word = raw.replace(/[^A-Za-z'’-]/g, '');
      if (word.length >= 3 && /^[A-Z]/.test(word)) out.push(word.toLowerCase());
    }
    return out;
  };

  // A word counts as known if ANY of its forms is known, or the stems added on the
  // draft side above would never be consulted.
  const known = (w: string): boolean =>
    forms(w).some((f) => beforeWords.has(f) || CONNECTIVES.has(f));

  const added = [
    ...[...numbers(after)].filter((n) => !beforeNumbers.has(n)),
    ...new Set(
      capitalised(after).filter((w) => !known(w))
    ),
  ];

  return { added };
};

/** How much shorter than the draft a performed script may be before it has cut content. */
export const MAX_SHRINK = 0.75;

/**
 * How far over the card's sentence target a beat may sit before this pass counts
 * it as needing work.
 *
 * 1.15, which is tighter than the writer's own rewrite threshold of 1.45 on
 * purpose. The writer is being asked to produce an episode and should not spend
 * its revisions chasing a decimal; this pass has one job and sentence length is
 * most of it, so it is held to a closer mark.
 */
export const OVER_TARGET = 1.15;

/**
 * How many times the pass may be asked.
 *
 * TWO, and the second one exists because the first version of this stage had no
 * idea whether it had worked. It returned whatever came back, and on a real
 * episode what came back was seven words shorter out of 1,899 with every beat
 * still averaging around twenty words a sentence. One retry, carrying the fact
 * that nothing changed, is the mechanism that has worked everywhere else in this
 * pipeline where instruction alone did not.
 */
export const MAX_PERFORM_ATTEMPTS = 2;

/** How many beats sit well over the card's sentence target. */
export const beatsOverTarget = (script: Script, persona: Persona): number => {
  const target = persona.styleCard.sentenceWordsMean * OVER_TARGET;

  return script.beats.filter((b) => {
    const text = withoutTags(beatText(b));
    const sentences = text.split(/(?<=[.!?])\s+/).filter((x) => x.trim());
    if (!sentences.length) return false;
    return text.split(/\s+/).filter(Boolean).length / sentences.length > target;
  }).length;
};

export interface PerformResult {
  script: Script;
  /** False when the draft was kept, with the reason. */
  applied: boolean;
  reason?: string;
}

/**
 * Polish the whole script for delivery, or keep the draft and say why.
 *
 * FAILS CLOSED. Every way this can go wrong - a bad parse, a missing beat, an
 * added fact, a script that lost a quarter of itself - keeps the draft. A script
 * that was checked is worth more than one that reads slightly better and was not,
 * and this stage is a polish: it is never worth an episode.
 */
export const performScript = async (
  input: { script: Script; persona: Persona; format: EpisodeFormat; plan?: StoryPlan },
  writer: LlmClient,
  onCost?: (pence: number) => void
): Promise<PerformResult> => {
  const draft = input.script;
  const before = draft.beats.map((b) => beatText(b)).join('\n\n');
  const overBefore = beatsOverTarget(draft, input.persona);
  let lastReason = 'no attempt was made';

  for (let attempt = 0; attempt < MAX_PERFORM_ATTEMPTS; attempt++) {
    let reply: z.infer<typeof performReplySchema>;
    try {
      reply = performReplySchema.parse(
        await completeJson<unknown>(
          writer,
          {
            system: performanceSystem(input.persona),
            prompt: [
              attempt === 0
                ? ''
                : `YOUR LAST PASS CHANGED ALMOST NOTHING. The beats listed below are ` +
                  `still averaging far more words a sentence than this show reads at. ` +
                  `Splitting them is the job rather than an optional improvement: go ` +
                  `through the long sentences one at a time and break each into two or ` +
                  `three. The facts stay identical.`,
              input.plan ? `THE STORY, IN ORDER: ${input.plan.spine}` : '',
              // THE MEASURED DEFICIT, NOT JUST THE RULES, and this is the whole
              // difference between the first version of this pass and one that
              // works. Told only how to write for the ear, it cut seven words from
              // 1,899 and left every beat averaging around twenty words a sentence
              // against a target of thirteen. Handed the actual numbers per beat, it
              // has something to aim at.
              //
              // Every stage in this pipeline has taught the same lesson: an
              // instruction is a hope, a measurement is a target.
              measuredBrief(draft, input.persona),
              'THE SCRIPT, beat by beat. Return every one of these, same ids, same order:',
              draft.beats
                .map((b) => `--- ${b.beatId} (${b.beatType}) ---\n${beatText(b)}`)
                .join('\n\n'),
            ]
              .filter(Boolean)
              .join('\n\n'),
            // Cool. This is a repair, not a draft, and a hot pass rewrites things
            // that were already working - the same reason the revision loop drops
            // its temperature.
            temperature: 0.3,
            effort: 'low',
            // Generous, because the ceiling is not a budget: nothing is charged for
            // room that goes unused, and a tight ceiling buys a truncation and a
            // retry, which is what actually costs money. Learned the expensive way
            // on the grounding review.
            maxTokens: Math.max(8000, before.length),
          },
          onCost,
          { parse: (v) => performReplySchema.parse(v), label: 'the performance pass' }
        )
      );
    } catch (err) {
      return { script: draft, applied: false, reason: (err as Error).message.slice(0, 200) };
    }

    // Same beats, same order, or this is not the same episode.
    const ids = reply.beats.map((b) => b.beatId);
    const expected = draft.beats.map((b) => b.beatId);
    if (ids.length !== expected.length || ids.some((id, i) => id !== expected[i])) {
      return { script: draft, applied: false, reason: 'came back with different beats' };
    }

    // WHO IS SPEAKING BELONGS TO THE DRAFT, NOT TO THIS PASS.
    //
    // It used to be taken from the reply verbatim, and the prompt never said
    // what the valid ids were. A solo myth episode came back with every turn
    // labelled "host" against a persona whose one host is "narrator", and the
    // run died at the render with `no voice for speaker "host"` - after the
    // research, the script and the performance pass had all been paid for.
    // Nothing before the render looks at a speaker id, so it failed at the one
    // stage that costs real money and the last one that could catch it.
    //
    // The pass may not add a beat, move text between beats, change a claim id
    // or add a fact. Who says a line is exactly the same kind of thing, and it
    // is now enforced the same way rather than requested in the prompt.
    const known = new Set(input.persona.hosts.map((h) => h.id));
    const solo = input.persona.hosts.length === 1;
    const unknown = new Set<string>();

    const speakerFor = (given: string, original: Turn | undefined): string => {
      const said = given.trim();
      if (known.has(said)) return said;
      unknown.add(said);
      // A SOLO SHOW HAS ONE ANSWER AND IT CANNOT BE WRONG. Rejecting a good
      // performance over a label nothing can disagree about would throw away a
      // paid call to be strict about nothing.
      if (solo) return input.persona.hosts[0]!.id;
      // A DIALOGUE SHOW HAS NO SAFE GUESS. Putting one host's line in the
      // other's voice is worse than not performing the script at all, so fall
      // back to whoever the draft had there and let the check below refuse it.
      return original?.speaker ?? input.persona.hosts[0]!.id;
    };

    const beats: ScriptBeat[] = draft.beats.map((original, i) => ({
      // The claim ids and the revision count belong to the draft. This pass does
      // not touch provenance.
      ...original,
      turns: reply.beats[i]!.turns.map((t, j) => ({
        speaker: speakerFor(t.speaker, original.turns[j]),
        text: stripUnknownTags(t.text).replace(/\s+/g, ' ').trim(),
      })) as Turn[],
    }));

    if (unknown.size && !solo) {
      return {
        script: draft,
        applied: false,
        reason:
          `relabelled the speaker as ${[...unknown].map((s) => `"${s}"`).join(', ')}, and this ` +
          `show has ${input.persona.hosts.length} hosts, so there is no safe way to work out who ` +
          `was meant. Kept the draft.`,
      };
    }

    const after = beats.map((b) => beatText(b)).join('\n\n');

    // NO RETRY ON AN ADDED FACT. Everything else here is a pass that did its job
    // badly; this is a pass that did something it was forbidden to do, and asking
    // it again invites a second attempt at inventing.
    const { added } = checkNoNewFacts(withoutTags(before), withoutTags(after));
    if (added.length) {
      return {
        script: draft,
        applied: false,
        reason: `added ${added.length} fact(s) not in the draft: ${added.slice(0, 6).join(', ')}`,
      };
    }

    const shrink = after.split(/\s+/).length / Math.max(1, before.split(/\s+/).length);
    if (shrink < MAX_SHRINK) {
      return {
        script: draft,
        applied: false,
        reason: `cut the script to ${Math.round(shrink * 100)}% of its length, which is content rather than polish`,
      };
    }

    const candidate = scriptSchema.parse({ ...draft, beats });

    // DID IT ACTUALLY DO THE JOB. The first version of this stage returned whatever
    // came back, and what came back on a real episode was seven words shorter with
    // every beat still at twenty words a sentence. A pass that reports success
    // without changing the thing it was sent to change is the same silent failure
    // as a gate that prints "passed" without checking anything.
    const overAfter = beatsOverTarget(candidate, input.persona);
    if (overBefore > 0 && overAfter >= overBefore && attempt + 1 < MAX_PERFORM_ATTEMPTS) {
      lastReason =
        `left ${overAfter} of ${draft.beats.length} beats over the sentence-length target`;
      continue;
    }

    return { script: candidate, applied: true };
  }

  return { script: draft, applied: false, reason: lastReason };
};
