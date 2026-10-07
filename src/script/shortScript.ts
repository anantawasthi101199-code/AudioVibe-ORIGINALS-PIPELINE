/**
 * A three-minute short, written from one article in one model call.
 *
 * WHY THIS IS NOT `writeStoryScript` WITH A SMALLER BUDGET. The long lane runs
 * two large calls: a fusion that reads the documents and writes a reference
 * article, and a writer that works from that reference. The fusion is where
 * disagreements get resolved, names get tiered and the ending gets decided, and
 * on a fifteen-minute episode it earns every penny.
 *
 * A short cannot carry it. The fusion alone measured 42p, which is three times
 * the entire budget for a short - and with a single source there is nothing to
 * fuse anyway. So the article goes straight to the writer and the script comes
 * back, one call.
 *
 * WHAT THAT GIVES UP, PLAINLY. Nothing resolves conflicts or decides the ending
 * before writing starts; the writer does all of it inline. Over fifteen minutes
 * and fourteen documents that showed badly. Over three minutes and one article
 * it does not, and the alternative is not a better short, it is no short.
 *
 * THE BUDGET, WHICH IS THE DESIGN CONSTRAINT: under fifteen pence a short, on
 * the instruction "no gates, no checks, nothing". Measured against
 * claude-sonnet-5 at 240p/1200p per million tokens in and out:
 *
 *   read one 60,000-char article     3.6p
 *   write ~520 words                 0.9p
 *   thinking at low effort           2.4p
 *   pick the article                 1.4p
 *   brief                            2.0p
 *   render 2,900 chars on openai     3.4p
 *                                   -----
 *                                   13.7p
 *
 * ELEVENLABS DOES NOT FIT AND CANNOT BE MADE TO. At 20p per thousand
 * characters, voicing a three-minute short is 57p on its own - four times the
 * whole budget. Shorts render on the OpenAI voice or they do not render.
 */
import { Persona } from '../canon/schema';
import { EpisodeFormat } from '../formats/schema';
import { completeJson, LlmClient } from '../models/client';
import { Turn } from './dialogue';
import { REVISE_SCRIPT } from './onePass';
import { OUTRO_RULE } from './outro';
import { tagGuidance } from './narration';
import {
  findHedging,
  returnShape,
  signoffFor,
  storyDraftSchema,
} from './storyScript';
import {
  Script,
  ScriptBeat,
  beatText,
  buildSystem,
  critiqueBeat,
  wordsForBeat,
  writeTitle,
} from './write';

/**
 * How much of the chosen article a short is shown.
 *
 * THE WHOLE THING, UP TO A CEILING, for the reason the long lane reads its
 * documents whole: a keyhole loses whatever did not match the query wording,
 * and that is how an episode came to say "the text does not explain" over a
 * source section headed with the answer.
 *
 * Sixty thousand rather than the long lane's hundred thousand, because reading
 * is the only real cost here and it scales straight into the bill. A 100,000
 * character article is 6p of input on a 14p budget; 60,000 is 3.6p and still
 * covers the great majority of articles whole.
 */
export const SHORT_ARTICLE_CHARS = 60_000;

/**
 * The instructions for a short, which is a different job from an episode.
 *
 * WRITTEN AS A BUDGET RATHER THAN AS A STYLE. Three minutes is about five
 * hundred and twenty words, a sixth of an episode, so nearly every rule here is
 * about what to leave out - and the one rule that overrides all of them is that
 * the story has to finish.
 */
export const SHORT_INSTRUCTION = `You are telling one complete story in under three
minutes, to somebody scrolling a feed who has never heard of it and has nothing
to look at.

YOU ARE WORKING FROM ONE ARTICLE. Everything that happens comes from it. Do not
go to your own memory for more events, names or detail - but DO use what you
know about the world to place things: where a country is now, roughly when a
century was, what a job or a season or a river meant to people living there.

THE STORY MUST FINISH. This beats every other rule here. A short that runs out
of time before the ending has failed, however good the first two minutes were.
Work out where it ends before you start writing, and cut detail from the middle
rather than stopping early. Never end on "there is more to this story", and
never point at a longer version - this is the whole thing.

SAY WHAT A PERSON WOULD SEE. The listener has no picture. A stone rolled across
a cave mouth, a rope tied across it afterwards, a body hung on a hook, a bird
that does not come back. Physical actions in order beat any amount of
explanation about what the story means. A sentence that cannot be pictured is
usually costing you the ending.

YOU CAN AFFORD TO EXPLAIN ONE THING, MAYBE TWO. Only what the story genuinely
cannot be followed without. Everything else goes into ordinary words instead:
"the oldest writing anybody has found" rather than a term the listener then has
to carry. No pronunciations, ever - the voice already says the name.

THREE NAMES AT MOST. Everybody else is what they did: "her older sister, who
rules the dead", "the strongest of the gods". A fourth name in three minutes is
a name nobody keeps.

SAY WHY, IN THE SAME BREATH. Somebody does something strange and the reason
follows in the same sentence. It costs a clause, and it is the difference
between a list of events and a story.

OPEN BY SAYING WHAT THIS IS IN ONE OR TWO SENTENCES, THEN START. Whose story it
is, roughly how old, and go. No greeting, no naming the show, no "today we are
looking at". You have about three seconds. IF THE FIRST PART'S CONSTRAINTS BELOW
SET A DIFFERENT OPENING, FOLLOW THEM INSTEAD: that format's opening was chosen
on purpose.`;

/**
 * Write a short from a single article.
 *
 * Mirrors `writeStoryScript` - same critique, same title call, same
 * revisions-are-bought rule - so the two are comparable and neither is a
 * special case downstream.
 */
export const writeShortScript = async (
  input: {
    persona: Persona;
    format: EpisodeFormat;
    article: { title: string; url: string; text: string };
    topic: string;
    isoDate: string;
  },
  writer: LlmClient,
  onCost?: (pence: number) => void,
  onProgress?: (message: string) => void,
  allowRevisions = false
): Promise<Script> => {
  const system = buildSystem(input.persona, input.isoDate, 'short');
  const speaker = input.persona.hosts[0]!.id;
  const said = signoffFor(input.persona, 'short', input.topic);

  const parts = input.format.beats
    .map((beat) => {
      const { min, max } = wordsForBeat(beat);
      return [
        `--- ${beat.id} (${beat.type}) ---`,
        `MUST: ${beat.function.trim().replace(/\s+/g, ' ')}`,
        beat.constraints.length
          ? `CONSTRAINTS:\n${beat.constraints
              .map((c) => `- ${c.trim().replace(/\s+/g, ' ')}`)
              .join('\n')}`
          : '',
        `LENGTH: roughly ${min} to ${max} words. Here that is a budget, not a guide.`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  const prompt = [
    `SUBJECT: ${input.topic}`,
    '',
    SHORT_INSTRUCTION,
    '',
    said
      ? OUTRO_RULE
      : '',
    tagGuidance(input.persona),
    '',
    returnShape(input.persona),
    '',
    'THE PARTS, in order:',
    '',
    parts,
    '',
    '=========================================================',
    'THE ARTICLE. Everything that happens comes from here.',
    '=========================================================',
    '',
    `TITLE: ${input.article.title}`,
    '',
    input.article.text.slice(0, SHORT_ARTICLE_CHARS),
  ]
    .filter((line) => line !== '')
    .join('\n');

  let draft: Array<{ beatId: string; turns: Turn[] }> = [];
  let revisions = 0;
  let notes: string[] = [];
  const budget = allowRevisions ? 1 : 0;

  for (let attempt = 0; attempt <= budget; attempt += 1) {
    const ask =
      attempt === 0
        ? prompt
        : `${prompt}\n\n${REVISE_SCRIPT}\n\nWHAT FAILED:\n${notes
            .map((n) => `- ${n}`)
            .join('\n')}`;

    const reply = await completeJson<unknown>(
      writer,
      {
        system,
        prompt: ask,
        // A short script is a few hundred words. The ceiling is for the
        // thinking, not for the answer.
        maxTokens: 6_000,
        // LOW, AND IT IS A COST DECISION RATHER THAN A QUALITY ONE. Thinking
        // bills at output rates, so on a fourteen-pence budget a model
        // reasoning at length about a three-minute script is the easiest way
        // there is to double the bill.
        effort: 'low',
        cacheSystem: true,
        temperature: 0.9,
      },
      onCost
    );

    draft = storyDraftSchema.parse(reply).beats;
    revisions = attempt;

    // THE FREE CHECKS STILL RUN. They are arithmetic over text already in
    // memory, so "no checks" means nothing is PAID to fix what they find.
    notes = [];
    let soFar = '';
    for (const beat of input.format.beats) {
      const written = draft.find((b) => b.beatId === beat.id);
      if (!written) {
        notes.push(`part "${beat.id}" is missing from the script entirely`);
        continue;
      }
      const { blocking } = critiqueBeat(written.turns, input.persona, beat, undefined, soFar);
      for (const problem of blocking) notes.push(`${beat.id}: ${problem}`);
      soFar += `\n${beatText(written)}`;
    }
    for (const problem of findHedging(draft)) notes.push(problem);

    if (!notes.length) break;
    onProgress?.(
      budget === 0
        ? `${notes.length} problem(s), and revisions are OFF so none were fixed: ${notes.join('; ')}`
        : `${notes.length} problem(s), rewriting: ${notes.slice(0, 3).join('; ')}`
    );
  }

  const beats: ScriptBeat[] = input.format.beats.map((beat) => {
    const written = draft.find((b) => b.beatId === beat.id);
    return {
      beatId: beat.id,
      beatType: beat.type,
      turns: written?.turns ?? [{ speaker, text: '' }],
      claimIds: [],
      revisions,
    };
  });

  const { title, description } = await writeTitle(
    input.persona,
    input.topic,
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
