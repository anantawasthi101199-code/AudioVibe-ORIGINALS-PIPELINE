/**
 * Every prompt this studio sends a model, in one place.
 *
 * WHY A REGISTRY AND NOT A DOCUMENT. Prompts are the most-edited text in the
 * repo - most of what has gone wrong with an episode so far was fixed by
 * changing one, and three of them changed in a single afternoon. Any written
 * copy of them is wrong within a week, and a wrong copy is worse than none,
 * because somebody reasons about the version in the document rather than the
 * version being sent.
 *
 * So this file holds no prompt text at all. It imports the live constants and
 * renders them, which means it cannot drift: a prompt that changes shows up
 * changed here, and a prompt that is added and not registered shows up as a gap
 * in the count that registry.test.ts fails on.
 *
 * COMPOSED PROMPTS ARE RENDERED, NOT LISTED. The writer's system prompt is the
 * one that matters most and the one least visible in source: it is assembled at
 * runtime from the persona, the show's canon, the ear rules, the forward rules,
 * the narration or dialogue guidance, the delivery tags and the banned phrase
 * list. Reading those eight constants separately tells you almost nothing about
 * what the model receives. So the writer entries below call the real builders
 * with a real persona and show the assembled result.
 */
import { Persona } from '../canon/schema';
import { EpisodeFormat } from '../formats/schema';
import { BRIEF_SYSTEM, SOURCE_BRIEF_SYSTEM, COUNTER_SYSTEM, EXTRACT_SYSTEM } from '../evidence/research';
import { SYSTEM as VERIFY_SYSTEM } from '../evidence/verify';
import { NARROW_SYSTEM } from '../evidence/repair';
import { GAP_SYSTEM } from '../evidence/gaps';
import { SYSTEM as COMPARE_SYSTEM } from '../qa/compare';
import { CHECK_SYSTEM, EXTRACT_SYSTEM as FICTION_EXTRACT_SYSTEM } from '../fiction/continuity';
import { CHOOSE_SYSTEM, GENERATE_SYSTEM } from '../script/hooks';
import { ONE_PASS_INSTRUCTION, REVISE_SCRIPT } from '../script/onePass';
import { EPISODE_SUGGEST_SYSTEM, SET_SUGGEST_SYSTEM } from '../server/suggest';
import { PLAN_SYSTEM } from '../script/plan';
import { SELECT_SYSTEM } from '../script/shorts';
import { REVISE_INSTRUCTION, TITLE_SYSTEM, buildPrompt, buildSystem } from '../script/write';

export interface PromptEntry {
  /** Stable id, usable as a filter on the command line. */
  id: string;
  /** Which stage of a run sends it. */
  stage: string;
  /** Where it lives, so a reader can go and change it. */
  source: string;
  /** What it is for, and anything a reader needs to know before reading it. */
  note: string;
  /** The text, rendered as it is sent. */
  text: string;
}

/**
 * The prompts, in the order a run sends them.
 *
 * Rendering the writer entries needs a real persona and format, because
 * buildSystem reads the show's canon, hosts and style card. Passed in rather
 * than loaded here so this module stays free of the filesystem and the command
 * decides which show to render.
 */
export const promptRegistry = (input: {
  persona: Persona;
  format: EpisodeFormat;
  isoDate: string;
}): PromptEntry[] => {
  const { persona, format, isoDate } = input;

  return [
    {
      id: 'brief',
      stage: 'brief',
      source: 'src/evidence/research.ts',
      note: 'Turns a topic into an angle and a list of questions to go and find sources for.',
      text: BRIEF_SYSTEM,
    },
    {
      id: 'source-brief',
      stage: 'brief',
      source: 'src/evidence/research.ts (SOURCE_BRIEF_SYSTEM)',
      note:
        'Used INSTEAD of the brief above for a sourceOnly format. Every other format ' +
        'narrows a topic to one angle; an anthology has to widen it into ten separate ' +
        'stories, so the two briefs want opposite things and cannot be one prompt.',
      text: SOURCE_BRIEF_SYSTEM,
    },
    {
      id: 'extract',
      stage: 'claims',
      source: 'src/evidence/research.ts',
      note:
        'The most load-bearing prompt in the repo. Every fact an episode may state comes ' +
        'from here, bound to a verbatim quote span. The corpus is sent as a CACHED system ' +
        'prefix and beats are chunked three at a time, so this text is prepended to a large ' +
        'body of source documents not shown here.',
      text: EXTRACT_SYSTEM,
    },
    {
      id: 'counter',
      stage: 'claims',
      source: 'src/evidence/research.ts',
      note: 'Looks for evidence against what has been extracted, rather than more of it.',
      text: COUNTER_SYSTEM,
    },
    {
      id: 'verify',
      stage: 'verification',
      source: 'src/evidence/verify.ts',
      note:
        'Run by a DIFFERENT model family from the one that extracted, so a shared blind ' +
        'spot cannot pass itself. The cheap screener may only CONFIRM a clean entailment; ' +
        'anything else escalates to the full verifier on this same prompt.',
      text: VERIFY_SYSTEM,
    },
    {
      id: 'narrow',
      stage: 'repair',
      source: 'src/evidence/repair.ts',
      note:
        'Runs only on claims that FAILED. Rewrites a claim to say exactly what its quote ' +
        'establishes, so the over-reach is lost instead of the fact. What it cannot save is ' +
        'rebound to another source, and what that cannot save survives as unsettled with a ' +
        'hedge the script must say out loud.',
      text: NARROW_SYSTEM,
    },
    {
      id: 'gap',
      stage: 'repair',
      source: 'src/evidence/gaps.ts',
      note:
        'Runs after repair, over the corpus already on disk - no search, no fetch. Given a name ' +
        'the claims use and never introduce, plus the passages that mention it, it writes one ' +
        'claim saying who or what that name is. Answers to the same quote check and the same ' +
        'verifier as every other claim.',
      text: GAP_SYSTEM,
    },
    {
      id: 'plan',
      stage: 'script',
      source: 'src/script/plan.ts',
      note:
        'One call before any beat is written. Holds the chronology and owns the cast ' +
        'roster, because a beat written on its own cannot know who has been introduced.',
      text: PLAN_SYSTEM,
    },
    {
      id: 'hook-generate',
      stage: 'script',
      source: 'src/script/hooks.ts',
      note: 'Writes candidate opening lines. The writer never sees these, so it cannot talk itself out of a strong one.',
      text: GENERATE_SYSTEM,
    },
    {
      id: 'hook-choose',
      stage: 'script',
      source: 'src/script/hooks.ts',
      note: 'Picks between the candidates.',
      text: CHOOSE_SYSTEM,
    },
    {
      id: 'writer-system',
      stage: 'script',
      source: 'src/script/write.ts (buildSystem)',
      note:
        `ASSEMBLED AT RUNTIME, rendered here for "${persona.name}" as of ${isoDate}. ` +
        'Composed from the persona, the canon entries in date, the ear rules, the forward ' +
        'rules, the narration or dialogue guidance, the delivery tags and the banned ' +
        'phrases. Sent once per episode and cached, then reused for every beat and every ' +
        'revision.',
      text: buildSystem(persona, isoDate, format.kind),
    },
    {
      id: 'writer-beat',
      stage: 'script',
      source: 'src/script/write.ts (buildPrompt)',
      note:
        'The per-beat prompt, rendered here for the first beat of the format with ' +
        'placeholder claims. On a real run the CLAIMS block holds the verified facts ' +
        'routed to this beat, and THE EPISODE SO FAR holds every word written before it.',
      text: buildPrompt({
        persona,
        format,
        beat: format.beats[0]!,
        claims: [],
        angle: '(the episode angle goes here)',
        isoDate,
        plan: '(the rendered story plan and cast roster go here)',
        storySoFar: '(every word of the episode written so far goes here)',
      }),
    },
    {
      id: 'writer-revise',
      stage: 'script',
      source: 'src/script/write.ts',
      note:
        'Appended to the beat prompt when a draft fails its deterministic checks, ' +
        'together with the draft itself and the exact failures. Up to two attempts.',
      text: REVISE_INSTRUCTION,
    },
    {
      id: 'writer-one-pass',
      stage: 'script',
      source: 'src/script/onePass.ts (ONE_PASS_INSTRUCTION)',
      note:
        'Used INSTEAD of the per-beat prompt when a run is made with --one-pass. The ' +
        'whole beat sheet and every fact follow it in one prompt, so the writer can see ' +
        'the closing beat while writing the opening. The system prompt above is ' +
        'unchanged either way.',
      text: ONE_PASS_INSTRUCTION,
    },
    {
      id: 'writer-one-pass-revise',
      stage: 'script',
      source: 'src/script/onePass.ts',
      note:
        'Appended when a one-pass draft fails, with the draft and the failures named ' +
        'per beat. One attempt, against two per beat on the other method.',
      text: REVISE_SCRIPT,
    },
    {
      id: 'title',
      stage: 'script',
      source: 'src/script/write.ts',
      note: 'Title and description, written after the script so it can see what the episode actually became.',
      text: TITLE_SYSTEM,
    },
    {
      id: 'suggest-episode',
      stage: 'brief',
      source: 'src/server/suggest.ts (EPISODE_SUGGEST_SYSTEM)',
      note:
        'The studio only. Proposes subjects for one episode, and is told what the ' +
        'channel already has queued and already made - which is the difference between ' +
        'a usable list and ten near-misses. It suggests; it never writes to a queue.',
      text: EPISODE_SUGGEST_SYSTEM,
    },
    {
      id: 'suggest-set',
      stage: 'brief',
      source: 'src/server/suggest.ts (SET_SUGGEST_SYSTEM)',
      note:
        'The same, for a set of shorts, and the test is almost the opposite: a body of ' +
        'material with ten genuinely different stories in it, rather than one subject.',
      text: SET_SUGGEST_SYSTEM,
    },
    {
      id: 'short-select',
      stage: 'short',
      source: 'src/script/shorts.ts',
      note: 'Short-form lane only. Picks which moment of a story is worth a short.',
      text: SELECT_SYSTEM,
    },
    {
      id: 'fiction-extract',
      stage: 'fiction',
      source: 'src/fiction/continuity.ts',
      note: 'Fiction lane only. Pulls continuity facts out of a finished episode into the series bible.',
      text: FICTION_EXTRACT_SYSTEM,
    },
    {
      id: 'fiction-check',
      stage: 'fiction',
      source: 'src/fiction/continuity.ts',
      note: 'Fiction lane only. Checks a new episode against the bible for contradictions.',
      text: CHECK_SYSTEM,
    },
    {
      id: 'compare',
      stage: 'compare (not part of a run)',
      source: 'src/qa/compare.ts',
      note:
        'Pairwise judgement between two finished scripts, for answering "is this getting ' +
        'better" after a beat sheet or prompt change. Never runs during an episode.',
      text: COMPARE_SYSTEM,
    },
  ];
};

/**
 * The guidance blocks that are composed into the writer system prompt.
 *
 * Listed separately because the assembled prompt shows them flattened into one
 * wall of bullets, and when the question is "which rule causes this" the answer
 * is easier to find grouped by where the rule lives.
 */
export const COMPOSED_INTO_WRITER = [
  { name: 'EAR_RULES', source: 'src/script/write.ts' },
  { name: 'FORWARD_GUIDANCE', source: 'src/script/forward.ts' },
  { name: 'NARRATION_GUIDANCE', source: 'src/script/narration.ts (solo shows)' },
  { name: 'NARRATION_TAGS', source: 'src/script/narration.ts (solo shows)' },
  { name: 'DIALOGUE_GUIDANCE', source: 'src/script/dialogue.ts (two-host shows)' },
  { name: 'SHORT_FORM_GUIDANCE', source: 'src/script/shorts.ts (shorts only)' },
  { name: 'NETWORK_BANNED_PHRASES', source: 'src/script/style.ts' },
  { name: 'persona canon', source: 'personas/*.yaml (beliefs, taboos, stylistic rules)' },
];
