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

export const writerConfig = () => ({
  apiKey: required('ANTHROPIC_API_KEY'),
  model: process.env.FOUNDRY_WRITER_MODEL || 'claude-opus-5',
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

export const ttsConfig = () => ({
  apiKey: required('ELEVENLABS_API_KEY'),
});
