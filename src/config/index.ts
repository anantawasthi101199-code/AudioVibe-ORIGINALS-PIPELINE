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

/**
 * Where the voice registry lives.
 *
 * Configurable for the same reason runs and bibles are: the test suite must not
 * write to the repo's real one. It did, on the first run after the registry
 * landed - the suite's fake provider pinned two shows to a voice called
 * "fake-tts" in a file that is committed.
 */
export const voicesFile = (): string => {
  const configured = process.env.FOUNDRY_VOICES_FILE || 'voices.json';
  return path.isAbsolute(configured) ? configured : path.join(repoRoot(), configured);
};

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
 * Where season plans live, one JSON file per show per season.
 *
 * SEPARATE FROM BIBLES, AND THE SEPARATION IS THE WHOLE DESIGN. A bible is
 * HISTORY: what a listener has already heard, which a later episode may not
 * contradict. A plan is INTENTION: what the season means to do, which a writer
 * must be allowed to abandon when the episode in front of it turns out better
 * than the card that described it.
 *
 * Collapsing the two would make the continuity check enforce an outline, and
 * bible.ts refuses that in its header for good reason. So the plan is checked
 * against the bible only to REPORT drift, never to block on it.
 */
export const seasonsDir = (): string => {
  const configured = process.env.FOUNDRY_SEASONS_DIR || 'seasons';
  return path.isAbsolute(configured) ? configured : path.join(repoRoot(), configured);
};

/**
 * HARD ceiling on what one episode may cost, in pence: £2 (owner, 2026-10-08).
 *
 * A run that would pass it stops rather than degrading. A cost overrun should
 * be visible as silence, which somebody notices, rather than as quietly worse
 * output, which nobody does until much later.
 *
 * TWO NUMBERS, NOT ONE. The target (episodeTargetPence) is what an episode is
 * tuned to cost and is only a warning; this is the line that actually stops a
 * run. They were the same number until a Business Decoded short voiced on
 * ElevenLabs passed its 15p target halfway through its voice and stopped there,
 * with nothing to listen to and nothing to press. FOUNDRY_EPISODE_BUDGET_PENCE
 * moves it.
 */
export const episodeBudgetPence = (): number => {
  const raw = process.env.FOUNDRY_EPISODE_BUDGET_PENCE;
  const n = raw ? Number(raw) : 200;
  return Number.isFinite(n) && n > 0 ? n : 200;
};

/**
 * HARD ceiling on what one short may cost, in pence: 50p (owner, 2026-10-08).
 * FOUNDRY_SHORT_BUDGET_PENCE moves it. See episodeBudgetPence.
 */
export const shortBudgetPence = (): number => {
  const raw = process.env.FOUNDRY_SHORT_BUDGET_PENCE;
  const n = raw ? Number(raw) : 50;
  return Number.isFinite(n) && n > 0 ? n : 50;
};

/**
 * What an episode is MEANT to cost: £1.20. Passing it is noted in the journal
 * and shown on the run's cost meter, and the run carries on to its ceiling.
 * Never above the ceiling, whatever the environment says.
 */
export const episodeTargetPence = (): number => {
  const raw = process.env.FOUNDRY_EPISODE_TARGET_PENCE;
  const n = raw ? Number(raw) : 120;
  return Math.min(Number.isFinite(n) && n > 0 ? n : 120, episodeBudgetPence());
};

/** What a short is MEANT to cost: 15p. A warning, never a stop. */
export const shortTargetPence = (): number => {
  const raw = process.env.FOUNDRY_SHORT_TARGET_PENCE;
  const n = raw ? Number(raw) : 15;
  return Math.min(Number.isFinite(n) && n > 0 ? n : 15, shortBudgetPence());
};

/**
 * What voicing again costs, allowed on top of the ceiling once per re-voice.
 * A script edited after it was voiced has to be voiced again, and a ceiling
 * that counted the first voicing against the second would make every edit
 * impossible to hear.
 */
export const REVOICE_ALLOWANCE_PENCE = { short: 5, long: 25 } as const;

/**
 * Which platform, and whether it is the real one.
 *
 * SEPARATE FROM THE INGEST TOKEN, because not everything that talks to the
 * platform publishes. Channel setup signs in with a password and never touches
 * the ingest credential, and demanding one anyway would be a prerequisite that
 * is not true - which is the kind of thing somebody satisfies by pasting in a
 * token that then sits in the environment of a command that had no business
 * holding it.
 */
export const platformUrl = (): { url: string; isProduction: boolean } => {
  const url = required('AUDIOVIBE_API_URL').replace(/\/+$/, '');

  // Loud, because publishing to the wrong environment is not something you can
  // take back: followers get notified, feeds cache, and the seen ledger records
  // it. Cheap to state, expensive to discover afterwards.
  return { url, isProduction: /api\.audiovibe\.co/i.test(url) };
};

export const platformConfig = () => ({
  ...platformUrl(),
  token: required('AUDIOVIBE_INGEST_TOKEN'),
});

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
 * IT TRADES CALLS FOR TOKENS, WHICH IS THE WRONG TRADE ON SOME ACCOUNTS. A
 * claim the screen passes costs one cheap call instead of one expensive one, so
 * it wins whenever tokens are the scarce thing. But a claim it ESCALATES costs
 * two calls instead of one - and on an account limited by requests per day
 * rather than by spend, that is straightforwardly worse. A real run hit
 * "gpt-5-mini ... requests per day: Limit 50, Used 50" for exactly this reason:
 * thirty-seven claims had become fifty-two calls.
 *
 * So: keep it when the bill is the constraint, turn it off when the call count
 * is. Turning it off is not a downgrade - every claim then goes straight to the
 * strong model, which is better verification and merely more expensive.
 *
 * Set FOUNDRY_SCREENER_MODEL to an empty string to turn it off and send every
 * claim straight to the strong model.
 */
/**
 * The OpenAI key on its own, for things that are not a chat model.
 *
 * Image generation needs the key and nothing else - no model default, no
 * temperature rules, none of what verifierConfig carries - and reaching for
 * verifierConfig to get at its apiKey would tie a channel's artwork to the
 * verification model's configuration for no reason.
 */
export const openAiConfig = (): { apiKey: string } => ({
  apiKey: required('OPENAI_API_KEY'),
});

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
