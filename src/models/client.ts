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
  /**
   * 0 for anything being checked or scored. Judgement should not wander.
   *
   * A REQUEST, NOT A GUARANTEE. Models released after Claude Opus 4.6 reject
   * every value except 1, so on those this is dropped before the request is
   * sent rather than being sent and refused. See temperatureFor.
   */
  temperature?: number;
  /**
   * Cache the system prompt.
   *
   * THE LARGEST FREE SAVING IN THE PIPELINE. Writing one episode sends the same
   * system prompt ten to fifteen times - the show's canon, its taboos, its
   * style rules, the whole banned-phrase list, the cast and their speech
   * habits. That block is identical on every one of those calls and identical
   * across every episode of the show, and it is well over a thousand tokens.
   *
   * Caching is a PREFIX match, so this only works because the system prompt is
   * built from the persona alone and carries nothing per-request. Putting a
   * timestamp, a run id, or the beat name into it would invalidate the cache on
   * every call while looking like it still worked - the classic silent
   * invalidator. Everything that varies lives in `prompt`, which comes after.
   *
   * Off by default so a one-shot call does not pay the write premium for a
   * prefix nothing will read again.
   */
  cacheSystem?: boolean;
}

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costPence: number;
  model: string;
  /**
   * Tokens served from cache.
   *
   * Reported so a silent invalidator is discoverable. If this is zero across a
   * whole episode, the system prefix is changing between calls and the caching
   * is costing money rather than saving it.
   */
  cachedInputTokens?: number;
  /**
   * Whether the model stopped because it ran out of room.
   *
   * THE DIFFERENCE BETWEEN A USEFUL ERROR AND A BAFFLING ONE. A truncated
   * response is still a 200 with perfectly valid text in it - the text just
   * stops mid-sentence. Parsing it produces "unterminated JSON in model
   * output", which sends you looking for a prompt problem that does not exist.
   * The API says plainly that it hit the ceiling; this carries that through.
   */
  truncated?: boolean;
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

/**
 * Models that still accept a `temperature` other than 1.
 *
 * AN ALLOW-LIST, NOT A DENY-LIST, and the asymmetry is the whole point.
 * Omitting temperature from a model that would have accepted it costs a little
 * control. SENDING it to a model that rejects it is a 400 that kills the run -
 * which is exactly what happened: Sonnet 5 refuses every value except 1.0, and
 * the first real episode died on its first call, in the brief stage, having
 * already spent the search budget.
 *
 * So an unknown model gets no temperature. A new model is far more likely to
 * follow the newer rule than the older one, and being wrong in that direction
 * is survivable.
 *
 * WHAT IS LOST, stated plainly rather than quietly. This pipeline used
 * temperature deliberately: near zero for anything being judged or scored, high
 * for drafting, cooler on a revision than on a first attempt. On the Claude 5
 * family that lever no longer exists, so the hook chooser and the claim
 * extractor are no longer pinned to deterministic settings. The deterministic
 * checks around them - the quote existence check, the style scoring, the loop
 * and voice checks - are untouched, and they were always the ones doing the
 * real work.
 */
const TEMPERATURE_MODELS = [
  'claude-haiku-4-5',
  'claude-3-5',
  'claude-3-7',
  'gpt-4',
  'gpt-4o',
];

export const supportsTemperature = (model: string): boolean =>
  TEMPERATURE_MODELS.some((m) => model.startsWith(m));

/**
 * The temperature to send, or undefined to omit the field entirely.
 *
 * `1` is accepted everywhere for backwards compatibility, but it is also the
 * default, so asking for it explicitly buys nothing and is one more thing that
 * can be rejected later. Omitted is the safer shape.
 */
export const temperatureFor = (model: string, wanted?: number): number | undefined => {
  if (wanted === undefined) return undefined;
  if (!supportsTemperature(model)) return undefined;
  return wanted;
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
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  error?: { message?: string };
}

/**
 * Cache pricing multipliers against the ordinary input price.
 *
 * Writing a prefix costs a premium; reading one back is nearly free. Those
 * ratios are stable across the model line even as the absolute prices move,
 * which is why they live here as multipliers rather than as another price
 * table to fall out of date.
 *
 * The arithmetic that matters: a system prefix pays 1.25x once and 0.1x on
 * every call after. Writing one episode makes twelve calls sharing that prefix,
 * so the prefix costs 1.25 + 11 x 0.1 = 2.35 instead of 12. The break-even is
 * the second call.
 */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Cost when part of the input was cached.
 *
 * `inputTokens` here is the UNCACHED remainder, which is how Anthropic reports
 * it: input_tokens excludes both cache counters rather than including them.
 * Adding them together and then charging full price for the lot would report a
 * bill nobody was sent.
 */
export const costPenceWithCache = (
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number
): number => {
  const [inPrice, outPrice] = priceFor(model);
  const perInputToken = inPrice / 1_000_000;
  return (
    inputTokens * perInputToken +
    cacheWriteTokens * perInputToken * CACHE_WRITE_MULTIPLIER +
    cacheReadTokens * perInputToken * CACHE_READ_MULTIPLIER +
    (outputTokens / 1_000_000) * outPrice
  );
};

export class AnthropicClient implements LlmClient {
  readonly name = 'anthropic';

  constructor(
    readonly model: string,
    private apiKey: string,
    private post: HttpPost = nodeHttpPost
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    // A cached system prompt has to be sent as a BLOCK, because cache_control
    // attaches to a block and there is nowhere to hang it on a bare string.
    // Uncached calls keep sending the string, so the wire format only changes
    // where caching is actually asked for.
    const system = req.cacheSystem
      ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
      : req.system;

    const res = await this.post(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      {
        model: this.model,
        max_tokens: req.maxTokens ?? 4096,
        // Omitted entirely rather than defaulted. See temperatureFor.
        ...(temperatureFor(this.model, req.temperature) !== undefined
          ? { temperature: temperatureFor(this.model, req.temperature) }
          : {}),
        system,
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
    const cacheWrite = body.usage?.cache_creation_input_tokens ?? 0;
    const cacheRead = body.usage?.cache_read_input_tokens ?? 0;

    return {
      text,
      // Reported as the total the call actually consumed, so a budget line
      // still reads as tokens-in rather than tokens-in-except-the-cached-ones.
      // The COST below is the thing that has to be exact, and it prices each
      // bucket at its own rate.
      inputTokens: inputTokens + cacheWrite + cacheRead,
      outputTokens,
      costPence: costPenceWithCache(
        this.model,
        inputTokens,
        outputTokens,
        cacheWrite,
        cacheRead
      ),
      model: this.model,
      cachedInputTokens: cacheRead,
      truncated: body.stop_reason === 'max_tokens',
    };
  }
}

// ---------------------------------------------------------------------------
// OpenAI - the verifier
// ---------------------------------------------------------------------------

interface OpenAiShape {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
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
        // Same rule as the Anthropic client, for the same reason: the gpt-5
        // family rejects a non-default temperature too, and the verifier asks
        // for zero on every single claim.
        ...(temperatureFor(this.model, req.temperature) !== undefined
          ? { temperature: temperatureFor(this.model, req.temperature) }
          : {}),
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
      truncated: body.choices?.[0]?.finish_reason === 'length',
    };
  }
}

/**
 * Ask for JSON, and give the model more room if it ran out.
 *
 * WHY THIS EXISTS AS A SHARED HELPER. Every stage that wants structured output
 * has the same failure: the model writes valid JSON, hits the token ceiling
 * mid-string, and the parse fails with "unterminated JSON in model output". The
 * first real episode died this way in the brief stage - and the message sends
 * you hunting for a prompt problem that is not there.
 *
 * ONE RETRY, AT DOUBLE THE CEILING. Bounded on purpose: a loop that keeps
 * doubling would turn a genuinely runaway response into a genuinely runaway
 * bill. If twice the room is not enough, the ceiling was not the problem and
 * the error should say so rather than keep paying to find out.
 *
 * Only retries on TRUNCATION. A model that returned prose instead of JSON will
 * return prose again with more room, so retrying that is money for nothing.
 */
export const completeJson = async <T>(
  client: LlmClient,
  req: LlmRequest,
  onCost?: (pence: number) => void
): Promise<T> => {
  const first = await client.complete(req);
  onCost?.(first.costPence);

  if (!first.truncated) return extractJson<T>(first.text);

  const ceiling = (req.maxTokens ?? 4096) * 2;
  const second = await client.complete({ ...req, maxTokens: ceiling });
  onCost?.(second.costPence);

  if (second.truncated) {
    throw new LlmError(
      client.name,
      null,
      `ran out of room twice, at ${ceiling} tokens. The response is not too small a ` +
        `ceiling, it is too large a request - narrow what the prompt asks for.`
    );
  }

  return extractJson<T>(second.text);
};

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
  if (end <= start) {
    // Almost always truncation rather than a malformed reply, so the message
    // says which end to look at. Callers using completeJson have already
    // retried with more room by the time this is reached.
    throw new Error(
      `unterminated JSON in model output - the reply was almost certainly cut off ` +
        `by the token ceiling rather than malformed. Ends: ...${text.slice(-120)}`
    );
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch (err) {
    throw new Error(`invalid JSON from model: ${(err as Error).message}`);
  }
};
