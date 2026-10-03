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
import { findHedging } from './storyScript';
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

TELL IT THE WAY YOU WOULD TELL A FRIEND. Not the way a documentary narrates and not the way a report is written. Ordinary words, contractions, the occasional aside. Somebody who finds this genuinely interesting and is taking their time over it.

GO SLOWLY, AND UNDERSTAND WHAT THAT MEANS. It means FEWER IDEAS IN EACH SENTENCE. It does not mean longer sentences, which is the opposite and is the commonest way this goes wrong.

One idea per sentence for anything that matters. When you find yourself joining clauses with "and", "because", "which" or "while", stop and use a full stop instead. A listener has no punctuation and no page - they have only the gap where you stopped, and if you do not stop they have nowhere to put the thing you just told them.

  Too much at once: "A young woman is getting dressed in men's clothes in her father's cottage, because her lover has told her the parish officers are coming to prosecute her, and the only way to leave without being seen is to look like somebody else."

  Slow: "A young woman is getting dressed in men's clothes. Her lover has told her the parish officers are coming for her. The only way out without being seen is to look like somebody else."

Same facts, same words, three places to breathe instead of none. That is what slow is.

There is also no prize for covering ground. A listener would rather understand four things than half-follow twelve.

PAINT THE FIRST SCENE BEFORE YOU DO ANYTHING ELSE.
Open on one moment, and take four or five sentences over it. Where are we. What time of day. What day, what month, what year. Who is there. What does it look like. Only then start moving.
A listener who does not know what year they are in is not following anything, so say the date out loud early and plainly.
Do not rush the opening to get to the story. The opening IS the story starting.

ONE THING AT A TIME, IN ORDER.
After the opening, go forwards and keep going forwards. Do not jump ahead and come back. Do not mention something that happens later and then return to it. If a listener has to hold two timelines at once, they are holding neither.
Before every move in time or place, SAY SO. "The next morning." "Two streets away." "By the Thursday." Never make somebody work out that time has passed.
Finish with one person before starting on the next. A new name in the middle of somebody else's paragraph is where people lose the thread.

MAKING IT PICTURABLE. Every scene needs a time, a place, and ONE physical thing. Take them from the case file and nowhere else - if the file does not record what the weather was, there was no weather.
- "The August heat had made the asphalt soft" is a picture.
- "It was a difficult summer" is an adjective with nothing behind it.
Never invent a detail to make a scene work. If there is nothing recorded, say what is recorded and move on. A thin scene is a small cost; an invented one is a false statement about a real event.

PLAIN WORDS, AND NO FILLER.
Say the thing. Do not decorate it and do not explain that you are about to say it.
Banned outright, because they are the sound of a writer rather than a person, in every form including contracted ones: "the record shows", "by all accounts", "by the account that survives", "it bears noting", "what is certain is", "what's certain is", "one thing is clear", "in a twist", "little did", "fast forward", "needless to say".
If somebody said something, say who said it. If nobody did, say it plainly or leave it out.
No sentence that exists to sound good. If you cut it and nothing is lost, it was that kind of sentence.

MAKE THEM WANT THE NEXT BIT.
End every part on the thing the listener now needs to know, and let them feel it rather than being told to. Not a question to the audience. Not "but that was only the beginning". The plainest version of what happens next, held back by exactly one beat.

DATES. Say them the way a person says them. "The fourteenth of March" and not "March 14th, 1987" every time. Once the year is established, stop repeating it. Say how long things took in a way anybody can feel: "eleven days later", "by the end of that week", "it would be nineteen years before anybody looked at it again."

NAMES. Name, then one line on who they are, then back to the story. Never buried in a comma. The people marked to carry get used repeatedly and reminded; everybody else is said once where they act, or replaced by what they did.

WHAT IS ESTABLISHED AND WHAT IS NOT. The file marks each one.
- Established: state it.
- Alleged or disputed: attribute it, once, where it belongs. "He told police that..." and not "he had...". Say it once and then stop hedging - an episode that qualifies every sentence is unreadable and is not more careful, it is less clear.
- Unknown: say so out loud where it matters. "Nobody ever established where he was that afternoon" is more trustworthy AND more interesting than sliding past it.
Never supply a motive the record does not give. Never say what somebody was thinking or feeling unless they said so themselves.

WHOSE STORY THIS IS. The victim's. They get the background, the detail and the words. The person who did it gets what the record supports and nothing else: no nickname the reporting did not use, no theory about their childhood, nothing that sounds like admiration or like a character study. Do not describe violence in detail - say what happened and let the listener not be shown it.

HOW IT ENDS. On the case, and then it stops. NO SIGN-OFF. No "thanks for listening", no "see you next time", no mention of a next episode, no address to the audience at all. Somebody died. A presenter stepping out from behind that to say goodbye is the worst note available to this show.

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

  // DELIBERATELY NOT `signoffFor`. This lane has no sign-off and must not
  // acquire one: the persona happens to define none today, and if somebody adds
  // one for another format it must not leak into a true crime episode.

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

THE JOINS MATTER AS MUCH AS THE PARTS. Every part picks up from the last thing the part before it said, by name. Nobody starts again.

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
