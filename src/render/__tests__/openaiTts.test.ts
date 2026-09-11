/**
 * The drafting voice engine.
 *
 * The thing worth pinning is not the HTTP shape, it is the instruction: without
 * one gpt-4o-mini-tts reads everything like an announcement, which would make
 * every show in the studio sound identical and make a draft useless for judging
 * the one thing it exists to judge.
 */
import { Voice } from '../../canon/schema';
import { HttpPostBinary, TtsError } from '../tts';
import { DEFAULT_MODEL, OpenAiTts, instructionsFor } from '../openaiTts';

const voice = (over: Partial<Voice['settings']> = {}): Voice =>
  ({
    provider: 'elevenlabs',
    voiceId: 'ELEVEN_ID',
    draftVoiceId: 'onyx',
    settings: { stability: 0.45, style: 0.35, ...over },
  }) as Voice;

const spyPost = (
  response: { status: number; buffer: Buffer; text: string } = {
    status: 200,
    buffer: Buffer.alloc(128),
    text: '',
  }
) => {
  // The body is asserted field by field below, so it is read as a bag of
  // unknowns rather than typed against a shape this test would then be
  // restating.
  type Body = Record<string, string | undefined>;
  const calls: Array<{ url: string; headers: Record<string, string>; body: Body }> = [];
  const post: HttpPostBinary = async (url, headers, body) => {
    calls.push({ url, headers, body: body as Body });
    return response;
  };
  return { calls, post };
};

describe('instructionsFor', () => {
  it('always says this is half of a conversation already underway', () => {
    // The single most useful line in it. Without it the engine opens every beat
    // as though introducing a programme, which is exactly what a cold open must
    // not sound like.
    expect(instructionsFor(voice())).toContain('two-person conversation');
  });

  it('always forbids the announcer register', () => {
    expect(instructionsFor(voice())).toMatch(/never sound like an announcer/i);
  });

  it('translates a high stability into a steady delivery', () => {
    expect(instructionsFor(voice({ stability: 0.8 }))).toMatch(/even and controlled/i);
  });

  it('translates a low stability into a loose one', () => {
    expect(instructionsFor(voice({ stability: 0.2 }))).toMatch(/loose and responsive/i);
  });

  it('translates style into how much colour to put on it', () => {
    expect(instructionsFor(voice({ style: 0.6 }))).toMatch(/warm and expressive/i);
    expect(instructionsFor(voice({ style: 0.1 }))).toMatch(/dry and flat/i);
  });

  it('gives two differently-configured hosts different instructions', () => {
    // If the two hosts get the same instruction, the drafting engine produces
    // two readings of one person and the draft cannot answer the question it
    // was rendered to answer.
    const ruth = instructionsFor(voice({ stability: 0.55, style: 0.3 }));
    const femi = instructionsFor(voice({ stability: 0.4, style: 0.45 }));
    expect(ruth).not.toBe(femi);
  });

  it('survives a persona with no settings at all', () => {
    expect(() => instructionsFor({ provider: 'elevenlabs', voiceId: 'nova' } as Voice)).not.toThrow();
  });

  it('survives a setting that is not a number', () => {
    // Persona settings are loosely typed because they pass straight through to
    // whichever provider owns them. A string here must not produce NaN
    // comparisons and a silently wrong instruction.
    const odd = { provider: 'elevenlabs', voiceId: 'nova', settings: { stability: 'high' } } as never;
    expect(instructionsFor(odd)).toMatch(/natural variation/i);
  });
});

describe('OpenAiTts', () => {
  it('posts the text, the voice and the instruction', async () => {
    const { calls, post } = spyPost();
    await new OpenAiTts('key', { post }).synthesise({ text: 'Hello there.', voice: voice() });

    expect(calls[0]!.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(calls[0]!.body.input).toBe('Hello there.');
    expect(calls[0]!.body.voice).toBe('onyx');
    expect(calls[0]!.body.instructions).toContain('two-person conversation');
    expect(calls[0]!.body.model).toBe(DEFAULT_MODEL);
  });

  it('asks for mp3, which is what the beat files are', async () => {
    const { calls, post } = spyPost();
    await new OpenAiTts('key', { post }).synthesise({ text: 'x', voice: voice() });
    expect(calls[0]!.body.response_format).toBe('mp3');
  });

  it('carries the key as a bearer token', async () => {
    const { calls, post } = spyPost();
    await new OpenAiTts('key', { post }).synthesise({ text: 'x', voice: voice() });
    expect(calls[0]!.headers.authorization).toBe('Bearer key');
  });

  it('reports its cost, so the run budget can stop it', async () => {
    const { post } = spyPost();
    const res = await new OpenAiTts('key', { post }).synthesise({
      text: 'x'.repeat(1_000_000),
      voice: voice(),
    });
    expect(res.costPence).toBeCloseTo(1200);
  });

  it('records what produced the audio, so a take is reproducible', async () => {
    const { post } = spyPost();
    const res = await new OpenAiTts('key', { post, model: 'tts-1' }).synthesise({
      text: 'x',
      voice: voice(),
    });
    expect(res).toMatchObject({ provider: 'openai', model: 'tts-1', voiceId: 'onyx' });
  });

  it('reports the API message on a refusal', async () => {
    const { post } = spyPost({ status: 400, buffer: Buffer.alloc(0), text: 'Unknown voice' });
    await expect(
      new OpenAiTts('key', { post }).synthesise({ text: 'x', voice: voice() })
    ).rejects.toThrow(/Unknown voice/);
  });

  it('treats an empty 200 as a failure', async () => {
    // Otherwise a beat file of zero bytes reaches the concatenator, which fails
    // much later with an ffmpeg error about nothing in particular.
    const { post } = spyPost({ status: 200, buffer: Buffer.alloc(0), text: '' });
    await expect(
      new OpenAiTts('key', { post }).synthesise({ text: 'x', voice: voice() })
    ).rejects.toThrow(TtsError);
  });

  it('reads draftVoiceId, NOT the persona voiceId', async () => {
    // The persona's voiceId belongs to ElevenLabs. Sending it here gets a 400
    // about an unknown voice, which is a confusing way to learn the show has no
    // drafting voice configured.
    const { calls, post } = spyPost();
    await new OpenAiTts('key', { post }).synthesise({ text: 'x', voice: voice() });
    expect(calls[0]!.body.voice).toBe('onyx');
    expect(calls[0]!.body.voice).not.toBe('ELEVEN_ID');
  });

  it('REFUSES a voice with no drafting id rather than sending the wrong one', async () => {
    const { post } = spyPost();
    const noDraft = { provider: 'elevenlabs', voiceId: 'ELEVEN_ID', settings: {} } as Voice;
    await expect(
      new OpenAiTts('key', { post }).synthesise({ text: 'x', voice: noDraft })
    ).rejects.toThrow(/draftVoiceId/);
  });

  it('has NO dialogue endpoint, deliberately', () => {
    // Implementing one by splicing would let the renderer believe a provider
    // had owned turn-taking when nobody had, and report the result as dialogue
    // while it sounded like a table read. The renderer's own per-turn path
    // handles this and labels it as what it is.
    const { post } = spyPost();
    expect(new OpenAiTts('key', { post }).synthesiseDialogue).toBeUndefined();
  });
});
