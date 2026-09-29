/**
 * Writing a script from one reference article instead of from a claim ledger.
 *
 * WHAT CHANGES, AND WHY EACH ONE CHANGED. Three faults in the Inanna episode
 * were traced to the evidence apparatus rather than to the writing, and this
 * module is the answer to all three.
 *
 * 1. THE WRITER MAY EXPLAIN THINGS AGAIN.
 *
 *    The old system prompt says "You may state a fact ONLY if it appears in the
 *    CLAIMS you are given", and the grounding review enforced it against
 *    sentences like "It comes from Sumer, in what is now southern Iraq" and
 *    "They came to Uruk, a city on the Euphrates". Both were reported as
 *    unsupported. Both are world knowledge doing the one job this show's own
 *    canon says matters most: "The world of the story has to be explained
 *    before the story, or every event in it sounds arbitrary."
 *
 *    With two revision passes per beat, a writer told that explaining is a
 *    violation learns to compress the explanation into something small enough
 *    to survive - which is how the episode ended up saying "written down in
 *    cuneiform, wedge marks pressed into wet clay" and moving on. The
 *    information is there and nobody is taught anything. Here the rule is
 *    split: EVENTS come from the reference, EXPLANATION does not have to.
 *
 * 2. NOTHING MAKES IT SAY THE SOURCES DISAGREE.
 *
 *    The old lane had three separate rules pushing scholarly hedging into the
 *    prose - the beat sheet's "WHERE THE VERSIONS DISAGREE, SAY SO PLAINLY",
 *    the writer's "a beat that uses one of these without saying what is
 *    unsettled is rejected", and a plan whose spine ended "...in an ending the
 *    surviving tablets themselves cannot agree on". One contested claim out of
 *    forty-four produced roughly two hundred words of the three-hundred-and-
 *    eighty-six-word payoff beat, plus the final line of the episode.
 *
 *    The reference has already decided. Disagreements live in its `variants`
 *    field, the writer is never shown that field, and the prompt below forbids
 *    the register outright.
 *
 * 3. THE EPISODE IS ALLOWED TO END.
 *
 *    The old `close` beat ends "No sign-off, no call to action, no naming the
 *    show, no next-time", so the last thing a listener heard was an unresolved
 *    scholarly question. A show is a thing somebody comes back to, and it needs
 *    to say goodbye. The persona now carries a `signoff` and this writer is
 *    told to land on it.
 *
 * WHAT IS KEPT. `critiqueBeat` runs unchanged with an empty claim list - every
 * check in it that matters here works without claims, and that is not luck, it
 * was written that way. Style, banned phrases, dialogue shape, cast handling,
 * repetition and length are all properties of the prose and are judged exactly
 * as they are on the other lane.
 */
import { z } from 'zod';
import { Persona } from '../canon/schema';
import { Reference } from '../evidence/story';
import { EpisodeFormat } from '../formats/schema';
import { completeJson, LlmClient } from '../models/client';
import { Turn, turnSchema } from './dialogue';
import {
  MAX_SCRIPT_REVISIONS,
  REVISE_SCRIPT,
  scriptSeconds,
} from './onePass';
import {
  Script,
  ScriptBeat,
  ScriptCheckpoint,
  beatText,
  buildSystem,
  critiqueBeat,
  wordsForBeat,
  writeTitle,
} from './write';

/**
 * The instructions that are specific to telling a story rather than assembling
 * one from facts.
 *
 * EVERY ONE OF THESE IS A REVERSAL OF SOMETHING THE OTHER LANE DOES. They are
 * written as reversals on purpose, because the failure mode is a model
 * defaulting back to the register the rest of the prompt has trained into it.
 */
export const STORY_INSTRUCTION = `You are telling this story to one person who cannot see
anything, cannot look anything up, and has never heard of any of it. Everything
below follows from that.

YOU ARE WORKING FROM A REFERENCE ARTICLE, NOT A LIST OF FACTS. It has the whole
story in order, the world it needs, the people in it, and plain explanations of
anything unfamiliar. It is complete. You do not need anything else and you must
not go looking in your own memory for more events, more names or more detail.

TEACH THE UNFAMILIAR THING, DO NOT TUCK IT INTO A COMMA. This is the most
important instruction here and it is the one most likely to be ignored.

  Not this:  "It was written down in cuneiform, wedge marks pressed into wet
              clay, and it is older than the Iliad."

  This:      "It was written down in cuneiform. Cuneiform is the oldest writing
              anybody has found. You take a reed, cut the end into a wedge, and
              press it into a tablet of wet clay, over and over, and the marks
              you leave behind are the words. Then the clay dries, and it keeps.
              That is why we still have this story and not the thousand told
              alongside it."

The second one is four sentences where the first is a clause, and the listener
comes away knowing what cuneiform is instead of having heard the word. An
explanation folded into an aside is an explanation nobody hears. When the
GLOSSARY gives you something, spend real sentences on it at the moment the story
first needs it - and then get straight back to the story.

TELL IT AS SOMETHING THAT HAPPENED, NOT AS SOMETHING SOMEBODY WROTE. "She walked
through the first gate and the gatekeeper stopped her" beats "the text describes
her passing through the first gate". You may say where the story comes from and
you should, once, near the front - after that, tell the story.

NEVER SAY THE SOURCES DISAGREE. Not "some versions say", not "scholars are
divided", not "the tablets do not agree", not "it is unclear", not "the text
does not explain why". Every one of those decisions has already been made for
you and the reference states what happened. Tell it as what happened. If you
find yourself about to hedge, the answer is in the reference - go and use it.

THE ONLY EXCEPTION is where the reference's own ENDING or a section explicitly
frames something as genuinely lost - a tablet that physically breaks off
mid-line, a manuscript that was destroyed. That is an event in the story of the
story, not a scholarly caveat, and it is worth one sentence where it bites.

EXPLAIN THE WORLD FREELY. Where a country is now, roughly when a century was,
what a river or a desert or a harvest meant to people living there, what a
title or a job actually involved - use what you know. This is not a fact about
the story and it does not have to be in the reference. What must come from the
reference is EVENTS, NAMES, NUMBERS, MOTIVES and anything anybody said.

GIVE EVERY ANSWER THE STORY HAS. If something happens that a listener would ask
"but why" about, the reference almost certainly says why, and saying why is the
difference between a sequence of events and a story. Never leave a why hanging
that you were given the answer to.

INTRODUCE A PERSON IN THREE MOVES: NAME, ONE LINE, THEN STRAIGHT BACK TO THE
STORY. This is the same fault as the comma-tucked explanation, pointed at people
instead of things, and it is just as easy to fall into.

  Not this:  "Her younger brother, a storm god named Susanoo, grieving and out
              of control, does something to her that she cannot forgive."

  Nor this: "Then there is her younger brother, Susanoo, said soo-sah-NOH-oh,
              the god of storms and the sea."

  This:      "Then there is her younger brother. His name is Susanoo, and he is
              the god of storms and the sea. He has just lost his mother, and he
              is not handling it. He does something to his sister that she will
              not forgive."

The first buries a name, a relationship, a domain and a state of mind inside one
sentence, and a listener catches maybe two of them. The second gives the name
its own breath, one line on who they are, and then moves. Say the name first or
almost first - not at the end of a clause that has already described them,
because then the listener spends the description waiting to find out who it is
about.

ONE LINE MEANS ONE LINE. The CAST gives you who each person is. Say that much
and stop. A second sentence of background on somebody who is about to do one
thing is the story stopping for a biography.

NEVER SPELL OUT A PRONUNCIATION. Not "Susanoo, said soo-sah-NOH-oh", not
"Omoikane, said oh-moh-ee-KAH-neh", not a respelling in any form. The voice
reading this ALREADY says the name; a phonetic gloss makes it say the name
twice, the second time in syllables, which is a dictionary entry read aloud and
stops the story dead. Say the name once, properly, and let the voice carry it.

So the three moves are: the name, one line on who they are, and back to the
story. Nothing else goes in between.

NOT EVERY NAME IS A NAME THE LISTENER HAS TO CARRY. The CAST marks some people
CARRY and the rest as texture. A CARRY name is introduced properly, used
repeatedly, and reminded if it has been away for several minutes. A texture name
is said once where it acts and never depended on again - and where a texture
name would be the third or fourth new one in a row, use what the person DOES
instead of what they are called. "The god of pure strength waited beside the
door" costs a listener nothing; a fourth unfamiliar name in thirty seconds
costs them the thread.

WRITE IN TURNS, AND EVERY TURN IS A PARAGRAPH THE VOICE BREATHES BETWEEN. One
turn per part is wrong - it produces a wall the voice reads without stopping.
Break where the story itself moves: a new scene, a jump in time, a change of who
we are following.`;

/**
 * How the whole thing is asked for.
 *
 * ONE CALL FOR THE WHOLE SCRIPT, for the reason the other lane found: a beat
 * written on its own restates what it cannot see, and the closing beats are
 * where that hurts most. Here it matters more, not less - a told story has to
 * know its own ending while it is writing its opening.
 */
export const STORY_ONE_PASS = `Write the WHOLE episode now, every beat, in one go, as
spoken turns.

It is one continuous thing somebody listens to from start to finish. A listener
should never hear where one beat ends and the next begins.

NOTHING IS SAID TWICE. You can see the whole script because you are writing the
whole script. Something said in one beat is spent.

THE SHAPE OF IT:

THE LISTENER HEARS THREE THINGS, NOT THREE SECTIONS. Where you are, the story,
and what it meant. They should not be able to tell you were given three briefs.

  ONE  Say what this is and give the shape, then hand over out loud.
  TWO  Tell the story, explaining each thing at the moment it is needed.
  THREE Say what it meant, leave them one thing, say goodbye.

THE TWO JOINS ARE THE HARDEST WRITING IN THE EPISODE AND THEY ARE WHERE THIS
KEEPS FAILING. A listener told us plainly what goes wrong: "every time a new
paragraph is started it is not a continuation of the previous paragraph, it has
a fresh start altogether."

That happens because each part below carries its own brief, and a writer handed
three briefs writes three openings. Do not. There is one voice, talking
continuously, for fifteen minutes.

  At the join from ONE to TWO: part one ENDS by inviting them in, out loud, in
  your own words. Part two then starts TELLING, immediately, from the beginning
  of the story. It does not re-introduce the subject, re-state what the episode
  is, or open on a fresh framing sentence.

  At the join from TWO to THREE: part three's first sentence refers to what just
  happened, by name. Not "so what does all this mean". The same person, still
  talking, turning from telling to reflecting.

THE TEST FOR EVERY TURN YOU WRITE: could this be the first thing somebody heard?
If yes, and it is not the first turn, it is written wrong. Rewrite it so it
leans on the sentence before it.

One entry per beat, in the order given, using exactly the beat ids given.`;

/**
 * The return shape, with the speaker id filled in rather than left as a gap.
 *
 * A PLACEHOLDER IS AN INVITATION TO INVENT. `{"speaker": "..."}` in the
 * performance pass produced a whole episode labelled "host" for a show whose
 * one host is "narrator", and the run died at the render. This prompt had the
 * same placeholder and happened to get away with it; it is not left to luck.
 */
export const returnShape = (persona: Persona): string =>
  `Return JSON: {"beats": [{"beatId": "...", "turns": [{"speaker": ` +
  `"${persona.hosts[0]!.id}", "text": "..."}]}]}\n\n` +
  `THE ONLY SPEAKER IDS THAT EXIST ARE ${persona.hosts.map((h) => `"${h.id}"`).join(', ')}. ` +
  `Use them exactly, and never a role name of your own.`;

/**
 * Which goodbye this episode uses.
 *
 * A LIST GETS ONE PICKED, deterministically from the subject: stable across
 * re-renders of the same episode, different between episodes. A presenter says
 * roughly the same thing a slightly different way each week, and a show that
 * recites one sentence verbatim every time sounds like a machine reading a card
 * - which is what it is, and the whole job is not sounding like it.
 *
 * A short gets `signoffShort` where the persona has one. A short is usually
 * somebody's first contact with the show and has ninety seconds to earn a
 * follow; spending the long goodbye there would eat a fifth of the episode.
 */
export const signoffFor = (
  persona: Persona,
  kind: 'long' | 'short',
  seed: string
): string | undefined => {
  const chosen = kind === 'short' ? persona.signoffShort ?? persona.signoff : persona.signoff;
  if (!chosen) return undefined;
  if (typeof chosen === 'string') return chosen;
  if (!chosen.length) return undefined;

  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return chosen[h % chosen.length];
};

/** The reference as the writer sees it. `variants` is deliberately absent. */
export const renderReference = (reference: Reference): string => {
  const block = (heading: string, body: string) => (body.trim() ? `${heading}\n${body}` : '');

  return [
    `SUBJECT: ${reference.subject}`,
    '',
    block('THE WHOLE STORY IN A PARAGRAPH:', reference.spine),
    '',
    block(
      'THE WORLD IT NEEDS, which the listener must have before events make sense:',
      reference.world.map((w) => `- ${w}`).join('\n')
    ),
    '',
    block(
      'THE PEOPLE:',
      reference.cast
        // CARRY FIRST AND LABELLED, because an undifferentiated roster is what
        // produced thirty equally-weighted names in one beat. A writer shown a
        // flat list treats a gatekeeper who appears once exactly as it treats
        // the goddess the episode is about.
        .slice()
        .sort((a, b) => Number(b.carry) - Number(a.carry))
        // THE PRONUNCIATION IS NOT SHOWN, even when an older reference still
        // carries one. A writer given a respelling puts it in the script, and
        // the engine then says the name and immediately spells it out in
        // syllables - a dictionary entry read aloud, mid-story.
        .map((c) => `- ${c.carry ? '[CARRY] ' : '[texture] '}${c.name}: ${c.who}`)
        .join('\n')
    ),
    '',
    block(
      'THINGS A LISTENER WILL NOT KNOW, and what they are. Spend real sentences on\n' +
        'these at the moment the story first needs them:',
      reference.glossary.map((g) => `- ${g.term}: ${g.plainly}`).join('\n')
    ),
    '',
    'THE STORY, in order:',
    '',
    reference.sections.map((s) => `## ${s.heading}\n${s.body}`).join('\n\n'),
    '',
    `HOW IT ENDS:\n${reference.ending}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
};

/** The beat sheet as the writer sees it. No per-beat facts: there is one story. */
const renderBeats = (format: EpisodeFormat): string =>
  format.beats
    .map((beat) => {
      const { min, max } = wordsForBeat(beat);
      return [
        `--- ${beat.id} (${beat.type}) ---`,
        `MUST: ${beat.function.trim().replace(/\s+/g, ' ')}`,
        beat.constraints.length
          ? `CONSTRAINTS:\n${beat.constraints.map((c) => `- ${c.trim().replace(/\s+/g, ' ')}`).join('\n')}`
          : '',
        `LENGTH: roughly ${min} to ${max} words. A guide, not a target.`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

export const buildStoryPrompt = (input: {
  format: EpisodeFormat;
  reference: Reference;
  persona: Persona;
}): string =>
  [
    STORY_INSTRUCTION,
    '',
    STORY_ONE_PASS,
    '',
    returnShape(input.persona),
    '',
    (() => {
      const said = signoffFor(input.persona, input.format.kind, input.reference.subject);
      return said
        ? `HOW THIS SHOW SIGNS OFF. The last part lands on this, in your own words ` +
          `rather than word for word, and it is the last thing said:\n  ${said}`
        : '';
    })(),
    '',
    'THE BEATS, in order:',
    '',
    renderBeats(input.format),
    '',
    '=========================================================',
    'THE REFERENCE ARTICLE. Everything that happens comes from here.',
    '=========================================================',
    '',
    renderReference(input.reference),
  ]
    .filter((line) => line !== '')
    .join('\n');

export const storyDraftSchema = z.object({
  beats: z
    .array(z.object({ beatId: z.string(), turns: z.array(turnSchema).min(1) }))
    .min(1),
});

/**
 * Write a whole episode from one reference article.
 *
 * Mirrors `writeScriptOnePass` - same revision loop, same critique, same title
 * call - so the two lanes can be compared on real episodes without the
 * comparison being confounded by a different revision policy. What differs is
 * what the writer is given and what it is forbidden to say, which is the thing
 * under test.
 */
export const writeStoryScript = async (
  input: {
    persona: Persona;
    format: EpisodeFormat;
    reference: Reference;
    angle: string;
    isoDate: string;
  },
  writer: LlmClient,
  onCost?: (pence: number) => void,
  /**
   * Accepted and not used, and saying so is better than pretending.
   *
   * THERE IS NOTHING TO CHECKPOINT INSIDE A SINGLE CALL. The whole script is
   * one reply: it either arrives or it does not, and a failed attempt has
   * produced no partial work to keep. `writeScriptOnePass` has exactly the
   * same property and says so too. Writing an empty progress object here
   * would leave a checkpoint file on disk that a resumed run would read in
   * preference to nothing, which is worse than having none.
   *
   * The parameter stays so both writers have the same shape and the pipeline
   * can call either without knowing which it has. What IS checkpointed on
   * this lane is the fused reference, which is the expensive artifact - see
   * pipeline/episode.ts stage 3s.
   */
  checkpoint?: ScriptCheckpoint,
  onProgress?: (message: string) => void,
  /**
   * Whether a failing draft is PAID TO BE REWRITTEN.
   *
   * THE CHECKS RUN EITHER WAY. `critiqueBeat` and `findHedging` are
   * deterministic and free, so with this false the draft is still measured and
   * every problem is still reported - the studio simply does not buy a second
   * and third attempt at fixing them.
   *
   * WHY IT DEFAULTS TO FALSE. One run paid 11.7p for a script and 87.1p
   * rewriting it, which is the single largest avoidable cost in the pipeline,
   * and the rewrites oscillated rather than converged: 24.4 words a sentence
   * against a target of 13, then an over-correction to 4.1 words of variance
   * against a minimum of 5, and six problems still outstanding at the end of
   * the budget. Paying four times over to arrive somewhere neither is not a
   * quality control, it is a bill. See config/stages.ts.
   */
  allowRevisions = false
): Promise<Script> => {
  const system = buildSystem(input.persona, input.isoDate, input.format.kind);
  const prompt = buildStoryPrompt(input);
  const speaker = input.persona.hosts[0]!.id;

  let draft: Array<{ beatId: string; turns: Turn[] }> = [];
  let revisions = 0;
  let notes: string[] = [];

  const budget = allowRevisions ? MAX_SCRIPT_REVISIONS : 0;

  for (let attempt = 0; attempt <= budget; attempt += 1) {
    const ask = attempt === 0 ? prompt : `${prompt}\n\n${REVISE_SCRIPT}\n\nWHAT FAILED:\n${notes.map((n) => `- ${n}`).join('\n')}`;

    const reply = await completeJson<unknown>(
      writer,
      {
        system,
        prompt: ask,
        // The whole episode in one reply, and a myth runs to three thousand
        // words of prose before the JSON around it.
        maxTokens: 24_000,
        cacheSystem: true,
        temperature: 0.9,
      },
      onCost
    );

    draft = storyDraftSchema.parse(reply).beats;
    revisions = attempt;

    // EVERY BEAT JUDGED, THEN ONE REWRITE FOR ALL OF THEM. Same trade the other
    // one-pass writer makes: a beat with a fixable fault is rewritten alongside
    // the ones that were fine.
    notes = [];
    let soFar = '';
    for (const beat of input.format.beats) {
      const written = draft.find((b) => b.beatId === beat.id);
      if (!written) {
        notes.push(`beat "${beat.id}" is missing from the script entirely`);
        continue;
      }
      // NO CLAIMS, DELIBERATELY. Every check in critiqueBeat that needs them is
      // guarded, and the ones that remain - dialogue shape, style, cast,
      // repetition, length, banned phrases - are exactly the ones that judge
      // prose rather than provenance.
      const { blocking } = critiqueBeat(written.turns, input.persona, beat, undefined, soFar);
      for (const problem of blocking) notes.push(`${beat.id}: ${problem}`);
      soFar += `\n${beatText(written)}`;
    }

    // The register this lane exists to prevent, checked on the prose rather
    // than trusted to the prompt. A model told three times not to hedge still
    // hedges when the material invites it.
    for (const problem of findHedging(draft)) notes.push(problem);

    if (!notes.length) break;

    // REPORTED WHETHER OR NOT ANYTHING IS BOUGHT TO FIX IT. A run with
    // revisions off has still been measured, and the findings are the whole
    // point of measuring: somebody reads them, and decides whether this beat
    // sheet, this style card or this reference is what needs changing. Paying
    // a model to paper over a bad target was never the only option.
    onProgress?.(
      budget === 0
        ? `${notes.length} problem(s), and revisions are OFF so none of them were ` +
          `fixed: ${notes.join('; ')}`
        : attempt < budget
          ? `${notes.length} problem(s), rewriting: ${notes.slice(0, 3).join('; ')}`
          : `${notes.length} problem(s) left after ${budget} rewrites: ${notes.join('; ')}`
    );
  }

  const beats: ScriptBeat[] = input.format.beats.map((beat) => {
    const written = draft.find((b) => b.beatId === beat.id);
    return {
      beatId: beat.id,
      beatType: beat.type,
      turns: written?.turns ?? [{ speaker, text: '' }],
      // EMPTY, AND IT MEANS SOMETHING. There is no ledger on this lane, so a
      // claim id would be a fiction. The gate is told which lane produced the
      // script and does not read these.
      claimIds: [],
      revisions,
    };
  });

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
    beats,
    writerModel: writer.model,
  };
};

/**
 * Scholarly hedging that reached the prose anyway.
 *
 * DETERMINISTIC AND FREE, and it is here because the prompt alone is not
 * enough. Every phrase in this list appeared in the episode that prompted this
 * rebuild, and each one is a place where the writer handed the listener a
 * disagreement the reference had already settled.
 *
 * It does not catch a hedge about the WORLD - "nobody knows how old the city
 * is" is a fact about the world and is fine. It catches hedges about the
 * RECORD, which is the register that turns a told story into a literature
 * review.
 */
export const HEDGE_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\bsome (?:versions|tellings|sources|accounts|texts|tablets)\b/i, why: 'attributes the story to competing versions' },
  // "some scholars count this as part of the same poem, others treat it as a
  // separate text" - from the first reference this lane ever produced, inside
  // a section about how the poem was pieced back together. The recovery IS
  // good material and belongs in the episode; the state of the argument about
  // it is not, and the two are easy to write in the same breath.
  { pattern: /\bsome (?:scholars|historians|translators|academics|experts)\b/i, why: 'reports the state of an argument rather than telling what happened' },
  { pattern: /\bothers (?:treat|count|regard|read|take|call|say|argue|think|believe)\b/i, why: 'sets one group of experts against another mid-story' },
  { pattern: /\b(?:scholars|historians|translators|academics)\b[^.]{0,40}\b(?:disagree|are divided|do not agree|argue over|cannot agree)\b/i, why: 'puts a scholarly argument in front of the story' },
  // "stop agreeing with each other" is in here because the episode used
  // exactly that phrasing, and a list of the obvious verbs would have walked
  // straight past it. A model avoiding a banned word reaches for a synonym,
  // not for the truth.
  { pattern: /\b(?:the )?(?:texts?|tablets?|manuscripts?|versions?|sources?|tellings?)\b[^.]{0,40}\b(?:do not agree|don't agree|stop agreeing|never agreed?|disagree|contradict|are at odds|cannot agree)\b/i, why: 'says the record disagrees with itself' },
  { pattern: /\bnobody (?:has )?(?:agrees?|settled|knows which)\b/i, why: 'leaves a settled question open' },
  { pattern: /\b(?:it is|it's) (?:unclear|not clear|uncertain|disputed|contested)\b/i, why: 'hedges something the reference decided' },
  { pattern: /\bthe (?:text|story|poem|source|record) does not (?:explain|say|tell)\b/i, why: 'declares an answer missing; the reference has it' },
  { pattern: /\ban? (?:alternative|different|separate|competing|rival) (?:version|ending|telling|account|reading)\b/i, why: 'introduces a variant the listener did not need' },
  { pattern: /\bwhat(?:'s| is) (?:left )?unsettled\b/i, why: 'ends on an open scholarly question' },
];

export const findHedging = (
  beats: Array<{ beatId: string; turns: Turn[] }>
): string[] => {
  const problems: string[] = [];
  for (const beat of beats) {
    const text = beat.turns.map((t) => t.text).join(' ');
    for (const { pattern, why } of HEDGE_PATTERNS) {
      const hit = text.match(pattern);
      if (!hit) continue;
      problems.push(
        `${beat.beatId}: "${hit[0]}" ${why}. The reference already decided this. ` +
          `Say what happened.`
      );
    }
  }
  return problems;
};

export { scriptSeconds };
