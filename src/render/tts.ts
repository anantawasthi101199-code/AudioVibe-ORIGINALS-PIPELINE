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
  /**
   * What is spoken immediately before and after this request, for prosody.
   *
   * WHY THIS EXISTS, and it is the single most audible fault in a finished
   * episode. Every beat is synthesised as its own request, so the voice STOPS
   * at each boundary and a fresh synthesis begins with whatever pitch, pace and
   * intake the model picks from a standing start. A listener described it
   * exactly: "it stops and the new voice with weird start kicks in".
   *
   * Nothing was wrong with the script - the sentence before the join is
   * complete and the one after follows from it. The break is entirely a
   * rendering artifact of splitting one piece of speech into five requests.
   *
   * Eleven takes `previous_text` and `next_text` for precisely this: the text
   * is NOT spoken, it conditions the delivery, so the end of one beat and the
   * start of the next are voiced as though they were one continuous read.
   *
   * Not every provider has an equivalent - OpenAI's does not - so this is
   * advisory, and a provider that ignores it renders exactly as before.
   */
  previousText?: string;
  nextText?: string;
}

/** One speaker's line in a multi-voice request. */
export interface DialogueLine {
  text: string;
  voice: Voice;
}

export interface DialogueRequest {
  lines: DialogueLine[];
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
  /**
   * Whether this engine READS a bracketed tag as direction or as words.
   *
   * A listener heard the answer before any check did: the drafted audio says
   * "serious" out loud, in the middle of a sentence, because the script marks
   * delivery as `[serious]` and OpenAI's speech endpoint has no idea that is
   * not something to say.
   *
   * Eleven v3 takes the tags as performance direction, which is the entire
   * reason the writer is told to put them in. Every other engine here - and
   * every older Eleven model - treats them as text. So the renderer has to
   * strip them for anything that would speak them, and the only thing that
   * knows is the provider.
   *
   * Optional, and absent means NO. A provider that has not thought about it is
   * a provider that would read them aloud, and the failure of reading them
   * aloud is loud and constant while the cost of stripping them wrongly is one
   * flat sentence.
   */
  readonly understandsTags?: boolean;

  /**
   * How much text this engine will speak in one request.
   *
   * WHY THIS MATTERS MORE THAN IT LOOKS. Rendering per beat was never a choice,
   * it was an assumption - and it is the cause of the seam a listener described
   * as "a new voice with weird start kicks in". Every separate request is a
   * separate performance: its own pitch, its own pace, its own idea of how the
   * sentence should go.
   *
   * Measured rather than taken from the documentation, which quotes 4096 for
   * the older speech models: gpt-4o-mini-tts accepted 10,000 characters in one
   * request, and a whole 8,910-character episode rendered in a single call. Most
   * episodes fit in one or two requests, so most of the seams were never
   * necessary.
   *
   * Absent means "one beat at a time", which is the old behaviour and is right
   * for any engine whose real limit is unknown.
   */
  readonly maxInputChars?: number;

  readonly name: string;
  synthesise(req: SynthesisRequest): Promise<SynthesisResult>;
  /**
   * Render an exchange as ONE request, letting the provider own turn-taking.
   *
   * Not the same as rendering each turn and concatenating. Splicing separate
   * renders gives every turn the same flat prosody and a mechanical gap where a
   * person would have come in early or trailed off; the provider generating the
   * whole exchange at once is what produces overlap, interruption and a reply
   * that starts before the previous line has quite landed.
   *
   * Optional so a provider without a dialogue endpoint can still be used for
   * narrated shows rather than being unusable.
   */
  synthesiseDialogue?(req: DialogueRequest): Promise<SynthesisResult>;
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
// API pay-as-you-go, checked 2026-10-07: v4 is $0.08 per 1k characters ($0.022
// on an offer ending 12 October). About 6p at the list price.
export const ELEVENLABS_PENCE_PER_1K_CHARS = 6;

/**
 * The text as THIS voice should read it: the channel's respellings applied
 * (whole word, case-sensitive, the script keeps the real spelling), and on
 * ElevenLabs any tag the channel never uses removed. `ipa` prefers the /IPA/
 * form where one is given, which only eleven_v4 reads.
 */
export const forVoice = (
  text: string,
  voice: Voice,
  opts: { ipa?: boolean; neverTags?: boolean } = {}
): string => {
  let out = text;
  for (const p of voice.pronounce ?? []) {
    const escaped = p.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const whole = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu');
    out = out.replace(whole, opts.ipa && p.ipa ? p.ipa : p.sayAs);
  }
  if (opts.neverTags && voice.neverTags?.length) {
    const never = new Set(voice.neverTags.map((t) => t.toLowerCase()));
    out = out.replace(/\[([^\]]{1,48})\]\s*/g, (tag, inner: string) =>
      never.has(inner.trim().toLowerCase()) ? '' : tag
    );
  }
  return out;
};

/**
 * eleven_v4 has exactly two voice settings. Anything else in a persona's
 * settings (style from older personas, the gpt_* values) is not sent.
 */
const elevenSettings = (voice: Voice) => {
  const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    stability: n(voice.settings?.stability, 0.5),
    similarity_boost: n(voice.settings?.similarity_boost, 0.75),
  };
};

export class ElevenLabsTts implements TtsProvider {
  readonly name = 'elevenlabs';

  /**
   * Left unset deliberately, so Eleven keeps rendering a beat at a time.
   *
   * It does not need grouping: previous_text and next_text already make a beat
   * sound like the continuation it is, and keeping one file per beat keeps the
   * beat map measured rather than apportioned. Grouping is a workaround for an
   * engine that cannot be told what came before.
   */

  /**
   * v3 reads the tags as direction. Earlier models speak them.
   *
   * Checked against the model rather than hardcoded true, because a show that
   * drops to eleven_multilingual_v2 for cost would otherwise start announcing
   * its own stage directions and nothing would flag it.
   */
  get understandsTags(): boolean {
    return /v[34]/.test(this.model);
  }

  constructor(
    private apiKey: string,
    // v4, not v3: v3 ignores previous_text/next_text (no request stitching),
    // so every beat started from a standing start. v4 stitches and takes tags.
    private model = process.env.FOUNDRY_ELEVEN_MODEL || 'eleven_v4',
    private post: HttpPostBinary = nodePostBinary
  ) {}

  async synthesise({ text, voice, previousText, nextText }: SynthesisRequest): Promise<SynthesisResult> {
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
        text: forVoice(text, voice, { ipa: true, neverTags: true }),
        model_id: this.model,
        // NOT SPOKEN. These condition the delivery so that a beat rendered as
        // its own request is voiced as the continuation it actually is, rather
        // than from a standing start. See SynthesisRequest. v4 supports this;
        // v3 did not.
        ...(previousText ? { previous_text: forVoice(previousText, voice, { ipa: true, neverTags: true }) } : {}),
        ...(nextText ? { next_text: forVoice(nextText, voice, { ipa: true, neverTags: true }) } : {}),
        voice_settings: elevenSettings(voice),
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

  /**
   * Text to Dialogue: the whole exchange in one request.
   *
   * Costs the same as rendering the turns separately, since billing is by
   * character, and buys turn-taking the provider actually models - overlap,
   * interruption, a reply landing early. Splicing separate renders cannot
   * produce any of that, and gives every turn identical prosody besides.
   */
  async synthesiseDialogue({ lines }: DialogueRequest): Promise<SynthesisResult> {
    if (!lines.length) throw new TtsError(this.name, 'no lines to speak');

    for (const line of lines) {
      if (line.voice.voiceId.startsWith('REPLACE_')) {
        throw new TtsError(
          this.name,
          `a host still has a placeholder voiceId (${line.voice.voiceId}). ` +
            `Pick a real voice for every host, and then never change them.`
        );
      }
    }

    const res = await this.post(
      'https://api.elevenlabs.io/v1/text-to-dialogue',
      { 'xi-api-key': this.apiKey, accept: 'audio/mpeg' },
      {
        model_id: this.model,
        inputs: lines.map((l) => ({
          text: forVoice(l.text, l.voice, { ipa: true, neverTags: true }),
          voice_id: l.voice.voiceId,
          voice_settings: elevenSettings(l.voice),
        })),
      }
    );

    if (res.status < 200 || res.status >= 300) {
      throw new TtsError(this.name, `HTTP ${res.status}: ${res.text}`);
    }
    if (res.buffer.length < 1000) {
      throw new TtsError(this.name, `returned only ${res.buffer.length} bytes, which is not audio`);
    }

    const characters = lines.reduce((n, l) => n + l.text.length, 0);

    return {
      audio: res.buffer,
      provider: this.name,
      model: this.model,
      // Several voices produced this. Recorded as a joined list so provenance
      // still answers "which voices made this episode".
      voiceId: [...new Set(lines.map((l) => l.voice.voiceId))].join('+'),
      costPence: (characters / 1000) * ELEVENLABS_PENCE_PER_1K_CHARS,
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
