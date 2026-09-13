/**
 * One-pass script writing.
 *
 * What is pinned here is not prose quality, which no test can judge. It is the
 * contract the method has to keep so that a comparison against beat-by-beat
 * writing is a comparison of the WRITING rather than of two different pipelines:
 * the same beats in the same order, the same checks applied with the same
 * "everything before this" context, and one call rather than eleven.
 */
import { z } from 'zod';
import { LlmClient, LlmRequest, LlmResponse } from '../../models/client';
import { loadPersona } from '../../canon/load';
import { loadFormat } from '../../formats/load';
import { Claim } from '../../evidence/claim';
import { writeScriptOnePass, MAX_SCRIPT_REVISIONS } from '../onePass';

const persona = loadPersona('honest-health');
const format = loadFormat('what-we-know');

const claims: Claim[] = format.beats.flatMap((beat, bi) =>
  Array.from({ length: beat.minClaims || 1 }, (_, i) => ({
    id: `c${bi}_${i}`,
    beatId: beat.id,
    text: `A measured fact for ${beat.id}, number ${i}.`,
    type: 'statistic' as const,
    sourceId: 'src1',
    quote: `A measured fact for ${beat.id}, number ${i}.`,
    contested: false,
    status: 'verified' as const,
  }))
);

/**
 * Prose that shares nothing between beats.
 *
 * NOT DECORATION. The repetition check is blocking and it compares each beat
 * against everything before it, so a fixture built from one template would fail
 * every beat after the first - and the tests below would then be measuring the
 * fixture rather than the method.
 */
const OPENERS = [
  'Sleep took thirty-one years to be measured this way at all.',
  'A ward in Chicago counted every waking in 1953.',
  'Electrodes glued to eleven undergraduates produced the first trace.',
  'Water moves through brain tissue along channels nobody had named.',
  'Two labs read identical recordings and published opposite conclusions.',
  'Nothing settles until somebody runs it on a thousand people.',
  'The oldest question here is still open.',
];
const BODIES = [
  'Volunteers arrived on a Tuesday evening, gave up their phones, and slept under observation for six consecutive nights while a technician wrote down every change in a paper log.',
  'Funding ran out before the second cohort finished, so the numbers everybody quotes today come from the forty-one participants who stayed, against a protocol written for three hundred.',
  'Each recording ran for eight hours and produced roughly nine metres of paper, which had to be read by eye because no software existed that could do it.',
  'The animals were kept on a reversed light cycle so that the interesting hours fell during the working day, which is a detail almost never mentioned and changes how the timings should be read.',
  'A second group repeated the protocol in Melbourne and got a smaller effect, and the argument about why has been running ever since.',
  'Twelve trials were pooled, four were excluded for using a different measure, and the remaining eight disagreed with each other by a factor of three.',
  'What is left after all of that is a single number with a wide interval around it, and a great deal of confidence placed on it by people who have not read the interval.',
];

const CLOSERS = [
  'That number has stood since.',
  'The replication attempt was abandoned.',
  'It is the only trace anybody kept.',
  'Two grants later, the channels have names.',
  'Neither side has moved.',
  'Such a study has never been funded.',
  'Everything after this is argument.',
];

const proseFor = (beatId: string, i: number) =>
  [
    OPENERS[i % OPENERS.length],
    BODIES[i % BODIES.length],
    `The ${beatId} figure was ${i * 7 + 3}.`,
    CLOSERS[i % CLOSERS.length],
  ].join(' ');

interface Stub extends LlmClient {
  calls: LlmRequest[];
}

const fakeWriter = (opts: { dropBeat?: string; skipClaimIds?: boolean } = {}): Stub => {
  const stub: Stub = {
    name: 'fake-writer',
    model: 'writer-1',
    calls: [],
    async complete(req: LlmRequest): Promise<LlmResponse> {
      stub.calls.push(req);
      let text: string;

      if (req.system.includes('You plan one episode')) {
        text = JSON.stringify({
          spine: 'What is measured, what is happening, and what is still argued.',
          cast: [],
          beats: format.beats.map((b) => ({
            beatId: b.id,
            happens: `The ${b.id} part happens here.`,
            leaves: `They now know the ${b.id} part.`,
          })),
        });
      } else if (req.system.includes('title and description')) {
        text = JSON.stringify({ title: 'The Measured Part', description: 'One. Two.' });
      } else {
        text = JSON.stringify({
          beats: format.beats
            .filter((b) => b.id !== opts.dropBeat)
            .map((b, i) => ({
              beatId: b.id,
              turns: [{ speaker: persona.hosts[0]!.id, text: proseFor(b.id, i) }],
              claimIds: opts.skipClaimIds
                ? []
                : claims.filter((c) => c.beatId === b.id).map((c) => c.id),
            }))
            // Deliberately out of order, because a model returning them shuffled
            // is a thing that happens and must not produce a script whose beats
            // disagree with its own beat sheet.
            .reverse(),
        });
      }

      return { text, inputTokens: 10, outputTokens: 10, costPence: 0.1, model: 'writer-1' };
    },
  };
  return stub;
};

const input = {
  persona,
  format,
  claims,
  angle: 'what is measured about sleep and memory',
  isoDate: '2026-09-13',
};

describe('writeScriptOnePass', () => {
  it('writes every beat of the format, in the format order', async () => {
    const writer = fakeWriter();
    const script = await writeScriptOnePass(input, writer);

    expect(script.beats.map((b) => b.beatId)).toEqual(format.beats.map((b) => b.id));
    expect(script.beats.map((b) => b.beatType)).toEqual(format.beats.map((b) => b.type));
  });

  it('writes the beats in ONE call, which is the whole point', async () => {
    // Beat by beat this format is seven beats plus revisions, so eight to
    // fifteen calls. Here it is a plan, a script and a title. If this number
    // ever creeps up, the method has quietly stopped being what it claims.
    const writer = fakeWriter();
    await writeScriptOnePass(input, writer);

    const scriptCalls = writer.calls.filter(
      (c) => !c.system.includes('You plan one episode') && !c.system.includes('title and description')
    );
    expect(scriptCalls).toHaveLength(1);
  });

  it('hands the writer every beat and every fact at once', async () => {
    // The property the method depends on. A writer that cannot see the closing
    // beat while writing the opening cannot avoid setting up something it will
    // then have to repeat.
    const writer = fakeWriter();
    await writeScriptOnePass(input, writer);

    const prompt = writer.calls.find(
      (c) => !c.system.includes('You plan one episode') && !c.system.includes('title and description')
    )!.prompt;

    for (const beat of format.beats) expect(prompt).toContain(beat.id);
    for (const claim of claims) expect(prompt).toContain(claim.id);
  });

  it('keeps the run traceable: every stated fact is reported', async () => {
    const writer = fakeWriter();
    const script = await writeScriptOnePass(input, writer);

    for (const beat of script.beats) {
      const researched = claims.filter((c) => c.beatId === beat.beatId);
      if (researched.length) expect(beat.claimIds.length).toBeGreaterThan(0);
    }
  });

  it('rewrites once when a beat fails a check, and not more', async () => {
    // A beat that states facts and reports none has no provenance, which is the
    // failure the per-beat writer already catches. One pass has to catch the
    // same thing or the two methods are not being held to one standard.
    const writer = fakeWriter({ skipClaimIds: true });
    await writeScriptOnePass(input, writer);

    const scriptCalls = writer.calls.filter(
      (c) => !c.system.includes('You plan one episode') && !c.system.includes('title and description')
    );
    expect(scriptCalls).toHaveLength(1 + MAX_SCRIPT_REVISIONS);

    // And the rewrite was told what was wrong, per beat, rather than asked to
    // try again.
    expect(scriptCalls[1]!.prompt).toContain('WHAT FAILED:');
    expect(scriptCalls[1]!.prompt).toContain('lists no claim ids');
  });

  it('REFUSES a script that came back missing a beat', async () => {
    // Silently shipping six beats of a seven-beat format would be caught at the
    // gate, but only after the audio had been rendered and paid for.
    const writer = fakeWriter({ dropBeat: 'mechanism' });

    await expect(writeScriptOnePass(input, writer)).rejects.toThrow(
      /without the "mechanism" beat/
    );
  });

  it('keeps the plan with the script', async () => {
    // The pronoun check needs it, and so does anybody reading the run later and
    // asking why a beat introduced somebody where it did.
    const writer = fakeWriter();
    const script = await writeScriptOnePass(input, writer);

    expect(script.plan?.spine).toMatch(/measured/);
    expect(script.writerModel).toBe('writer-1');
  });

  it('keeps the plan, so a resumed run is not re-planned into a different story', async () => {
    // The first real one-pass run died after planning and paid for a second
    // plan on resume. The 6p was the small half: the second plan was a
    // DIFFERENT plan, so the episode would have been written to a spine its own
    // journal did not describe.
    const writer = fakeWriter();
    const saved: unknown[] = [];
    const checkpoint = {
      progress: { beats: [] as never[] },
      save: (p: unknown) => saved.push(p),
    };

    await writeScriptOnePass(input, writer, undefined, checkpoint as never);
    expect((saved[0] as { plan?: unknown }).plan).toBeDefined();

    // Second run, handed back what the first saved.
    const resumed = fakeWriter();
    const withPlan = {
      progress: saved[0] as never,
      save: () => undefined,
    };
    const script = await writeScriptOnePass(input, resumed, undefined, withPlan as never);

    expect(resumed.calls.some((c) => c.system.includes('You plan one episode'))).toBe(false);
    expect(script.plan?.spine).toMatch(/measured/);
  });

  it('still produces a script when planning fails', async () => {
    // A failed plan must not cost the episode. It is worse without one, but it
    // is not nothing.
    const writer = fakeWriter();
    const original = writer.complete.bind(writer);
    writer.complete = async (req: LlmRequest) => {
      if (req.system.includes('You plan one episode')) throw new Error('planner unavailable');
      return original(req);
    };

    const script = await writeScriptOnePass(input, writer);
    expect(script.beats).toHaveLength(format.beats.length);
    expect(script.plan).toBeUndefined();
  });

  it('parses into the artifact shape the rest of the pipeline reads', async () => {
    const writer = fakeWriter();
    const script = await writeScriptOnePass(input, writer);

    const { scriptSchema } = await import('../write');
    expect(() => scriptSchema.parse(JSON.parse(JSON.stringify(script)))).not.toThrow();
    expect(z.string().parse(script.title)).toBeTruthy();
  });
});
