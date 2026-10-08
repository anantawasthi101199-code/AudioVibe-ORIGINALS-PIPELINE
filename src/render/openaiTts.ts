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
  forVoice,
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
export const PENCE_PER_MCHAR = 1200;
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

  // gpt_* first: voice-master.yaml keeps GPT's own values apart from Eleven's.
  const stability = num(voice.settings?.gpt_stability ?? voice.settings?.stability, 0.5);
  const style = num(voice.settings?.gpt_style ?? voice.settings?.style, 0.3);

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

  // THE SHOW'S OWN SENTENCE WINS. What was here before was a single default
  // sent for every show in the studio - "one half of a two-person conversation
  // that is already underway" - which is right for a two-hander and wrong for
  // one person explaining something they have read properly. A listener heard
  // it immediately on a health episode and described it as sounding like a
  // mystery instead of somebody imparting knowledge.
  const who =
    voice.direction ??
    'Speak as one half of a two-person conversation that is already underway.';

  const pace =
    voice.speed && voice.speed !== 1
      ? voice.speed > 1
        ? 'Keep it moving. Do not linger between sentences.'
        : 'Unhurried. Let each sentence land before the next.'
      : '';

  return [
    who,
    steadiness,
    colour,
    pace,
    'Never sound like an announcer, a narrator, or an advertisement.',
  ]
    .filter(Boolean)
    .join(' ');
};

interface OpenAiTtsDeps {
  post: HttpPostBinary;
  model?: string;
}

export class OpenAiTts implements TtsProvider {
  readonly name = 'openai';

  /**
   * It speaks them. A drafted episode said "serious" out loud mid-sentence,
   * because the script marks delivery as `[serious]` for Eleven v3 and this
   * engine has no idea that is not a word.
   *
   * Stated rather than left to the default so that reading this class answers
   * the question, and so a future model that does understand them is a one-line
   * change in the obvious place.
   */
  readonly understandsTags = false;

  /**
   * THE LIMIT IS IN TOKENS, NOT CHARACTERS, AND THAT COST A RENDER.
   *
   * This was 9000, with a note saying the model "took 10,000 in a single request
   * and rendered a whole episode in one call". Whatever accepted that, the model
   * in use now does not:
   *
   *   Input of 2119 tokens is over the maximum input limit of 2000 tokens.
   *
   * So the ceiling is 2000 TOKENS, and a character budget is only ever a proxy
   * for it. English prose runs around four characters per token, but punctuation,
   * short words and names push it lower, and the failure mode is the whole render
   * dying after the script has been paid for.
   *
   * 6000 characters is comfortably under 2000 tokens even at a pessimistic three
   * and a half characters each. It costs one extra seam on a long episode, which
   * is the trade the previous note already argued for and then got the wrong way
   * round.
   *
   * LOWERED AGAIN TO 2500, 2026-10-07. Under the token limit is not the same as
   * spoken in full: a Mythic Archives episode rendered at 6000 skipped a word or
   * two mid-request, which gpt-4o-mini-tts is known to do on long inputs. A
   * missed word is worse than a seam, so this trades a few more seams for it.
   */
  readonly maxInputChars = 2500;
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
        input: forVoice(req.text, req.voice),
        instructions: instructionsFor(req.voice),
        response_format: 'mp3',
        // BOTH THE PARAMETER AND THE WORDS, because the two engines behave
        // differently: the older speech models take `speed` literally, and
        // gpt-4o-mini-tts mostly responds to direction in `instructions`.
        // Sending only one of them works on one model and silently does nothing
        // on the other.
        ...(req.voice.speed ? { speed: req.voice.speed } : {}),
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
