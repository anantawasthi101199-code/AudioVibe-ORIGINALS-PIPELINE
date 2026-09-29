/**
 * Telling a case: the writer for the true crime lane.
 *
 * WHAT THIS IS WRITTEN AGAINST. Three faults, each of which has a rule below.
 *
 * ONE: A CHRONOLOGY IS NOT A STORY. A script that says "on the fourteenth, this.
 * On the nineteenth, that" is a police summary read aloud, and a listener stops
 * following it within two minutes. The chronology decides what is TRUE and the
 * writer decides what is TOLD FIRST, and those are different jobs. The order is
 * hook, then the person, then the calendar, because a listener will not care
 * when something happened until they care who it happened to.
 *
 * TWO: NOBODY CAN SEE ANYTHING. This is heard, walking somewhere, with nothing
 * on screen. A case becomes picturable through physical specifics the reporting
 * actually recorded - a time of day, a weather, a distance, what somebody was
 * carrying - and it stays abstract through adjectives. "A quiet street" is not
 * a picture. "A street where the only thing open after six was the petrol
 * station" is.
 *
 * THREE, AND THE ONE WITH CONSEQUENCES: THESE ARE REAL PEOPLE. The case file
 * marks every event as established, alleged or disputed, and this writer is
 * shown all of it - which reverses the myth lane, where the disagreements are
 * hidden precisely so the writer stops hedging. Here the hedge is the point in
 * the one place it belongs and forbidden everywhere else.
 *
 * AND THE THING THAT IS NOT A RULE BUT DECIDES THE SHOW. It is the victim's
 * story. A listener should finish knowing who they were, not a list of what was
 * done to them. That is a choice about what gets the words, and no check can
 * enforce it.
 */
import { Persona } from '../canon/schema';
import { EpisodeFormat } from '../formats/schema';
import { completeJson, LlmClient } from '../models/client';
import { CaseFile, renderCaseFile } from '../evidence/casefile';
import { Turn } from './dialogue';
import { findHedging, signoffFor } from './storyScript';
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
 * How much of the article a short is shown.
 *
 * TWENTY-FIVE THOUSAND, AND IT IS A BUDGET DECISION RATHER THAN A CRAFT ONE. A
 * short is one call against ten pence and the input is most of what it spends:
 * the first run read 45,000 characters and the script stage came to 7.3p on its
 * own. Three minutes of audio is around 450 words, so the limit is nowhere near
 * what the writing can use.
 *
 * The episode reads 120,000 instead, because there the whole point is that the
 * document is read whole.
 */
export const SHORT_CASE_CHARS = 25_000;

/**
 * The craft rules, which are the same for an episode and for a short.
 *
 * Written once because the difference between the two is length and nothing
 * else. A short is not a looser episode; it is the same discipline with fewer
 * events in it.
 */
export const CASE_INSTRUCTION = `You are telling a true story about real people to one person who cannot see anything.

They are walking, or driving, or washing up. They cannot rewind easily and they will stop if they lose the thread. They will not tell you when they do.

HOW TO OPEN. In the middle of something true. A fact, at a moment, with a person in it. Not a summary of what the episode will cover, not a question to the audience, and never a sentence about crime in general. The case file gives you the detail to open on: use it, and use it in the first two sentences.

THE ORDER THINGS ARE TOLD IN, WHICH IS NOT THE ORDER THEY HAPPENED.
1. The hook. One moment, mid-scene.
2. Who this is about, BEFORE anything happens to them. What they did, what they were like, what that week looked like. A listener cannot be made to care about a name.
3. Then the calendar, in order, and now the dates land because there is somebody standing in them.
4. What was done about it, as a second sequence. Keep it separate from the first or the listener loses track of what was known when.
5. How it ended, plainly, and what was never settled.

MAKING IT PICTURABLE. Every scene needs a time, a place, and ONE physical thing. Take them from the case file and nowhere else - if the file does not record what the weather was, there was no weather.
- "The August heat had made the asphalt soft" is a picture.
- "It was a difficult summer" is an adjective with nothing behind it.
Never invent a detail to make a scene work. If there is nothing recorded, say what is recorded and move on. A thin scene is a small cost; an invented one is a false statement about a real event.

DATES. Say them the way a person says them. "The fourteenth of March" and not "March 14th, 1987" every time. Once the year is established, stop repeating it. Say how long things took in a way anybody can feel: "eleven days later", "by the end of that week", "it would be nineteen years before anybody looked at it again."

NAMES. Name, then one line on who they are, then back to the story. Never buried in a comma. The people marked to carry get used repeatedly and reminded; everybody else is said once where they act, or replaced by what they did.

WHAT IS ESTABLISHED AND WHAT IS NOT. The file marks each one.
- Established: state it.
- Alleged or disputed: attribute it, once, where it belongs. "He told police that..." and not "he had...". Say it once and then stop hedging - an episode that qualifies every sentence is unreadable and is not more careful, it is less clear.
- Unknown: say so out loud where it matters. "Nobody ever established where he was that afternoon" is more trustworthy AND more interesting than sliding past it.
Never supply a motive the record does not give. Never say what somebody was thinking or feeling unless they said so themselves.

WHOSE STORY THIS IS. The victim's. They get the background, the detail and the words. The person who did it gets what the record supports and nothing else: no nickname the reporting did not use, no theory about their childhood, nothing that sounds like admiration or like a character study. Do not describe violence in detail - say what happened and let the listener not be shown it.

TONE. Interested, not excited. This is somebody's worst year. The difference between telling this well and telling it badly is almost entirely the difference between those two words.`;

/** What the writer returns. Same shape as the myth lane's, for the same reason. */
export const returnShape = (parts: Array<{ id: string; words: number }>): string =>
  `Return ONLY this JSON object.

{
  "beats": [
${parts.map((p) => `    {"id": "${p.id}", "text": "about ${p.words} words"}`).join(',\n')}
  ]
}

Plain spoken prose. No headings, no stage directions, no speaker labels.`;

export interface CaseScriptInput {
  persona: Persona;
  format: EpisodeFormat;
  file: CaseFile;
  topic: string;
  isoDate: string;
}

/**
 * A whole episode in one call.
 *
 * ONE CALL, NOT ONE PER BEAT, and it is the same decision the myth lane made
 * for the same reason: parts written separately read as separate essays,
 * because each one was. The owner heard that and named it exactly - "every time
 * a new parah is started it is not a continuation of the previous parah". A
 * case is worse for it than a myth, because a listener following a calendar
 * across a seam has to rebuild where they were.
 */
export const writeCaseScript = async (
  input: CaseScriptInput,
  writer: LlmClient,
  onCost?: (pence: number) => void,
  onProgress?: (message: string) => void
): Promise<Script> => {
  const { persona, format, file } = input;
  const parts = format.beats.map((b) => {
    const { min, max } = wordsForBeat(b);
    return { id: b.id, words: Math.round((min + max) / 2) };
  });

  const system = `${buildSystem(persona, input.isoDate, 'long')}

${CASE_INSTRUCTION}`;

  const sign = signoffFor(persona, 'long', input.topic);

  const prompt = `${renderCaseFile(file)}

WRITE THE EPISODE. ${parts.length} parts, in one piece, each continuing the last.

${format.beats
  .map((b, i) => {
    const words = parts[i]!.words;
    return `PART ${i + 1} (${b.id}), about ${words} words\n  ${b.function.trim().replace(/\s+/g, ' ')}${
      b.constraints?.length
        ? `\n${b.constraints.map((c: string) => `  - ${c}`).join('\n')}`
        : ''
    }`;
  })
  .join('\n\n')}

THE JOINS MATTER AS MUCH AS THE PARTS. Part two picks up from the last thing part one said, by name. Part three picks up from the last event of part two. Nobody starts again.

${sign ? `END ON THIS, in your own words rather than verbatim: ${sign}` : ''}

${returnShape(parts)}`;

  onProgress?.(`writing ${parts.length} parts in one call`);

  const reply = await completeJson<{ beats?: Array<{ id?: string; text?: string }> }>(
    writer,
    {
      system,
      prompt,
      // An episode is two thousand words plus the thinking behind ordering a
      // calendar into a told story, which is the expensive part of this call.
      maxTokens: 20_000,
      effort: 'medium',
      cacheSystem: true,
      // Lower than the myth lane's 0.9. This is somebody's real life and the
      // writing should not be reaching for surprise.
      temperature: 0.7,
    },
    onCost
  );

  const drafted = reply.beats ?? [];

  const speaker = persona.hosts[0]!.id;
  let soFar = '';

  const beats: ScriptBeat[] = format.beats.map((beat, i) => {
    const found = drafted.find((d) => d.id === beat.id) ?? drafted[i];
    const text = (found?.text ?? '').trim();
    const turns: Turn[] = [{ speaker, text }];

    // THE FREE CHECKS STILL RUN, and they run against everything written
    // before this part, which is how repetition across parts is caught at all.
    // "No paid checks" never meant "no checks".
    const { blocking } = critiqueBeat(turns, persona, beat, undefined, soFar);
    soFar = `${soFar}
${text}`;

    return {
      beatId: beat.id,
      beatType: beat.type,
      turns,
      // EMPTY, AND IT MEANS SOMETHING. There is no claim ledger on this lane,
      // so a claim id would be a fiction. The gate is told which lane made the
      // script and does not read these.
      claimIds: [],
      revisions: 0,
      notes: [...blocking, ...findHedging([{ beatId: beat.id, turns }]).map((h) => `hedging: ${h}`)],
    };
  });

  const missing = beats.filter((b) => !beatText(b).trim());
  if (missing.length) {
    throw new Error(`the writer returned nothing for: ${missing.map((b) => b.beatId).join(', ')}`);
  }

  const { title, description } = await writeTitle(
    persona,
    `${file.caseName}. ${file.oneLine}`,
    beats,
    writer,
    onCost
  );

  return {
    personaId: persona.id,
    formatId: format.id,
    title,
    description,
    beats,
    writerModel: writer.model,
  };
};

export interface CaseShortInput {
  persona: Persona;
  format: EpisodeFormat;
  article: { title: string; url: string; text: string };
  topic: string;
  isoDate: string;
}

/**
 * A whole case in three minutes, from the article, in one call.
 *
 * NO CASE FILE, AND THAT IS THE WHOLE COST DIFFERENCE. Building one is thirty
 * pence against a short's entire budget of ten, and with one document and three
 * minutes there is not enough case to be worth structuring first. The article
 * goes straight to the writer.
 *
 * WHAT IT GIVES UP is real and worth naming: nothing has separated established
 * from alleged before the writer sees it, so the instruction has to do that
 * work at the same time as writing. A short is therefore the wrong format for a
 * contested case, and the persona's topic queue is where that gets decided.
 */
export const writeCaseShort = async (
  input: CaseShortInput,
  writer: LlmClient,
  onCost?: (pence: number) => void,
  onProgress?: (message: string) => void
): Promise<Script> => {
  const { persona, format, article } = input;
  const parts = format.beats.map((b) => {
    const { min, max } = wordsForBeat(b);
    return { id: b.id, words: Math.round((min + max) / 2) };
  });
  const sign = signoffFor(persona, 'short', input.topic);

  const system = `${buildSystem(persona, input.isoDate, 'short')}

${CASE_INSTRUCTION}

THIS IS A SHORT. Three minutes, and it must be a COMPLETE story: a listener who hears only this knows who it happened to, what happened, and how it ended. That means fewer events, not a summary of many. Two or three names at most. One place. Pick the spine of the case and leave the rest out rather than mentioning everything briefly.`;

  const prompt = `THE CASE: ${input.topic}

THE ARTICLE
${article.title}
${article.url}

${article.text.slice(0, SHORT_CASE_CHARS)}

WRITE IT. ${parts.length} parts, in one piece.

${format.beats
  .map((b, i) => `PART ${i + 1} (${b.id}), about ${parts[i]!.words} words\n  ${b.function.trim().replace(/\s+/g, ' ')}`)
  .join('\n\n')}

${sign ? `END ON THIS, in your own words: ${sign}` : ''}

${returnShape(parts)}`;

  onProgress?.('writing the short in one call');

  const reply = await completeJson<{ beats?: Array<{ id?: string; text?: string }> }>(
    writer,
    {
      system,
      prompt,
      // A short script is a few hundred words. The ceiling is for the thinking.
      maxTokens: 6_000,
      // LOW, AND IT IS A COST DECISION. Thinking bills at output rates, so on a
      // ten pence budget a model reasoning at length about a three minute
      // script is the easiest way there is to double the bill.
      effort: 'low',
      cacheSystem: true,
      temperature: 0.7,
    },
    onCost
  );

  const drafted = reply.beats ?? [];

  const speaker = persona.hosts[0]!.id;
  let soFar = '';

  const beats: ScriptBeat[] = format.beats.map((beat, i) => {
    const found = drafted.find((d) => d.id === beat.id) ?? drafted[i];
    const text = (found?.text ?? '').trim();
    const turns: Turn[] = [{ speaker, text }];

    const { blocking } = critiqueBeat(turns, persona, beat, undefined, soFar);
    soFar = `${soFar}
${text}`;

    return {
      beatId: beat.id,
      beatType: beat.type,
      turns,
      claimIds: [],
      revisions: 0,
      notes: [...blocking, ...findHedging([{ beatId: beat.id, turns }]).map((h) => `hedging: ${h}`)],
    };
  });

  if (beats.some((b) => !beatText(b).trim())) {
    throw new Error('the writer returned an empty part');
  }

  const { title, description } = await writeTitle(persona, input.topic, beats, writer, onCost);

  return {
    personaId: persona.id,
    formatId: format.id,
    title,
    description,
    beats,
    writerModel: writer.model,
  };
};
