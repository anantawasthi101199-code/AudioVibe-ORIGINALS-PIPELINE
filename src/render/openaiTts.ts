/**
 * OpenAI text to speech: the cheap provider, for finding out whether a show
 * works before paying to find out how good it can sound.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR. About fifteen pence an episode
 * against roughly two pounds, so iterating costs nothing, and the thing you are
 * iterating on
 * early is the WRITING - whether the argument lands, whether the hosts want
 * different things, whether the cold open earns the next thirty seconds. All of
 * that is audible through any competent voice.
 *
 * What it cannot tell you is whether the show sounds like two people. It has no
 * dialogue endpoint, so an exchange is rendered a turn at a time and joined,
 * and joined turns have a uniform prosody and a clean gap exactly where a real
 * person would have come in early or trailed off. That gap is the single most
 * reliable tell of generated audio, and no amount of voice quality hides it.
 *
 * So: draft here, publish on a provider that renders the exchange in one
 * request. The run artifact records which provider produced every take, so an
 * episode drafted here and re-rendered later is traceable rather than mystery
 * audio of unknown origin.
 *
 * IT READS `draftVoiceId`, NOT `voiceId`. A voice id belongs to a provider:
 * "onyx" means nothing to ElevenLabs and an Eleven id means nothing here. A
 * persona holds both rather than having one edited back and forth, because
 * editing it back and forth is a thing somebody eventually forgets to undo, and
 * the way you find out is a published episode in the wrong voice.
 */
import { Voice } from '../canon/schema';
import {
  HttpPostBinary,
  SynthesisRequest,
  SynthesisResult,
  TtsError,
  TtsProvider,
} from './tts';

/**
 * Pence per million characters.
 *
 * Approximate and it will drift. Being roughly right and visible beats being
 * exactly right and absent: a budget that silently stops counting is worse than
 * one that overestimates, because overestimating stops a run early and somebody
 * looks.
 */
const PENCE_PER_MCHAR = 1200;
// Roughly fifteen pence for a twelve-minute episode. Exact for tts-1, which is
// billed per character; approximate for gpt-4o-mini-tts, which is billed per
// audio token and lands in the same place. Close enough for a budget ceiling
// whose job is to stop a runaway run, not to reconcile an invoice.

export const DEFAULT_MODEL = 'gpt-4o-mini-tts';

/**
 * Turn a persona's voice settings into a spoken instruction.
 *
 * THE PART THAT MAKES THIS USABLE AT ALL. gpt-4o-mini-tts takes a plain-English
 * `instructions` field, and without one it reads everything like an
 * announcement - which would make every show in the studio sound identical and
 * make the draft useless for judging anything.
 *
 * The settings are Eleven's vocabulary, because the personas were written
 * against Eleven. Rather than add a second set of numbers to every persona,
 * they are translated: `stability` is how much the delivery should vary, and
 * `style` is how much colour to put on it. A rough mapping of someone else's
 * scale, and rough is the right amount of effort for a drafting provider.
 */
export const instructionsFor = (voice: Voice): string => {
  // Persona settings are loosely typed because they are passed straight through
  // to whichever provider owns them. Coerced here rather than trusted.
  const num = (value: unknown, fallback: number): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  const stability = num(voice.settings?.stability, 0.5);
  const style = num(voice.settings?.style, 0.3);

  const steadiness =
    stability >= 0.6
      ? 'Even and controlled. Do not push the delivery around.'
      : stability >= 0.4
        ? 'Natural variation in pace and pitch, as in conversation.'
        : 'Loose and responsive. Let the delivery move with the sense.';

  const colour =
    style >= 0.45
      ? 'Warm and expressive, but never performed.'
      : style >= 0.3
        ? 'Understated. Interested rather than enthusiastic.'
        : 'Dry and flat. Let the words carry it.';

  return [
    'Speak as one half of a two-person conversation that is already underway.',
    steadiness,
    colour,
    'Never sound like an announcer, a narrator, or an advertisement.',
  ].join(' ');
};

interface OpenAiTtsDeps {
  post: HttpPostBinary;
  model?: string;
}

export class OpenAiTts implements TtsProvider {
  readonly name = 'openai';
  private model: string;

  constructor(
    private apiKey: string,
    private deps: OpenAiTtsDeps
  ) {
    this.model = deps.model ?? DEFAULT_MODEL;
  }

  /**
   * No `synthesiseDialogue`, and that absence is deliberate rather than a gap
   * to be filled later. Implementing it by rendering each line and splicing
   * would let the renderer believe it had asked a provider to own turn-taking
   * when nobody had - and the resulting audio would be reported as dialogue
   * while sounding like a table read. The renderer's own per-turn path handles
   * this honestly, and labels it as what it is.
   */
  async synthesise(req: SynthesisRequest): Promise<SynthesisResult> {
    // The persona's `voiceId` belongs to whichever provider it names, and it is
    // not this one. Falling back to it would send an Eleven id to OpenAI and
    // get a 400 about an unknown voice, which is a confusing way to learn that
    // the show has no drafting voice configured.
    const voiceId = req.voice.draftVoiceId;
    if (!voiceId) {
      throw new TtsError(
        'openai',
        `this voice has no draftVoiceId, so it cannot be drafted on OpenAI. ` +
          `Add one to the persona (alloy, ash, ballad, coral, echo, fable, nova, ` +
          `onyx, sage or shimmer), or unset FOUNDRY_TTS to use the real engine.`
      );
    }

    const res = await this.deps.post(
      'https://api.openai.com/v1/audio/speech',
      { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      {
        model: this.model,
        voice: voiceId,
        input: req.text,
        instructions: instructionsFor(req.voice),
        response_format: 'mp3',
      }
    );

    if (res.status < 200 || res.status >= 300) {
      throw new TtsError('openai', res.text.slice(0, 300) || `HTTP ${res.status}`);
    }
    if (!res.buffer.length) {
      throw new TtsError('openai', 'returned no audio');
    }

    return {
      audio: res.buffer,
      provider: this.name,
      model: this.model,
      voiceId,
      costPence: (req.text.length / 1_000_000) * PENCE_PER_MCHAR,
    };
  }
}
