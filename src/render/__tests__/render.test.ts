import { Voice } from '../../canon/schema';
import {
  apportion,
  buildBeatMap,
  BEAT_GAP_S,
  groupBeats,
  MAX_TRAILING_SILENCE_S,
  renderScript,
} from '../assemble';
import { ElevenLabsTts, forSpeech, TtsError, TtsProvider } from '../tts';

const voice: Voice = { provider: 'elevenlabs', voiceId: 'v123', settings: {} };

describe('forSpeech', () => {
  it('strips markdown the engine would read aloud or swallow', () => {
    // A stray asterisk is spoken by some engines and silently dropped by
    // others, and neither is what was meant.
    expect(forSpeech('The **alarm** was `off`')).toBe('The alarm was off');
  });

  it('collapses horizontal whitespace but keeps paragraph breaks', () => {
    expect(forSpeech('One.\n\n\n\nTwo.')).toBe('One.\n\nTwo.');
  });
});

describe('ElevenLabsTts', () => {
  const post = (status: number, buffer: Buffer, text = '') => async () => ({ status, buffer, text });

  it('returns audio and records what produced it', async () => {
    const tts = new ElevenLabsTts('k', 'eleven_v3', post(200, Buffer.alloc(5000)));
    const res = await tts.synthesise({ text: 'hello', voice });
    expect(res.audio.length).toBe(5000);
    expect(res.provider).toBe('elevenlabs');
    expect(res.model).toBe('eleven_v3');
    expect(res.voiceId).toBe('v123');
  });

  it('charges by character length', async () => {
    const tts = new ElevenLabsTts('k', 'eleven_v3', post(200, Buffer.alloc(5000)));
    const res = await tts.synthesise({ text: 'x'.repeat(1000), voice });
    expect(res.costPence).toBeCloseTo(12);
  });

  it('REFUSES the placeholder voice id a new persona ships with', async () => {
    // Caught here rather than at the API, where it is a confusing 404 about a
    // voice id nobody recognises.
    const tts = new ElevenLabsTts('k', 'eleven_v3', post(200, Buffer.alloc(5000)));
    await expect(
      tts.synthesise({ text: 'x', voice: { ...voice, voiceId: 'REPLACE_BEFORE_FIRST_PUBLISH' } })
    ).rejects.toThrow(/placeholder voiceId/);
  });

  it('treats a 200 with almost no bytes as a failure', async () => {
    // Concatenating an error page produces a silent gap nobody notices until
    // the episode is live.
    const tts = new ElevenLabsTts('k', 'eleven_v3', post(200, Buffer.alloc(20)));
    await expect(tts.synthesise({ text: 'x', voice })).rejects.toThrow(/not audio/);
  });

  it('surfaces an API error body', async () => {
    const tts = new ElevenLabsTts('k', 'eleven_v3', post(401, Buffer.from('{"detail":"bad key"}'), '{"detail":"bad key"}'));
    await expect(tts.synthesise({ text: 'x', voice })).rejects.toThrow(TtsError);
  });

  it('lets the persona override voice settings', async () => {
    let sent: { voice_settings?: Record<string, unknown> } = {};
    const tts = new ElevenLabsTts('k', 'eleven_v3', async (_u, _h, body) => {
      sent = body as typeof sent;
      return { status: 200, buffer: Buffer.alloc(5000), text: '' };
    });
    await tts.synthesise({ text: 'x', voice: { ...voice, settings: { stability: 0.1 } } });
    expect(sent.voice_settings?.stability).toBe(0.1);
  });
});

describe('buildBeatMap', () => {
  it('lays beats end to end with a gap between them', () => {
    const map = buildBeatMap(
      [
        { id: 'a', type: 'cold_open', durationS: 10 },
        { id: 'b', type: 'stakes', durationS: 20 },
      ],
      0.5
    );
    expect(map[0]).toEqual({ id: 'a', type: 'cold_open', startS: 0, endS: 10 });
    expect(map[1]).toEqual({ id: 'b', type: 'stakes', startS: 10.5, endS: 30.5 });
  });

  it('does not append a gap after the last beat', () => {
    const map = buildBeatMap([{ id: 'a', type: 'outro', durationS: 5 }], 0.5);
    expect(map[0]!.endS).toBe(5);
  });

  it('uses a real gap by default, because a beat boundary is a change of job', () => {
    expect(BEAT_GAP_S).toBeGreaterThan(0);
  });
});

describe('renderScript', () => {
  const fakeTts = (): TtsProvider => ({
    name: 'fake',
    async synthesise({ text }) {
      return {
        audio: Buffer.alloc(2000),
        provider: 'fake',
        model: 'fake-tts',
        voiceId: 'v123',
        costPence: text.length / 100,
      };
    },
  });

  const deps = (durations: number[]) => {
    let i = 0;
    return {
      writeFile: () => undefined,
      probe: async () => durations[i++] ?? null,
      concat: async () => undefined,
    };
  };

  const beats = [
    { beatId: 'cold_open', beatType: 'cold_open', turns: [{ speaker: 'host', text: 'Open.' }] },
    { beatId: 'payoff', beatType: 'payoff', turns: [{ speaker: 'host', text: 'Land.' }] },
  ];

  const voices = { host: voice, other: { ...voice, voiceId: 'v456' } };

  it('renders each beat and builds the map from MEASURED durations', async () => {
    // Measured rather than estimated: the whole value of the map is that a
    // timestamp corresponds to what a listener actually heard.
    const res = await renderScript(
      { beats, voices, beatPathFor: (n) => `/tmp/${n}`, outputPath: '/tmp/out.wav' },
      fakeTts(),
      deps([12, 30])
    );
    expect(res.beatMap).toHaveLength(2);
    expect(res.beatMap[0]!.endS).toBe(12);
    expect(res.beatMap[1]!.startS).toBeCloseTo(12 + BEAT_GAP_S);
    expect(res.durationS).toBeCloseTo(12 + BEAT_GAP_S + 30);
  });

  it('records which provider, model and voice produced it', async () => {
    const res = await renderScript(
      { beats, voices, beatPathFor: (n) => `/tmp/${n}`, outputPath: '/tmp/out.wav' },
      fakeTts(),
      deps([1, 1])
    );
    expect(res.provider).toBe('fake');
    expect(res.model).toBe('fake-tts');
    expect(res.voiceId).toBe('v123');
  });

  it('reports cost per beat, so a budget trips at the beat that tripped it', async () => {
    const costs: number[] = [];
    await renderScript(
      { beats, voices, beatPathFor: (n) => `/tmp/${n}`, outputPath: '/tmp/out.wav' },
      fakeTts(),
      deps([1, 1]),
      (c) => costs.push(c)
    );
    expect(costs).toHaveLength(2);
  });

  it('REFUSES to guess a duration it could not measure', async () => {
    // An estimated duration would put every later timestamp out, and those
    // timestamps are the entire reason for rendering per beat.
    await expect(
      renderScript(
        { beats, voices, beatPathFor: (n) => `/tmp/${n}`, outputPath: '/tmp/out.wav' },
        fakeTts(),
        deps([])
      )
    ).rejects.toThrow(/could not measure the duration/);
  });
});

describe('stitching beats into one continuous read', () => {
  /**
   * THE SINGLE MOST AUDIBLE FAULT IN A FINISHED EPISODE, and none of it was in
   * the script. A listener: "it stops and the new voice with weird start kicks
   * in... was perfect till there."
   *
   * Every beat is its own synthesis request, so the voice stopped at each
   * boundary and a fresh one began from a standing start - different pitch,
   * different pace, an audible intake. Eleven takes previous_text and next_text
   * for exactly this: not spoken, only used to condition the delivery.
   */
  const capture = () => {
    const bodies: Array<Record<string, unknown>> = [];
    const post = async (_url: string, _headers: unknown, body: unknown) => {
      bodies.push(body as Record<string, unknown>);
      return { status: 200, buffer: Buffer.alloc(5000), text: '' };
    };
    return { bodies, tts: new ElevenLabsTts('k', 'eleven_v3', post as never) };
  };

  it('sends the neighbouring text as prosody context, not as speech', async () => {
    const { bodies, tts } = capture();
    await tts.synthesise({
      text: 'She went down through the gates.',
      voice,
      previousText: 'and so she chose to go somewhere that does not let people leave.',
      nextText: 'At the first gate they took the crown from her head.',
    });

    expect(bodies[0]!.text).toBe('She went down through the gates.');
    expect(bodies[0]!.previous_text).toMatch(/does not let people leave/);
    expect(bodies[0]!.next_text).toMatch(/took the crown/);
  });

  it('omits the fields entirely at the ends of an episode', async () => {
    // A request carrying previous_text: undefined is not the same as one that
    // omits it, and the first beat genuinely has nothing before it.
    const { bodies, tts } = capture();
    await tts.synthesise({ text: 'The first thing.', voice });
    expect('previous_text' in bodies[0]!).toBe(false);
    expect('next_text' in bodies[0]!).toBe(false);
  });

  it('still lets the persona override the voice settings', async () => {
    // The stitch fields are spread before voice_settings, so adding them must
    // not have moved the persona out of last place.
    const { bodies, tts } = capture();
    await tts.synthesise({
      text: 'x',
      voice: { ...voice, settings: { stability: 0.35 } },
      previousText: 'y',
    });
    expect((bodies[0]!.voice_settings as { stability: number }).stability).toBe(0.35);
  });
});

describe('the truncation guard', () => {
  /**
   * A listener heard this before any check did: "it stops at 'by its own
   * law', the words after dont run in the audio and then a new voice starts".
   *
   * The words were in the script and the beat was complete. Rendering the
   * identical text three times settled it - 67.56s, 67.20s, and the 65.95s the
   * run produced - so the provider drops the tail intermittently.
   *
   * Duration cannot detect it: the loss is about two per cent, well inside the
   * variation between beats that read fast and slow. Trailing silence can, and
   * by four times: 0.31s and 0.41s on the complete renders against 1.48s on the
   * truncated one.
   */
  const beats = [{ beatId: 'opening', beatType: 'orientation', turns: [{ speaker: 'host', text: 'A sentence that should finish.' }] }];

  const render = (
    trailings: Array<number | null>,
    onProgress?: (m: string) => void,
    durations: number[] = []
  ) => {
    const calls: string[] = [];
    const tts: TtsProvider = {
      name: 'fake',
      async synthesise() {
        calls.push('synthesise');
        return { audio: Buffer.alloc(2000), provider: 'fake', model: 'm', voiceId: 'v', costPence: 1 };
      },
    };
    let i = 0;
    let d = 0;
    return {
      calls,
      done: renderScript(
        {
          beats,
          voices: { host: voice },
          beatPathFor: (n: string) => `/tmp/${n}`,
          outputPath: '/tmp/out.wav',
        },
        tts,
        {
          writeFile: () => undefined,
          probe: async () => durations[d++] ?? 60,
          trailing: async () => trailings[i++] ?? null,
          concat: async () => undefined,
        },
        undefined,
        onProgress
      ),
    };
  };

  it('RE-RENDERS a beat that ended on a long silence', async () => {
    const { calls, done } = render([1.48, 0.35]);
    await done;
    expect(calls).toHaveLength(2);
  });

  it('keeps the take with MORE SPEECH, not the one with less silence', async () => {
    // THE BUG THIS REPLACES. Choosing on trailing silence preferred a render
    // that truncated and stopped cleanly - almost no silence, seven seconds
    // less speech - over a complete one. The same beat, three times:
    //
    //   speech 173.2s  trailing 0.34s
    //   speech 168.6s  trailing 2.07s
    //   speech 165.8s  trailing 0.40s  <- what the old rule chose
    //
    // Both takes are the same text, so more speech is more of that text.
    const { calls, done } = render([1.4, 0.2], undefined, [100, 90]);
    const result = await done;
    expect(calls).toHaveLength(2);
    // The retry has LESS silence and LESS speech. The old rule took it.
    expect(result.durationS).toBe(100);
    // Both renders cost, and the budget has to see both whichever is kept.
    expect(result.costPence).toBe(2);
  });

  it('takes the retry when it genuinely says more', async () => {
    const { done } = render([1.4, 0.3], undefined, [90, 100]);
    expect((await done).durationS).toBe(100);
  });

  it('does not re-render a beat that ended cleanly', async () => {
    const { calls, done } = render([0.31]);
    await done;
    expect(calls).toHaveLength(1);
  });

  it('sits its threshold between the measured good and bad renders', () => {
    // 0.31 and 0.41 on complete renders, 1.48 on the truncated one. A
    // threshold outside that band is either deaf or trigger-happy.
    expect(MAX_TRAILING_SILENCE_S).toBeGreaterThan(0.41);
    expect(MAX_TRAILING_SILENCE_S).toBeLessThan(1.48);
  });

  it('does not re-render when the silence cannot be measured', async () => {
    // A heuristic guarding against a provider defect must never be able to
    // spend money on the strength of a measurement it did not get.
    const { calls, done } = render([null]);
    await done;
    expect(calls).toHaveLength(1);
  });

  it('says out loud that it is re-rendering, and why', async () => {
    const said: string[] = [];
    const { done } = render([1.48, 0.35], (m) => said.push(m));
    await done;
    expect(said.join(' ')).toMatch(/1\.5s of silence\. Taking it again/);
  });
});

describe('performance tags reaching an engine that would speak them', () => {
  /**
   * A listener: "it says serious in between, i think that was meant to be for
   * emotion in []".
   *
   * Exactly right. The writer is told to mark delivery as `[serious]` and
   * `[quietly]` because Eleven v3 reads them as direction - that is the whole
   * reason they are in the script. OpenAI's engine has no idea they are not
   * words, and every drafted episode had been announcing its own stage
   * directions mid-sentence.
   */
  const beats = [
    {
      beatId: 'world',
      beatType: 'stakes',
      turns: [{ speaker: 'host', text: '[serious] The Sumerians pictured the world in layers.' }],
    },
  ];

  const spy = (understandsTags: boolean | undefined) => {
    const sent: string[] = [];
    const tts = {
      name: 'fake',
      understandsTags,
      async synthesise(req: { text: string }) {
        sent.push(req.text);
        return { audio: Buffer.alloc(2000), provider: 'fake', model: 'm', voiceId: 'v', costPence: 1 };
      },
    } as unknown as TtsProvider;

    return {
      sent,
      done: renderScript(
        { beats, voices: { host: voice }, beatPathFor: (n) => `/tmp/${n}`, outputPath: '/tmp/out.wav' },
        tts,
        {
          writeFile: () => undefined,
          probe: async () => 60,
          trailing: async () => 0.3,
          concat: async () => undefined,
        }
      ),
    };
  };

  it('STRIPS the tag for an engine that reads it as words', async () => {
    const { sent, done } = spy(false);
    await done;
    expect(sent[0]).not.toMatch(/serious/);
    expect(sent[0]).toMatch(/The Sumerians pictured the world in layers\./);
  });

  it('keeps the tag for an engine that reads it as direction', async () => {
    const { sent, done } = spy(true);
    await done;
    expect(sent[0]).toMatch(/\[serious\]/);
  });

  it('treats an unstated provider as one that would speak them', async () => {
    // Absent means no. A provider that has not thought about it would read them
    // aloud, and that failure is loud and constant while stripping wrongly
    // costs one flat sentence.
    const { sent, done } = spy(undefined);
    await done;
    expect(sent[0]).not.toMatch(/serious/);
  });
});

describe('ElevenLabsTts.understandsTags', () => {
  it('is true on v3, which reads them as direction', () => {
    expect(new ElevenLabsTts('k', 'eleven_v3').understandsTags).toBe(true);
  });

  it('is FALSE on an older model, which would say them out loud', () => {
    // Checked against the model rather than hardcoded, because a show dropping
    // to an older model for cost would otherwise start announcing its own
    // stage directions with nothing to flag it.
    expect(new ElevenLabsTts('k', 'eleven_multilingual_v2').understandsTags).toBe(false);
  });
});

describe('groupBeats', () => {
  /**
   * Rendering one beat per request was never a decision, it was an assumption,
   * and it is the whole cause of the seam a listener described as "it stops and
   * the new voice with weird start kicks in". Every separate request is a
   * separate performance.
   *
   * Measured: gpt-4o-mini-tts took 10,000 characters in one request, and a
   * whole 8,910-character episode rendered in a single call.
   */
  const beat = (id: string, chars: number, speaker = 'host') => ({
    beatId: id,
    beatType: 'x',
    turns: [{ speaker, text: 'w'.repeat(chars) }],
  });
  const size = (b: { turns: { text: string }[] }) => b.turns.map((t) => t.text).join('').length;

  it('puts a whole episode in one request when it fits', () => {
    const beats = [beat('a', 1000), beat('b', 2000), beat('c', 3000)];
    expect(groupBeats(beats, 9000, size)).toHaveLength(1);
  });

  it('starts a new request rather than exceeding the limit', () => {
    const beats = [beat('a', 4000), beat('b', 4000), beat('c', 4000)];
    const groups = groupBeats(beats, 9000, size);
    expect(groups.map((g) => g.map((b) => b.beatId))).toEqual([['a', 'b'], ['c']]);
  });

  it('renders one beat at a time when the engine declares no limit', () => {
    // The old behaviour, and the right one for an engine whose real limit is
    // unknown.
    const beats = [beat('a', 10), beat('b', 10)];
    expect(groupBeats(beats, undefined, size)).toHaveLength(2);
  });

  it('never merges across a change of voice', () => {
    const beats = [beat('a', 100, 'cal'), beat('b', 100, 'wren'), beat('c', 100, 'wren')];
    expect(groupBeats(beats, 9000, size).map((g) => g.map((b) => b.beatId))).toEqual([
      ['a'],
      ['b', 'c'],
    ]);
  });

  it('leaves a two-voice beat entirely alone', () => {
    // It goes down the dialogue path and cannot be merged with anything.
    const duo = {
      beatId: 'duo',
      beatType: 'x',
      turns: [
        { speaker: 'a', text: 'one' },
        { speaker: 'b', text: 'two' },
      ],
    };
    const groups = groupBeats([beat('a', 100), duo, beat('c', 100)], 9000, size);
    expect(groups.map((g) => g.map((b) => b.beatId))).toEqual([['a'], ['duo'], ['c']]);
  });

  it('gives an over-long beat a request of its own rather than dropping it', () => {
    const beats = [beat('huge', 20000), beat('small', 100)];
    const groups = groupBeats(beats, 9000, size);
    expect(groups.map((g) => g.map((b) => b.beatId))).toEqual([['huge'], ['small']]);
  });
});

describe('apportion', () => {
  it('shares one measured duration by character count', () => {
    expect(apportion(100, [1, 3])).toEqual([25, 75]);
  });

  it('always adds back up to what was measured', () => {
    const parts = apportion(166.152, [927, 2910, 2399, 2294, 382]);
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(166.152, 6);
  });

  it('splits evenly rather than dividing by zero', () => {
    expect(apportion(60, [0, 0])).toEqual([30, 30]);
  });
});

describe('rendering an episode as one request', () => {
  it('sends every beat in a single call and still maps them all', async () => {
    const sent: string[] = [];
    const tts = {
      name: 'fake',
      maxInputChars: 9000,
      async synthesise(req: { text: string }) {
        sent.push(req.text);
        return { audio: Buffer.alloc(2000), provider: 'fake', model: 'm', voiceId: 'v', costPence: 1 };
      },
    } as unknown as TtsProvider;

    const beats = [
      { beatId: 'opening', beatType: 'orientation', turns: [{ speaker: 'host', text: 'a'.repeat(900) }] },
      { beatId: 'world', beatType: 'stakes', turns: [{ speaker: 'host', text: 'b'.repeat(2700) }] },
      { beatId: 'close', beatType: 'outro', turns: [{ speaker: 'host', text: 'c'.repeat(400) }] },
    ];

    const res = await renderScript(
      { beats, voices: { host: voice }, beatPathFor: (n) => `/tmp/${n}`, outputPath: '/tmp/out.wav' },
      tts,
      { writeFile: () => undefined, probe: async () => 200, trailing: async () => 0.3, concat: async () => undefined }
    );

    // One request, not three. That is the seam gone.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('a'.repeat(900));
    expect(sent[0]).toContain('c'.repeat(400));

    // Every beat still appears on the map, apportioned by character share.
    expect(res.beatMap.map((b) => b.id)).toEqual(['opening', 'world', 'close']);
    expect(res.beatMap[2]!.endS).toBeCloseTo(200, 5);
    expect(res.durationS).toBeCloseTo(200, 5);
  });
});

describe('the gap belongs between files, not between beats', () => {
  it('puts no silence between beats that share one audio file', () => {
    // CONFLATING THE TWO PUT EVERY LATER TIMESTAMP OUT the moment beats began
    // sharing a request. Silence is inserted by the concatenation, so two beats
    // inside one file have nothing between them, and describing a 0.45s pause
    // there describes a pause that is not in the audio.
    const map = buildBeatMap([
      { id: 'a', type: 'x', durationS: 10, endsFile: false },
      { id: 'b', type: 'x', durationS: 10, endsFile: true },
      { id: 'c', type: 'x', durationS: 10, endsFile: true },
    ]);
    expect(map[1]!.startS).toBe(10);
    expect(map[2]!.startS).toBeCloseTo(20 + BEAT_GAP_S, 5);
  });

  it('still gaps every beat when each has its own file', () => {
    // The old behaviour, and what an engine without a declared limit still does.
    const map = buildBeatMap([
      { id: 'a', type: 'x', durationS: 10 },
      { id: 'b', type: 'x', durationS: 10 },
    ]);
    expect(map[1]!.startS).toBeCloseTo(10 + BEAT_GAP_S, 5);
  });
});
