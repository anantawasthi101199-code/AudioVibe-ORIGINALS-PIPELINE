/**
 * Turning a beat into audio.
 *
 * RENDERED PER BEAT, NOT PER EPISODE, and three things fall out of that:
 *
 *   1. Beat timestamps come for free. They are what lets listener drop-off be
 *      attributed to a KIND of beat rather than to an episode, which is the
 *      whole feedback signal the format library learns from.
 *   2. One bad beat can be re-rendered without paying for the episode again.
 *      TTS is the most expensive step in the pipeline.
 *   3. Unchanged beats cache across re-runs.
 *
 * THE PROVIDER IS ABSTRACTED because it is a commodity that moves fast.
 * Eleven v3 is the current expressive benchmark for narration, but blind ELO
 * leaderboards already place Inworld and Gemini Flash TTS above it and
 * Chatterbox is a credible open-source option. Every render records which
 * provider, model and voice produced it, so any output is reproducible even
 * after the default changes.
 *
 * THE VOICE COMES FROM THE PERSONA, never from configuration. See the note in
 * canon/schema.ts: voice is what a show IS to a listener, and a value that can
 * drift by deployment is a value that will.
 */
import { Voice } from '../canon/schema';

export interface SynthesisRequest {
  text: string;
  voice: Voice;
}

export interface SynthesisResult {
  audio: Buffer;
  /** What actually produced this, recorded for reproducibility. */
  provider: string;
  model: string;
  voiceId: string;
  /** Approximate cost in pence, for the run budget. */
  costPence: number;
}

export interface TtsProvider {
  readonly name: string;
  synthesise(req: SynthesisRequest): Promise<SynthesisResult>;
}

export class TtsError extends Error {
  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`);
    this.name = 'TtsError';
  }
}

export type HttpPostBinary = (
  url: string,
  headers: Record<string, string>,
  body: unknown
) => Promise<{ status: number; buffer: Buffer; text: string }>;

export const nodePostBinary: HttpPostBinary = async (url, headers, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    buffer,
    // Only meaningful on an error, where the body is JSON rather than audio.
    text: res.ok ? '' : buffer.toString('utf8').slice(0, 400),
  };
};

/**
 * Roughly what a thousand characters costs, in pence.
 *
 * Approximate and will drift. Being roughly right and visible beats being
 * exactly right and absent, which is the same reasoning as the LLM price table.
 */
export const ELEVENLABS_PENCE_PER_1K_CHARS = 12;

export class ElevenLabsTts implements TtsProvider {
  readonly name = 'elevenlabs';

  constructor(
    private apiKey: string,
    private model = 'eleven_v3',
    private post: HttpPostBinary = nodePostBinary
  ) {}

  async synthesise({ text, voice }: SynthesisRequest): Promise<SynthesisResult> {
    if (voice.voiceId.startsWith('REPLACE_')) {
      // The placeholder that ships in a new persona file. Caught here rather
      // than at the API, where it would be a confusing 404 about a voice id.
      throw new TtsError(
        this.name,
        `the persona still has a placeholder voiceId (${voice.voiceId}). ` +
          `Pick a real voice and set it in the persona file - and then never change it.`
      );
    }

    const res = await this.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.voiceId)}`,
      { 'xi-api-key': this.apiKey, accept: 'audio/mpeg' },
      {
        text,
        model_id: this.model,
        // The persona owns these. Spread last so a show can override anything.
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          ...voice.settings,
        },
      }
    );

    if (res.status < 200 || res.status >= 300) {
      throw new TtsError(this.name, `HTTP ${res.status}: ${res.text}`);
    }
    if (res.buffer.length < 1000) {
      // A 200 with almost no bytes is an error page or an empty render, and
      // concatenating it would produce a silent gap nobody notices until the
      // episode is live.
      throw new TtsError(this.name, `returned only ${res.buffer.length} bytes, which is not audio`);
    }

    return {
      audio: res.buffer,
      provider: this.name,
      model: this.model,
      voiceId: voice.voiceId,
      costPence: (text.length / 1000) * ELEVENLABS_PENCE_PER_1K_CHARS,
    };
  }
}

/**
 * Prepare text for speech.
 *
 * The TTS engine reads what it is given, so anything the writer left in that is
 * punctuation-for-the-eye has to go. Markdown emphasis is the common one: a
 * stray asterisk is read aloud by some engines and silently swallowed by
 * others, and neither is what was meant.
 */
export const forSpeech = (text: string): string =>
  text
    .replace(/[*_`#]+/g, '')
    .replace(/\s*\n\s*\n\s*/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
