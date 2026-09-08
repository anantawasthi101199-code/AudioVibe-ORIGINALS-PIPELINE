import { Voice } from '../../canon/schema';
import { buildBeatMap, BEAT_GAP_S, renderScript } from '../assemble';
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
