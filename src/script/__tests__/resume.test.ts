/**
 * Resuming a half-written script.
 *
 * THE FAILURE THIS PREVENTS IS THE EXPENSIVE ONE. Writing a ten-beat script is
 * around thirty model calls and a quarter of an hour. Stage-level resumability
 * does not help, because the whole script is one stage - so a rate limit on
 * beat eight used to discard the twenty-one calls that had already succeeded.
 *
 * Everything here is about not paying twice, and about not producing a
 * Frankenstein script by resuming from a checkpoint that belongs to something
 * else.
 */
import { Persona } from '../../canon/schema';
import { EpisodeFormat } from '../../formats/schema';
import { LlmClient, LlmRequest, LlmResponse } from '../../models/client';
import { ScriptProgress, writeScript } from '../write';

const PROSE = [
  'The board said four and there were six.',
  'Nobody had written the other two up, which happens, except that the times on them were an hour apart and both entries said the same thing in the same handwriting, which does not.',
  'Not tonight.',
  'She put the folder down and went to find out who had been on.',
  'What should have taken five minutes took until half past four, and by then the answer had stopped being about paperwork at all.',
].join(' ');

const persona = {
  id: 'test-show',
  name: 'Test Show',
  register: 'Dry and specific.',
  hosts: [
    { id: 'a', name: 'A', role: 'Explains what the documents say.', voice: {} },
    { id: 'b', name: 'B', role: 'Presses on what a claim rests on.', voice: {} },
  ],
  thesis: 'One thing, reconstructed.',
  audience: 'People near decisions like this.',
  styleCard: { forbiddenPhrases: [], catchphraseBudget: 2 },
  canon: [],
} as unknown as Persona;

const format = (beatCount: number): EpisodeFormat =>
  ({
    id: 'test-format',
    name: 'Test',
    kind: 'long',
    targetSeconds: [600, 720],
    loops: [],
    beats: Array.from({ length: beatCount }, (_, i) => ({
      id: `b${i}`,
      type: i === 0 ? 'cold_open' : 'turn',
      seconds: [30, 60],
      function: 'x',
      constraints: [],
      minClaims: 0,
      optional: false,
    })),
    tensionCurve: Array.from({ length: beatCount }, () => 0.5),
  }) as unknown as EpisodeFormat;

/**
 * Fails when it reaches the nth BEAT, so a mid-stage death can be reproduced.
 *
 * Counted by beat rather than by call because writeBeat revises: a beat that
 * fails its critique costs up to three calls, so "fail on call three" could
 * mean the third beat or the first beat's second rewrite depending on prose
 * the test does not control.
 */
const writer = (failOnBeat?: number): LlmClient & { calls: number; beats: number } => {
  const client = {
    name: 'fake',
    model: 'test-model',
    calls: 0,
    beats: 0,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      client.calls++;

      // Planning is neither a beat nor a title, and it happens once before any
      // beat. Counting it as a beat would make "fail on beat three" mean beat
      // two, which is exactly the kind of off-by-one this fixture exists to
      // avoid.
      const isBeat =
        !req.system.includes('title and description') && !req.system.includes('plan one episode');
      const isRevision = req.prompt.includes('YOUR PREVIOUS DRAFT');
      if (isBeat && !isRevision) {
        client.beats++;
        if (client.beats === failOnBeat) throw new Error('rate limited');
      }

      const text = req.system.includes('title and description')
        ? JSON.stringify({ title: 'A Title', description: 'One. Two.' })
        : JSON.stringify({
            turns: [
              { speaker: 'a', text: PROSE },
              { speaker: 'b', text: 'Wait. Who signed it?' },
            ],
            claimIds: [],
          });

      return { text, inputTokens: 1, outputTokens: 1, costPence: 1, model: 'test-model' };
    },
  };
  return client;
};

const checkpoint = (initial: ScriptProgress = { beats: [] }) => {
  const state = { progress: initial };
  return {
    get saved() {
      return state.progress;
    },
    handle: {
      progress: initial,
      save: (progress: ScriptProgress) => {
        // Cloned, because the real one goes through JSON and a test that shares
        // the live array would pass while the real thing kept a reference.
        state.progress = JSON.parse(JSON.stringify(progress));
      },
    },
  };
};

const base = { persona, claims: [], angle: 'the thing', isoDate: '2026-09-11' };

describe('writeScript checkpointing', () => {
  it('saves after every beat, not at the end', async () => {
    // A batching interval would be a window in which succeeded work is lost,
    // which is the entire thing this exists to close.
    const saves: number[] = [];
    const cp = {
      progress: { beats: [] } as ScriptProgress,
      save: (p: ScriptProgress) => saves.push(p.beats.length),
    };

    await writeScript({ ...base, format: format(4) }, writer(), undefined, cp);
    expect(saves).toEqual([1, 2, 3, 4]);
  });

  it('RESUMES from the checkpoint instead of rewriting', async () => {
    const first = writer(3);
    const cp = checkpoint();

    await expect(
      writeScript({ ...base, format: format(4) }, first, undefined, cp.handle)
    ).rejects.toThrow(/rate limited/);
    expect(cp.saved.beats).toHaveLength(2);

    // The second attempt writes only what is left.
    const second = writer();
    const script = await writeScript({ ...base, format: format(4) }, second, undefined, {
      progress: cp.saved,
      save: cp.handle.save,
    });

    expect(script.beats).toHaveLength(4);
    // Only the two beats that were missing, plus the title. Never the two that
    // had already been paid for.
    expect(second.beats).toBe(2);
  });

  it('keeps the beats the first attempt wrote, in order', async () => {
    const cp = checkpoint();
    await expect(
      writeScript({ ...base, format: format(4) }, writer(3), undefined, cp.handle)
    ).rejects.toThrow();

    const script = await writeScript({ ...base, format: format(4) }, writer(), undefined, {
      progress: cp.saved,
      save: cp.handle.save,
    });

    expect(script.beats.map((b) => b.beatId)).toEqual(['b0', 'b1', 'b2', 'b3']);
  });

  it('does NOT resume a checkpoint from a different format', async () => {
    // Only a matching prefix is trusted. Stitching beats from another beat
    // sheet together would produce a script whose beats do not match its own
    // format, and the gate checks beat ids against the format.
    const stale: ScriptProgress = {
      beats: [
        { beatId: 'something_else', beatType: 'turn', turns: [], claimIds: [], revisions: 0 },
      ],
    };

    const client = writer();
    const script = await writeScript({ ...base, format: format(2) }, client, undefined, {
      progress: stale,
      save: () => undefined,
    });

    expect(script.beats.map((b) => b.beatId)).toEqual(['b0', 'b1']);
  });

  it('trusts only the matching PREFIX, not matching beats anywhere', async () => {
    // A checkpoint holding beats 1, 2 and 5 came from a different run. Taking
    // the prefix is the conservative reading; taking all three would leave a
    // hole nothing downstream would notice.
    const gappy: ScriptProgress = {
      beats: [
        { beatId: 'b0', beatType: 'cold_open', turns: [], claimIds: [], revisions: 0 },
        { beatId: 'b9', beatType: 'turn', turns: [], claimIds: [], revisions: 0 },
      ],
    };

    const script = await writeScript({ ...base, format: format(3) }, writer(), undefined, {
      progress: gappy,
      save: () => undefined,
    });

    expect(script.beats.map((b) => b.beatId)).toEqual(['b0', 'b1', 'b2']);
  });

  it('works with no checkpoint at all', async () => {
    const script = await writeScript({ ...base, format: format(3) }, writer());
    expect(script.beats).toHaveLength(3);
  });

  it('reports progress so a long run is not silent', async () => {
    // Fifteen minutes with nothing on screen is indistinguishable from a hang,
    // and the reasonable response to a hang is to kill it.
    const messages: string[] = [];
    await writeScript({ ...base, format: format(3) }, writer(), undefined, undefined, (m) =>
      messages.push(m)
    );

    expect(messages.some((m) => m.includes('beat 1/3'))).toBe(true);
    expect(messages.some((m) => m.includes('beat 3/3'))).toBe(true);
    expect(messages.some((m) => m.includes('title'))).toBe(true);
  });

  it('says when it is resuming', async () => {
    const messages: string[] = [];
    const done: ScriptProgress = {
      beats: [
        { beatId: 'b0', beatType: 'cold_open', turns: [], claimIds: [], revisions: 0 },
      ],
    };

    await writeScript(
      { ...base, format: format(2) },
      writer(),
      undefined,
      { progress: done, save: () => undefined },
      (m) => messages.push(m)
    );

    expect(messages.some((m) => m.includes('resuming'))).toBe(true);
  });
});
