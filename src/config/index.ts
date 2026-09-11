/**
 * Configuration, read once and validated.
 *
 * Nothing here has a working default. A pipeline that publishes audio to a real
 * platform should refuse to start rather than guess where it is publishing to,
 * and "it defaulted to production" is a sentence nobody wants to say.
 *
 * Credentials are read LAZILY, per stage, rather than all at once at startup.
 * Researching a topic needs no TTS key and rendering needs no platform token,
 * so demanding everything up front would stop someone doing half the pipeline
 * because they lack a key for the other half.
 */
import path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

export class ConfigError extends Error {
  constructor(variable: string, why: string) {
    super(`${variable} ${why}\nSee .env.example.`);
    this.name = 'ConfigError';
  }
}

const required = (name: string): string => {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new ConfigError(name, 'is not set');
  }
  return value.trim();
};

export const repoRoot = (): string => path.resolve(__dirname, '..', '..');

export const runsDir = (): string => {
  const configured = process.env.FOUNDRY_RUNS_DIR || 'runs';
  return path.isAbsolute(configured) ? configured : path.join(repoRoot(), configured);
};

/**
 * Where series bibles live, one JSON file per fiction show.
 *
 * Separate from runs on purpose. A run is one episode and is finished; a bible
 * spans every episode of a show and is the one artifact here that is meant to
 * be mutated. Keeping it out of runs/ makes that difference visible in `ls`
 * rather than only in a comment, and makes it obvious what has to be backed up.
 */
export const biblesDir = (): string => {
  const configured = process.env.FOUNDRY_BIBLES_DIR || 'bibles';
  return path.isAbsolute(configured) ? configured : path.join(repoRoot(), configured);
};

/**
 * Ceiling on what one episode may cost, in pence.
 *
 * A run that would exceed it stops rather than degrading. A cost overrun should
 * be visible as silence, which somebody notices, rather than as quietly worse
 * output, which nobody does until much later.
 */
export const episodeBudgetPence = (): number => {
  const raw = process.env.FOUNDRY_EPISODE_BUDGET_PENCE;
  const n = raw ? Number(raw) : 500;
  return Number.isFinite(n) && n > 0 ? n : 500;
};

export const platformConfig = () => {
  const url = required('AUDIOVIBE_API_URL').replace(/\/+$/, '');

  // Loud, because publishing to the wrong environment is not something you can
  // take back: followers get notified, feeds cache, and the seen ledger records
  // it. Cheap to state, expensive to discover afterwards.
  const isProduction = /api\.audiovibe\.co/i.test(url);

  return {
    url,
    token: required('AUDIOVIBE_INGEST_TOKEN'),
    isProduction,
  };
};

/**
 * The writer, and the single biggest cost decision in the studio.
 *
 * SONNET BY DEFAULT, AND THAT IS A DELIBERATE CHANGE FROM OPUS. The writing
 * stage is more than half of what an episode costs, and almost all of that is
 * OUTPUT tokens - the script itself, which is the same length whichever model
 * writes it. So the only real lever on it is the price per token, and Sonnet is
 * five times cheaper than Opus for the same twelve minutes of audio.
 *
 * WHY THAT IS NOT OBVIOUSLY THE WRONG TRADE. Every structural thing that makes
 * this pipeline's prose good is OUTSIDE the model: the beat sheet, the style
 * card scored deterministically, the per-beat critique and revision loop, the
 * hook competition, the voice distinctness checks. A weaker model writing into
 * that scaffolding fails the checks more often and gets rewritten more often,
 * which costs calls rather than quality. What a stronger model buys is fewer
 * rewrites and better lines inside the constraints - real, but not structural.
 *
 * SO MEASURE IT RATHER THAN ASSUMING. `foundry compare` exists for exactly this
 * question: write the same topic twice, judge both orderings with a third
 * model, and see whether the difference is worth five times the price. Set
 * FOUNDRY_WRITER_MODEL=claude-opus-5 to run the other side of it.
 */
export const writerConfig = () => ({
  apiKey: required('ANTHROPIC_API_KEY'),
  model: process.env.FOUNDRY_WRITER_MODEL || 'claude-sonnet-5',
});

/**
 * The verifier, which must be a different model family from the writer.
 *
 * Not a preference. A verifier sharing the writer's priors reconstructs the
 * writer's justification instead of checking the text in front of it, which is
 * precisely the failure the whole verification stage exists to prevent.
 */
export const verifierConfig = () => ({
  apiKey: required('OPENAI_API_KEY'),
  model: process.env.FOUNDRY_VERIFIER_MODEL || 'gpt-5',
});

/**
 * The clerk: a cheap model for work that is mechanical rather than editorial.
 *
 * MODEL TIERING IS ONLY SAFE WHERE THE CHEAP MODEL'S OUTPUT IS CHECKED BY
 * SOMETHING THAT IS NOT A MODEL. That is the whole rule, and it is deliberately
 * strict, because the obvious places to save money here are exactly the places
 * where a worse model produces a worse SHOW rather than a visible failure.
 *
 * What the clerk is allowed to do:
 *   - Write search queries for the counter-evidence pass. A query is judged by
 *     what it finds; a weak query finds nothing and the next one runs.
 *
 * What the clerk is deliberately NOT allowed to do, and why:
 *   - The brief. It sets `likelyContested`, and an empty list means the search
 *     for disconfirming evidence never happens. Getting that wrong makes the
 *     episode confidently one-sided with every sentence still sourced.
 *   - Claim extraction. Quote binding is exacting work and a sloppy span fails
 *     the ledger, which costs a whole re-run rather than a few pence.
 *   - Any beat, the hook choice, or the title. These are the show. A cheaper
 *     model here saves pennies and costs listeners, which is the wrong trade
 *     at any price.
 *   - Verification. Cheapening the check is how you end up publishing the
 *     thing the check exists to catch.
 *
 * Same family as the writer on purpose - it is doing the writer's clerical
 * work, not checking the writer. The verifier's independence is unaffected.
 */
export const clerkConfig = () => ({
  apiKey: required('ANTHROPIC_API_KEY'),
  model: process.env.FOUNDRY_CLERK_MODEL || 'claude-haiku-4-5',
});

/**
 * Which voice engine renders the audio.
 *
 * TWO PROVIDERS, FOR TWO DIFFERENT JOBS, and the distinction is worth being
 * explicit about because it is easy to read as "the cheap one and the good one"
 * and that is not quite it.
 *
 *   openai     drafting. Around fifteen pence an episode against roughly two
 *              pounds, so iterating on the WRITING is effectively free - and
 *              the writing is what decides whether a show is any good. No
 *              dialogue endpoint, so an exchange is rendered a turn at a time
 *              and joined, which sounds spliced.
 *   elevenlabs publishing. Renders the whole exchange in one request, which is
 *              what produces overlap, interruption and a reply that starts
 *              before the last line has landed.
 *
 * The seam between spliced turns is the single most reliable tell of generated
 * audio, and no amount of voice quality hides it. So drafting on openai costs
 * nothing and tells you almost everything; publishing on it would give away the
 * one thing the whole two-host design exists to avoid.
 *
 * Defaults to elevenlabs, because the safe direction for a default is the one
 * that is right at publish time. Set FOUNDRY_TTS=openai while drafting.
 */
/**
 * The screening verifier: a cheap first pass over the claims.
 *
 * Verification is thirty-odd calls asking one narrow question at temperature
 * zero, and most claims are clean. This model answers the clean ones; anything
 * it does not mark plainly entailed is re-asked of the real verifier, which
 * owns every decision that matters.
 *
 * A SCREEN THAT CAN ONLY ESCALATE. It has no authority to block and no
 * authority to overrule - its only power is to confirm a clean pass, so it can
 * never be the reason something wrong was published. The residual risk is a
 * false `entailed` standing, which is why it is the same family and the same
 * prompt as the verifier rather than something cheaper and different.
 *
 * Set FOUNDRY_SCREENER_MODEL to an empty string to turn it off and send every
 * claim straight to the strong model.
 */
export const screenerConfig = (): { apiKey: string; model: string } | null => {
  const model = process.env.FOUNDRY_SCREENER_MODEL ?? 'gpt-5-mini';
  if (!model.trim()) return null;
  return { apiKey: required('OPENAI_API_KEY'), model: model.trim() };
};

export const ttsProvider = (): 'elevenlabs' | 'openai' => {
  const value = (process.env.FOUNDRY_TTS || 'elevenlabs').trim().toLowerCase();
  if (value !== 'elevenlabs' && value !== 'openai') {
    throw new ConfigError('FOUNDRY_TTS', `must be "elevenlabs" or "openai", not "${value}"`);
  }
  return value;
};

export const ttsConfig = () => ({
  apiKey: required('ELEVENLABS_API_KEY'),
});

export const openAiTtsConfig = () => ({
  // The same key the verifier uses. One account, two products.
  apiKey: required('OPENAI_API_KEY'),
  model: process.env.FOUNDRY_TTS_MODEL || 'gpt-4o-mini-tts',
});
