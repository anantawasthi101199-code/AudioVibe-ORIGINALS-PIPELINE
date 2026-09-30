/**
 * The psychology lane: the safety floor exactly, the craft checks, lane
 * exclusivity, and a whole run with every outside service faked.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { LlmRequest, LlmResponse } from '../../models/client';
import { HttpResponse } from '../../evidence/fetch';
import { TtsProvider } from '../../render/tts';
import * as assemble from '../../render/assemble';
import { Run } from '../../run/store';
import { loadPersona } from '../../canon/load';
import { loadFormat } from '../../formats/load';
import { PipelineDeps } from '../../pipeline/episode';
import { runPsych } from '../../pipeline/psych';
import { assertFormatInLane, laneOf } from '../../pipeline/lanes';
import { regate } from '../../qa/regate';
import { scriptSchema } from '../../script/write';
import { curriculumSchema, hasCurriculum, loadCurriculum, refusedReason } from '../curriculum';
import {
  diagnosesListener,
  directsTreatment,
  hasCareLine,
  needsCareLine,
  promisesCure,
  secondPersonPer100,
  termsUsed,
  unglossedTerms,
  unsupportedStats,
} from '../check';

const book = loadCurriculum('inside-your-head');

describe('the shipped channel', () => {
  it('is a psychology channel and nothing else', () => {
    expect(hasCurriculum('inside-your-head')).toBe(true);
    expect(laneOf(loadPersona('inside-your-head'))).toBe('psychology');
    for (const id of loadPersona('inside-your-head').formats) loadFormat(id);
  });

  it('keeps every lane to its own formats', () => {
    expect(() => assertFormatInLane('psychology', 'psych-short')).not.toThrow();
    expect(() => assertFormatInLane('psychology', 'biz-short')).toThrow(/business format/);
    expect(() => assertFormatInLane('business', 'psych-episode')).toThrow(/psychology format/);
    expect(() => assertFormatInLane('story', 'psych-episode')).toThrow(/psychology format/);
    expect(() => assertFormatInLane('psychology', 'myth-story')).toThrow(/only runs its own/);
    expect(laneOf(loadPersona('how-they-built-it'))).toBe('business');
    expect(laneOf(loadPersona('myths-of-the-world'))).toBe('story');
  });

  it('refuses a query with no topic in it', () => {
    expect(() => curriculumSchema.parse({ ...book, queries: ['psychology explained', 'x {topic}'] })).toThrow();
  });

  it('refuses forums, therapy funnels and wellness shops before any fetch', () => {
    expect(refusedReason('https://www.reddit.com/r/adhd/comments/x', book)).toMatch(/refused/);
    expect(refusedReason('https://www.betterhelp.com/advice/adhd/', book)).toMatch(/refused/);
    expect(refusedReason('https://goop.com/wellness/mindfulness/x', book)).toMatch(/refused/);
    expect(refusedReason('https://www.nhs.uk/conditions/adhd/', book)).toBeNull();
  });
});

describe('the safety floor', () => {
  it('blocks telling the listener they have a condition, and allows supposing it', () => {
    expect(diagnosesListener('So you have ADHD, and that is why this happens.')).toEqual([
      'you have ADHD',
    ]);
    expect(diagnosesListener("What this means is you're autistic.")).toHaveLength(1);
    // The show's ordinary register, which must never be blocked.
    expect(diagnosesListener('If you have ADHD, you will know this feeling.')).toEqual([]);
    expect(diagnosesListener('Many people who have ADHD describe exactly this.')).toEqual([]);
    expect(diagnosesListener('You might have wondered whether you have ADHD.')).toEqual([]);
    expect(diagnosesListener('People with ADHD often find mornings hardest.')).toEqual([]);
  });

  it('blocks naming or directing a treatment, and allows pointing at a professional', () => {
    expect(directsTreatment('Some people find Adderall helps with this.')).toHaveLength(1);
    expect(directsTreatment('You could ask about coming off your medication.')).toHaveLength(1);
    expect(directsTreatment('You need to get diagnosed before anything else.')).toHaveLength(1);
    expect(
      directsTreatment('If this is affecting your life, your doctor is the person to talk to.')
    ).toEqual([]);
  });

  it('blocks promising a cure', () => {
    expect(promisesCure('This will cure your anxiety.')).toHaveLength(1);
    expect(promisesCure('Three minutes a day to rewire your brain.')).toHaveLength(1);
    expect(promisesCure('Do this and the overwhelm is gone forever.')).toHaveLength(1);
    expect(promisesCure('This will not make it disappear, and it can get easier.')).toEqual([]);
  });

  it('requires a line pointing at real help on a serious subject only', () => {
    expect(needsCareLine('why we procrastinate', 'a script about starting tasks')).toBe(false);
    expect(needsCareLine('intrusive thoughts about self-harm', 'anything')).toBe(true);
    expect(needsCareLine('anxiety', 'and if you have been having suicidal thoughts')).toBe(true);
    expect(hasCareLine('Please talk to your doctor or a therapist about this.')).toBe(true);
    expect(hasCareLine('It usually passes on its own.')).toBe(false);
  });
});

describe('the craft checks', () => {
  it('requires a plain-words gloss in the same breath as a term', () => {
    expect(
      unglossedTerms('Your prefrontal cortex, the part of your brain that gets you started, goes quiet.')
    ).toEqual([]);
    expect(unglossedTerms('This is your amygdala doing its job.')).toEqual(['amygdala']);
    // The gloss may come first, which is how people actually talk.
    expect(
      unglossedTerms('The chemical that tells you what matters, dopamine, is uneven here.')
    ).toEqual([]);
    // BOTH GLOSSES THE FIRST LIVE EPISODE ACTUALLY WROTE. An appositive noun
    // phrase after the term is the commonest gloss in English, and the first
    // version of this check flagged both of these as unexplained.
    expect(
      unglossedTerms(
        'Your brain uses dopamine, a brain chemical that helps you start and stay with a task, differently.'
      )
    ).toEqual([]);
    expect(
      unglossedTerms(
        'Working memory, the narrow holding space your mind uses to keep things in view, is only so wide.'
      )
    ).toEqual([]);
  });

  it('counts technical terms, for a short\'s stricter cap', () => {
    expect(termsUsed('dopamine and the amygdala and your working memory')).toHaveLength(3);
    expect(termsUsed('your brain is tired and everything feels loud')).toEqual([]);
  });

  it('holds statistics to the research and leaves plain numbers alone', () => {
    const research = 'Around 40% of adults report this. One study of 2400 people found the same.';
    expect(unsupportedStats('About 40 per cent of adults say this.', research)).toEqual([]);
    expect(unsupportedStats('Some 85% of adults say this.', research)).toEqual(['85%']);
    expect(unsupportedStats('A study of 9000 people found it.', research)).toEqual(['9000']);
    // THE IMPORTANT ONE. These are the host's own speech, not claims, and a
    // check that flagged them would be switched off within a week.
    expect(
      unsupportedStats(
        'Trust the next 2 minutes. Not 20 options, one. Give it 30 seconds. Like 50 tabs open.',
        research
      )
    ).toEqual([]);
  });

  it('notices when it stopped talking to the listener', () => {
    expect(secondPersonPer100('you know that feeling when your brain will not start for you')).toBeGreaterThan(5);
    expect(
      secondPersonPer100('Individuals with this condition report difficulty initiating tasks regularly.')
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The whole run
// ---------------------------------------------------------------------------

const PAGE = (body: string) =>
  `<html><head><title>Overwhelm and the brain</title></head><body><article><p>${body}</p></article></body></html>`;

const BODY =
  'Overwhelm happens when the brain is asked to sort too many things at once and cannot rank them. ' +
  'Around 40% of adults describe this experience at least weekly, according to the survey. ' +
  'The part of the brain that organises and starts tasks depends on a chemical signal to sort what matters. ' +
  ('When that signal is uneven, everything arrives at the same volume and nothing gets picked first. ' +
    'People describe getting up to clean a room and ending up sitting on the bed on their phone. ' +
    'What helps is making the choice smaller: one item, not the whole kitchen, and a timer set for two minutes. ').repeat(
    12
  );

const FINDINGS = {
  sources: [
    {
      sourceId: 'REPLACE',
      mechanism: ['the part of the brain that starts tasks depends on an uneven signal'],
      corrections: ['people think it is laziness, it is a sorting problem'],
      experiences: ['you get up to clean and end up on your phone on the bed'],
      strategies: ['make the task smaller: one item rather than the whole kitchen'],
      figures: ['around 40% of adults describe this weekly'],
      terms: [{ term: 'dopamine', meaning: 'the chemical that tags what matters' }],
    },
  ],
};

const UNDERSTANDING = {
  subject: 'overwhelm',
  oneLine: 'your mind cannot decide what to do first, so it does nothing',
  feltMoment: 'you sit down to do one thing and your mind will not start',
  picture: {
    name: 'the control panel',
    build: 'one switch versus a panel of buttons all blinking at once',
    mapsTo: 'each button is a task, and none of them blink in order',
    keywords: ['control panel', 'buttons'],
  },
  mechanism: 'the part that sorts what matters gets an uneven signal, so everything arrives at once',
  terms: [{ term: 'dopamine', gloss: 'the chemical that tags what matters' }],
  corrections: [{ believed: 'it is laziness', actually: 'it is a sorting problem' }],
  realLife: ['you get up to clean and end up on the bed on your phone'],
  innerVoice: ["why can't I just do it?"],
  comfort: 'your mind pauses to protect you when there is too much at once',
  notSaying: ['it is not laziness'],
  helps: [{ instead: 'clean the kitchen', tryThis: 'pick up one thing', why: 'one choice is possible' }],
  figures: ['around 40% of adults describe this weekly'],
  careNote: '',
  variants: [],
};

const SCRIPT = {
  title: 'Why your mind will not start the thing',
  description: 'What overwhelm actually is. For anybody who has sat down to do one thing and frozen.',
  beats: [
    {
      beatId: 'opening',
      turns: [
        {
          speaker: 'host',
          text:
            'You know that moment when you sit down to do one simple thing and your mind just will not start? ' +
            "You're not being lazy, and you're not avoiding it. If that sounds familiar, you are not alone. " +
            'This has a name, and today I want to tell you what is actually happening, why it feels so heavy, and what helps.',
        },
      ],
    },
    {
      beatId: 'picture',
      turns: [
        {
          speaker: 'host',
          text:
            'Picture a control panel. Not one switch, but a whole panel of buttons, all blinking at once. ' +
            'The laundry is a button. That email is a button. So is drinking some water. ' +
            'None of them blink in order, so you cannot tell which one to press. It is not laziness.',
        },
      ],
    },
    {
      beatId: 'brain',
      turns: [
        {
          speaker: 'host',
          text:
            'People often think this is about being distracted, but it is really about sorting. ' +
            'Dopamine, which is the chemical that tags what matters, is what your brain uses to rank things. ' +
            'When that signal is uneven, every button lights up at the same brightness, and you freeze.',
        },
      ],
    },
    {
      beatId: 'real_life',
      turns: [
        {
          speaker: 'host',
          text:
            'You get up to clean your room, and twenty minutes later you are sitting on the bed on your phone. ' +
            'Around 40 per cent of adults describe something like this every week. You are really not unusual.',
        },
      ],
    },
    {
      beatId: 'feelings',
      turns: [
        {
          speaker: 'host',
          text:
            "And then the thoughts arrive. Why can't I just do it? Everyone else seems fine. " +
            'You look calm on the outside while none of it feels calm inside, and that shame stops you choosing at all.',
        },
      ],
    },
    {
      beatId: 'helps',
      turns: [
        {
          speaker: 'host',
          text:
            'Your mind is not trying to make life harder. It pauses when there is too much at once. ' +
            'So instead of clean the kitchen, try pick up one thing. Set a timer for two minutes. ' +
            'You do not have to finish, and you do not have to do it well. You only have to begin.',
        },
      ],
    },
    {
      beatId: 'close',
      turns: [
        {
          speaker: 'host',
          text:
            'Your control panel is not broken. It is just overloaded, and that says nothing about you. ' +
            'Press one button today. Follow the show for more of how your mind works, and be kind to yourself.',
        },
      ],
    },
  ],
};

const SHORT_SCRIPT = {
  title: 'Why you freeze before you start',
  description: 'One reason your mind stalls. For anybody who has frozen at their own to-do list.',
  beats: [
    {
      beatId: 'moment',
      turns: [
        {
          speaker: 'host',
          text:
            'You sit down to do one thing and your mind will not start. It is not laziness. ' +
            'You are not avoiding it either, whatever the voice in your head has been telling you all afternoon about it.',
        },
      ],
    },
    {
      beatId: 'why',
      turns: [
        {
          speaker: 'host',
          text:
            'Picture a panel of buttons, every single one of them blinking at exactly the same brightness at the same time. ' +
            'Nothing tells you which matters most. So you press none.',
        },
      ],
    },
    {
      beatId: 'one_thing',
      turns: [
        {
          speaker: 'host',
          text:
            'Pick one button. Give it two minutes, and let the rest of that blinking panel wait until you have. ' +
            'Follow for more of how your mind works.',
        },
      ],
    },
  ],
};

const fakeWriter = (over: { understanding?: unknown; script?: unknown } = {}) => {
  const client = {
    name: 'fake-writer',
    model: 'writer-1',
    calls: 0,
    prompts: [] as string[],
    systems: [] as string[],
    async complete(req: LlmRequest): Promise<LlmResponse> {
      client.calls++;
      client.prompts.push(req.prompt);
      client.systems.push(req.system);
      let body: unknown;
      if (req.system.includes('reading research and clinical writing')) {
        body = {
          sources: [{ ...FINDINGS.sources[0]!, sourceId: req.prompt.match(/sourceId: (\S+)/)?.[1] ?? 'x' }],
        };
      } else if (req.system.includes('turning notes taken from several documents')) {
        body = over.understanding ?? UNDERSTANDING;
      } else {
        body = over.script ?? (req.prompt.includes('--- moment ---') ? SHORT_SCRIPT : SCRIPT);
      }
      return { text: JSON.stringify(body), inputTokens: 10, outputTokens: 10, costPence: 2, model: 'writer-1' };
    },
  };
  return client;
};

const fakeTts = (): TtsProvider & { calls: number } => {
  const provider = {
    name: 'fake-tts',
    calls: 0,
    async synthesise() {
      provider.calls++;
      return { audio: Buffer.alloc(4000), provider: 'fake-tts', model: 'tts-1', voiceId: 'shimmer', costPence: 1 };
    },
  };
  return provider;
};

describe('runPsych', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-psych-'));
    process.env.FOUNDRY_EPISODE_BUDGET_PENCE = '1000';
    process.env.FOUNDRY_RUNS_DIR = root;
    process.env.FOUNDRY_VOICES_FILE = path.join(root, 'voices.json');
    jest.spyOn(assemble, 'probeDuration').mockResolvedValue(80);
    jest.spyOn(assemble, 'concatBeats').mockImplementation(async (_f: string[], out: string) => {
      fs.writeFileSync(out, Buffer.alloc(16));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FOUNDRY_RUNS_DIR;
    delete process.env.FOUNDRY_VOICES_FILE;
  });

  const search = {
    name: 'fake',
    search: jest.fn(async () => [
      { url: 'https://www.reddit.com/r/adhd/comments/x', title: 'forum' },
      { url: 'https://www.nhs.uk/conditions/overwhelm/', title: 'NHS' },
      { url: 'https://www.apa.org/topics/overwhelm', title: 'APA' },
      { url: 'https://www.verywellmind.com/overwhelm-1234', title: 'Verywell' },
      { url: 'https://www.mind.org.uk/overwhelm/', title: 'Mind' },
      { url: 'https://chadd.org/overwhelm/', title: 'CHADD' },
      { url: 'https://www.betterhelp.com/advice/overwhelm/', title: 'funnel' },
    ]),
  };

  const httpGet = jest.fn(async (url: string): Promise<HttpResponse> => ({
    status: 200,
    body: PAGE(BODY),
    finalUrl: url,
    contentType: 'text/html',
  }));

  const deps = (writer = fakeWriter()): PipelineDeps => ({
    writer,
    verifier: writer,
    search,
    tts: fakeTts(),
    fetchDeps: { httpGet },
  });

  const makeRun = (formatId = 'psych-episode') =>
    Run.create({ personaId: 'inside-your-head', formatId, topic: 'overwhelm' }, { root });

  it('extracts, fuses, then writes: three calls, in that order, and passes', async () => {
    const run = makeRun();
    const writer = fakeWriter();
    const { gate, script } = await runPsych(run, deps(writer), {});

    expect(writer.calls).toBe(3);
    expect(writer.systems[0]).toContain('reading research and clinical writing');
    expect(writer.systems[1]).toContain('turning notes taken from several documents');
    expect(writer.systems[2]).toContain('SHOW: Inside Your Head');
    // The writer is given the understanding and never the documents.
    expect(writer.prompts[2]).toContain('THE PICTURE THIS EPISODE IS BUILT ON');
    expect(writer.prompts[2]).not.toContain('according to the survey');

    expect(script.beats).toHaveLength(7);
    expect(gate.findings.filter((f) => f.blocking)).toEqual([]);
    expect(gate.passed).toBe(true);
    expect(run.hasArtifact('claims')).toBe(true);
    expect(run.hasArtifact('publish')).toBe(false);
  });

  it('never shows the writer what the documents disagreed about', async () => {
    const writer = fakeWriter({
      understanding: { ...UNDERSTANDING, variants: ['two sources disagree on the figure'] },
    });
    await runPsych(makeRun(), deps(writer), {});
    expect(writer.prompts[2]).not.toContain('disagree');
    expect(writer.prompts[2]).toContain('the control panel');
  });

  it('drops the forum and the therapy funnel before reading anything', async () => {
    await runPsych(makeRun(), deps(), {});
    const fetched = httpGet.mock.calls.map((c) => c[0]);
    expect(fetched.some((u) => u.includes('reddit'))).toBe(false);
    expect(fetched.some((u) => u.includes('betterhelp'))).toBe(false);
  });

  it('BLOCKS a script that diagnoses, prescribes or promises a cure', async () => {
    const bad = JSON.parse(JSON.stringify(SCRIPT));
    bad.beats[2].turns[0].text =
      'What this means is you have ADHD. Adderall helps a lot of people, and this will cure the overwhelm.';
    const { gate } = await runPsych(makeRun(), deps(fakeWriter({ script: bad })), {});
    const checks = gate.findings.filter((f) => f.blocking).map((f) => f.check);
    expect(checks).toEqual(
      expect.arrayContaining(['psychDiagnosis', 'psychTreatment', 'psychCure'])
    );
    expect(gate.passed).toBe(false);
  });

  it('BLOCKS an unexplained term and an invented statistic', async () => {
    const bad = JSON.parse(JSON.stringify(SCRIPT));
    bad.beats[2].turns[0].text =
      'This is your amygdala at work. Some 85 per cent of adults deal with it every single day.';
    const { gate } = await runPsych(makeRun(), deps(fakeWriter({ script: bad })), {});
    const checks = gate.findings.filter((f) => f.blocking).map((f) => f.check);
    expect(checks).toEqual(expect.arrayContaining(['psychJargon', 'psychStats']));
  });

  it('reports an episode that never lands on its own picture', async () => {
    const bad = JSON.parse(JSON.stringify(SCRIPT));
    bad.beats[6].turns[0].text =
      'That is all we have time for today. Press one thing today. Follow the show for more, and be kind to yourself.';
    const { gate } = await runPsych(makeRun(), deps(fakeWriter({ script: bad })), {});
    const picture = gate.findings.find((f) => f.check === 'psychPicture');
    expect(picture?.blocking).toBe(false);
    expect(picture?.detail).toMatch(/never comes back to it/);
    expect(gate.needsHumanReview).toBe(true);
  });

  it('writes a short from ONE article in one call, with no fusion', async () => {
    // A short is three parts, so the per-part stub has to be a short's length.
    jest.spyOn(assemble, 'probeDuration').mockResolvedValue(48);
    const run = makeRun('psych-short');
    const writer = fakeWriter();
    const { gate, script } = await runPsych(run, deps(writer), {});
    expect(writer.calls).toBe(1);
    expect(writer.prompts[0]).toContain('THE ARTICLE');
    expect(writer.prompts[0]).toContain('NO jargon at all');
    expect(script.beats).toHaveLength(3);
    expect(gate.passed).toBe(true);
    const corpus = run.readArtifact('corpus', z.object({ sources: z.array(z.any()) }).passthrough());
    expect(corpus.sources).toHaveLength(1);
  });

  it('resumes without paying twice, and regate routes to this lane', async () => {
    const run = makeRun();
    await runPsych(run, deps(), {});
    const second = fakeWriter();
    const again = deps(second);
    await runPsych(Run.open(run.id, { root }), again, {});
    expect(second.calls).toBe(0);
    expect((again.tts as TtsProvider & { calls: number }).calls).toBe(0);
    expect(regate(run, run.readArtifact('script', scriptSchema))?.passed).toBe(true);
  });

  it('abandons rather than explain a subject it could not read up on', async () => {
    const thin = { name: 'thin', search: async () => [{ url: 'https://www.reddit.com/r/x', title: 'x' }] };
    await expect(runPsych(makeRun(), { ...deps(), search: thin }, {})).rejects.toThrow(/abandoned/);
  });
});
