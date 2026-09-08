/**
 * Talking to language models.
 *
 * ONE INTERFACE, TWO IMPLEMENTATIONS, AND THAT IS DELIBERATE. The writer and
 * the verifier must not be the same model family. A verifier sharing the
 * writer's priors reconstructs the writer's justification instead of checking
 * the text in front of it, which is exactly the failure the verification stage
 * exists to prevent. Keeping them behind one interface makes that swap trivial;
 * keeping them as separate configured clients makes it hard to collapse by
 * accident.
 *
 * EVERY CALL REPORTS ITS COST. The budget ceiling is only enforceable if each
 * call says what it spent, so cost is part of the return type rather than
 * something logged and forgotten. Prices are approximate and will drift; being
 * roughly right and visible beats being exactly right and absent.
 */

export interface LlmRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  /** 0 for anything being checked or scored. Judgement should not wander. */
  temperature?: number;
}

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costPence: number;
  model: string;
}

export interface LlmClient {
  readonly name: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * Approximate prices in pence per million tokens, [input, output].
 *
 * Unknown models fall back to the most expensive entry rather than to zero.
 * A budget that silently stops counting is worse than one that overestimates:
 * overestimating stops a run early and somebody looks, while counting nothing
 * lets a run spend without limit and nobody does.
 */
const PRICE_PENCE_PER_MTOK: Record<string, [number, number]> = {
  'claude-opus-5': [1200, 6000],
  'claude-sonnet-5': [240, 1200],
  'claude-haiku-4-5': [80, 320],
  'gpt-5': [1000, 4000],
  'gpt-5-mini': [200, 800],
};

const FALLBACK_PRICE: [number, number] = [1200, 6000];

export const priceFor = (model: string): [number, number] => {
  const exact = PRICE_PENCE_PER_MTOK[model];
  if (exact) return exact;
  // Match on prefix so a dated model id (claude-opus-5-20260101) still prices.
  const prefix = Object.keys(PRICE_PENCE_PER_MTOK).find((k) => model.startsWith(k));
  return prefix ? PRICE_PENCE_PER_MTOK[prefix]! : FALLBACK_PRICE;
};

export const costPenceFor = (model: string, inputTokens: number, outputTokens: number): number => {
  const [inPrice, outPrice] = priceFor(model);
  return (inputTokens / 1_000_000) * inPrice + (outputTokens / 1_000_000) * outPrice;
};

export class LlmError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null,
    message: string
  ) {
    super(`${provider}: ${message}`);
    this.name = 'LlmError';
  }
}

/** Injected so the unit suite never reaches the network. */
export type HttpPost = (
  url: string,
  headers: Record<string, string>,
  body: unknown
) => Promise<{ status: number; json: unknown; text: string }>;

export const nodeHttpPost: HttpPost = async (url, headers, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Left null; callers report the raw text, which is what an HTML error page
    // from a proxy looks like and is worth seeing verbatim.
  }
  return { status: res.status, json, text };
};

// ---------------------------------------------------------------------------
// Anthropic - the writer
// ---------------------------------------------------------------------------

interface AnthropicShape {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

export class AnthropicClient implements LlmClient {
  readonly name = 'anthropic';

  constructor(
    readonly model: string,
    private apiKey: string,
    private post: HttpPost = nodeHttpPost
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.post(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      {
        model: this.model,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 1,
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }],
      }
    );

    if (res.status < 200 || res.status >= 300) {
      const body = res.json as AnthropicShape | null;
      throw new LlmError('anthropic', res.status, body?.error?.message ?? res.text.slice(0, 300));
    }

    const body = res.json as AnthropicShape;
    const text = (body.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');

    if (!text.trim()) {
      throw new LlmError('anthropic', res.status, 'returned no text');
    }

    const inputTokens = body.usage?.input_tokens ?? 0;
    const outputTokens = body.usage?.output_tokens ?? 0;

    return {
      text,
      inputTokens,
      outputTokens,
      costPence: costPenceFor(this.model, inputTokens, outputTokens),
      model: this.model,
    };
  }
}

// ---------------------------------------------------------------------------
// OpenAI - the verifier
// ---------------------------------------------------------------------------

interface OpenAiShape {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OpenAiClient implements LlmClient {
  readonly name = 'openai';

  constructor(
    readonly model: string,
    private apiKey: string,
    private post: HttpPost = nodeHttpPost
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.post(
      'https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        max_completion_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 1,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
      }
    );

    if (res.status < 200 || res.status >= 300) {
      const body = res.json as OpenAiShape | null;
      throw new LlmError('openai', res.status, body?.error?.message ?? res.text.slice(0, 300));
    }

    const body = res.json as OpenAiShape;
    const text = body.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) {
      throw new LlmError('openai', res.status, 'returned no text');
    }

    const inputTokens = body.usage?.prompt_tokens ?? 0;
    const outputTokens = body.usage?.completion_tokens ?? 0;

    return {
      text,
      inputTokens,
      outputTokens,
      costPence: costPenceFor(this.model, inputTokens, outputTokens),
      model: this.model,
    };
  }
}

/**
 * Pull a JSON value out of a model response.
 *
 * Models wrap JSON in prose and fences however firmly they are told not to, and
 * failing a whole episode over a stray "Here you go:" would be its own kind of
 * absurd. Everything before the first brace or bracket and after the last is
 * discarded.
 */
export const extractJson = <T>(text: string): T => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();

  const start = candidate.search(/[[{]/);
  if (start < 0) throw new Error(`no JSON found in model output: ${text.slice(0, 200)}`);

  const opener = candidate[start];
  const closer = opener === '{' ? '}' : ']';
  const end = candidate.lastIndexOf(closer);
  if (end <= start) throw new Error(`unterminated JSON in model output: ${text.slice(0, 200)}`);

  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch (err) {
    throw new Error(`invalid JSON from model: ${(err as Error).message}`);
  }
};
