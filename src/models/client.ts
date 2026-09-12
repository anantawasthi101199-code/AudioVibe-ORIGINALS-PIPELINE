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

import { withRetry } from "./retry";

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
  /**
   * How much work the model should put into the whole response.
   *
   * THE CONTROL THAT REPLACED TEMPERATURE, and the one that actually matters
   * for cost. On Claude 5 the default is `high`, thinking is on, and THINKING
   * TOKENS COUNT AGAINST max_tokens - so a mechanical task with a modest
   * ceiling can spend its entire budget reasoning and return a response with no
   * text block in it at all. That is not a hypothetical: claim extraction did
   * exactly that, and the error was "returned no text", which explains nothing.
   *
   * Lower effort is therefore both cheaper AND more reliable for structured
   * work. Thinking is billed at output rates, so an extractor that reasons at
   * length about a JSON shape is paying premium rates to be less likely to
   * finish.
   *
   * Reach for `low` when the shape of the answer is already decided and the
   * model is filling it in; `medium` when it is making a judgement; leave it
   * unset for anything genuinely hard.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
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
  "claude-opus-5": [1200, 6000],
  "claude-sonnet-5": [240, 1200],
  "claude-haiku-4-5": [80, 320],
  "gpt-5": [1000, 4000],
  "gpt-5-mini": [200, 800],
};

const FALLBACK_PRICE: [number, number] = [1200, 6000];

export const priceFor = (model: string): [number, number] => {
  const exact = PRICE_PENCE_PER_MTOK[model];
  if (exact) return exact;
  // Match on prefix so a dated model id (claude-opus-5-20260101) still prices.
  const prefix = Object.keys(PRICE_PENCE_PER_MTOK).find((k) =>
    model.startsWith(k),
  );
  return prefix ? PRICE_PENCE_PER_MTOK[prefix]! : FALLBACK_PRICE;
};

export const costPenceFor = (
  model: string,
  inputTokens: number,
  outputTokens: number,
): number => {
  const [inPrice, outPrice] = priceFor(model);
  return (
    (inputTokens / 1_000_000) * inPrice + (outputTokens / 1_000_000) * outPrice
  );
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
  "claude-haiku-4-5",
  "claude-3-5",
  "claude-3-7",
  "gpt-4",
  "gpt-4o",
];

export const supportsTemperature = (model: string): boolean =>
  TEMPERATURE_MODELS.some((m) => model.startsWith(m));

/**
 * Models that accept `output_config.effort`.
 *
 * AN ALLOW-LIST AGAIN, and this one has a real gap in the middle of it:
 * claude-haiku-4-5 does NOT support effort, while both its neighbours in this
 * pipeline do. The clerk runs on Haiku, so a blanket "send effort to Anthropic
 * models" would 400 every counter-evidence query - which is a stage that fails
 * quietly into an empty query list rather than loudly.
 */
const EFFORT_MODELS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
];

export const supportsEffort = (model: string): boolean =>
  EFFORT_MODELS.some((m) => model.startsWith(m));

/**
 * OpenAI's equivalent of effort, under a different name and on a different set
 * of models.
 *
 * The gpt-5 family reasons before answering and those tokens come out of
 * max_completion_tokens, exactly as thinking does on Claude 5. Verification
 * asked for three hundred tokens per claim, which the screener spent entirely
 * on reasoning - returning a valid response with empty content, and the error
 * "openai: returned no text".
 *
 * Mapped from the same `effort` field so a call site expresses intent once and
 * each provider is handed the name it recognises. Allow-listed for the same
 * reason as everything else here: omitting it costs a default, sending it to a
 * model that does not take it kills the run.
 */
const REASONING_MODELS = ["gpt-5", "o1", "o3", "o4"];

export const supportsReasoningEffort = (model: string): boolean =>
  REASONING_MODELS.some((m) => model.startsWith(m));

/**
 * The temperature to send, or undefined to omit the field entirely.
 *
 * `1` is accepted everywhere for backwards compatibility, but it is also the
 * default, so asking for it explicitly buys nothing and is one more thing that
 * can be rejected later. Omitted is the safer shape.
 */
export const temperatureFor = (
  model: string,
  wanted?: number,
): number | undefined => {
  if (wanted === undefined) return undefined;
  if (!supportsTemperature(model)) return undefined;
  return wanted;
};

export class LlmError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null,
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = "LlmError";
  }
}

/** Injected so the unit suite never reaches the network. */
export type HttpPost = (
  url: string,
  headers: Record<string, string>,
  body: unknown,
) => Promise<{
  status: number;
  json: unknown;
  text: string;
  /** Response headers, lower-cased. Read for `retry-after`. */
  headers?: Record<string, string>;
}>;

export const nodeHttpPost: HttpPost = async (url, headers, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
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

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value;
  });

  return { status: res.status, json, text, headers: responseHeaders };
};

/**
 * Told when a call is waiting out a rate limit.
 *
 * Module-level rather than threaded through every client, because the thing
 * that needs to know is the terminal and the thing that knows is four layers
 * down. A run that goes silent for two minutes is indistinguishable from a
 * hang, and the reasonable response to a hang is to kill it - which on a rate
 * limit is the one wrong move, since the thing it was waiting for was about to
 * arrive.
 */
let waitReporter: ((message: string) => void) | null = null;

export const onProviderWait = (
  report: ((message: string) => void) | null,
): void => {
  waitReporter = report;
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
  cacheReadTokens: number,
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
  readonly name = "anthropic";

  constructor(
    readonly model: string,
    private apiKey: string,
    private post: HttpPost = nodeHttpPost,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    // A cached system prompt has to be sent as a BLOCK, because cache_control
    // attaches to a block and there is nowhere to hang it on a bare string.
    // Uncached calls keep sending the string, so the wire format only changes
    // where caching is actually asked for.
    const system = req.cacheSystem
      ? [
          {
            type: "text",
            text: req.system,
            cache_control: { type: "ephemeral" },
          },
        ]
      : req.system;

    const res = await withRetry(
      () =>
        this.post(
          "https://api.anthropic.com/v1/messages",
          { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
          {
            model: this.model,
            max_tokens: req.maxTokens ?? 4096,
            // Omitted entirely rather than defaulted. See temperatureFor.
            ...(temperatureFor(this.model, req.temperature) !== undefined
              ? { temperature: temperatureFor(this.model, req.temperature) }
              : {}),
            // Omitted where unsupported, for the same reason as temperature: the
            // cost of leaving it out is a default, the cost of sending it wrongly
            // is a dead run.
            ...(req.effort && supportsEffort(this.model)
              ? { output_config: { effort: req.effort } }
              : {}),
            system,
            messages: [{ role: "user", content: req.prompt }],
          },
        ),
      { onWait: (m) => waitReporter?.(`anthropic: ${m}`) },
    );

    if (res.status < 200 || res.status >= 300) {
      const body = res.json as AnthropicShape | null;
      throw new LlmError(
        "anthropic",
        res.status,
        body?.error?.message ?? res.text.slice(0, 300),
      );
    }

    const body = res.json as AnthropicShape;
    const text = (body.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");

    // NO TEXT IS ALMOST ALWAYS THINKING THAT ATE THE BUDGET. Thinking tokens
    // count against max_tokens, so a model that reasons up to the ceiling
    // returns content blocks with no text block among them. Reported as
    // truncation rather than thrown, so completeJson retries with more room -
    // "returned no text" explained nothing and killed a run that a second
    // attempt would have completed.
    const ranOut = body.stop_reason === "max_tokens";

    if (!text.trim() && !ranOut) {
      throw new LlmError("anthropic", res.status, "returned no text");
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
        cacheRead,
      ),
      model: this.model,
      cachedInputTokens: cacheRead,
      truncated: ranOut,
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
  readonly name = "openai";

  constructor(
    readonly model: string,
    private apiKey: string,
    private post: HttpPost = nodeHttpPost,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await withRetry(
      () =>
        this.post(
          "https://api.openai.com/v1/chat/completions",
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
            // `effort` in, `reasoning_effort` out. Same intent, provider's name.
            // `high` is dropped rather than sent, because it is the default and
            // sending a default buys nothing while being one more value that can
            // be rejected later.
            ...(req.effort &&
            req.effort !== "high" &&
            supportsReasoningEffort(this.model)
              ? {
                  reasoning_effort:
                    req.effort === "max" || req.effort === "xhigh"
                      ? "high"
                      : req.effort,
                }
              : {}),
            messages: [
              { role: "system", content: req.system },
              { role: "user", content: req.prompt },
            ],
          },
        ),
      { onWait: (m) => waitReporter?.(`openai: ${m}`) },
    );

    if (res.status < 200 || res.status >= 300) {
      const body = res.json as OpenAiShape | null;
      throw new LlmError(
        "openai",
        res.status,
        body?.error?.message ?? res.text.slice(0, 300),
      );
    }

    const body = res.json as OpenAiShape;
    const text = body.choices?.[0]?.message?.content ?? "";

    // EMPTY CONTENT IS ALMOST ALWAYS REASONING THAT ATE THE BUDGET, the exact
    // mirror of the Claude case. Reported as truncation rather than thrown, so
    // callers can give it more room - "returned no text" explained nothing and
    // killed a run on the first of thirty-five claims.
    const ranOut = body.choices?.[0]?.finish_reason === "length";

    if (!text.trim() && !ranOut) {
      throw new LlmError("openai", res.status, "returned no text");
    }

    const inputTokens = body.usage?.prompt_tokens ?? 0;
    const outputTokens = body.usage?.completion_tokens ?? 0;

    return {
      text,
      inputTokens,
      outputTokens,
      costPence: costPenceFor(this.model, inputTokens, outputTokens),
      model: this.model,
      truncated: ranOut,
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
/**
 * Optional shape check, with its own repair.
 *
 * SYNTACTICALLY VALID AND STRUCTURALLY WRONG IS A THIRD FAILURE, distinct from
 * truncated and from malformed, and until a real run hit it nothing retried it.
 * A beat came back as perfectly good JSON with no `turns` key in it, and the
 * only thing anybody saw was a bare Zod path - no sight of what the model
 * actually returned, and no second attempt.
 *
 * It is worth one retry for the same reason malformed JSON is: the model
 * understood the task and got the container wrong, and handing back the schema
 * complaint with what it produced fixes it almost every time. It is NOT worth
 * more than one, because a model that ignores the shape twice is being asked
 * for something the prompt has not made clear, and a third call will not
 * discover that.
 */
export interface JsonShape<T> {
  parse: (value: unknown) => T;
  /** What to call it in the error, so a failure says which call went wrong. */
  label: string;
}

export const completeJson = async <T>(
  client: LlmClient,
  req: LlmRequest,
  onCost?: (pence: number) => void,
  shape?: JsonShape<T>,
): Promise<T> => {
  const first = await client.complete(req);
  onCost?.(first.costPence);

  if (!first.truncated) {
    try {
      return await checkShape<T>(client, req, extractJson<T>(first.text), shape, onCost);
    } catch (err) {
      if (!(err instanceof JsonExtractError) || !err.repairable) throw err;
      // MALFORMED IS A DIFFERENT PROBLEM FROM TRUNCATED and needs a different
      // retry. The commonest cause is an unescaped quotation mark inside a
      // string, which a show that quotes documents out loud produces constantly
      // - and no amount of extra room fixes it, because the reply was complete,
      // it was simply invalid.
      return await repairJson<T>(client, req, first.text, (err as Error).message, onCost);
    }
  }

  // A truncated reply with no text at all is thinking that consumed the whole
  // ceiling. Doubling the room is the right response to both shapes.
  const ceiling = (req.maxTokens ?? 4096) * 2;
  const second = await client.complete({ ...req, maxTokens: ceiling });
  onCost?.(second.costPence);

  if (second.truncated) {
    throw new LlmError(
      client.name,
      null,
      `ran out of room twice, at ${ceiling} tokens${second.text.trim() ? "" : " with no text at all"}. ` +
        `Either the request asks for too much, or the model is thinking past its ceiling - ` +
        `lower the effort on this call, or narrow what the prompt asks for.`,
    );
  }

  try {
    return await checkShape<T>(client, req, extractJson<T>(second.text), shape, onCost);
  } catch (err) {
    if (!(err instanceof JsonExtractError) || !err.repairable) throw err;
    return await repairJson<T>(client, req, second.text, (err as Error).message, onCost);
  }
};

/**
 * Validate against the caller's schema, and ask again once if the shape is
 * wrong.
 *
 * The retry re-runs the ORIGINAL request with the complaint appended, rather
 * than asking the model to fix its own output. A wrong shape usually means the
 * task was misread, and re-reading the task with the mistake named is more
 * likely to work than editing the mistake.
 */
const checkShape = async <T>(
  client: LlmClient,
  req: LlmRequest,
  value: T,
  shape: JsonShape<T> | undefined,
  onCost?: (pence: number) => void,
): Promise<T> => {
  if (!shape) return value;

  try {
    return shape.parse(value);
  } catch (err) {
    const complaint = (err as Error).message.replace(/\s+/g, ' ').slice(0, 400);

    const retry = await client.complete({
      ...req,
      prompt:
        `${req.prompt}\n\n` +
        `YOUR PREVIOUS REPLY WAS VALID JSON BUT THE WRONG SHAPE.\n` +
        `What was wrong: ${complaint}\n` +
        `What you returned: ${JSON.stringify(value).slice(0, 400)}\n\n` +
        `Return the same content in the shape the instructions ask for. ` +
        `Every field named there is required.`,
    });
    onCost?.(retry.costPence);

    try {
      return shape.parse(extractJson<T>(retry.text));
    } catch (again) {
      throw new LlmError(
        client.name,
        null,
        `returned the wrong shape for ${shape.label} twice. ` +
          `${(again as Error).message.replace(/\s+/g, ' ').slice(0, 300)}. ` +
          `It returned: ${JSON.stringify(extractJsonSafe(retry.text)).slice(0, 300)}`,
      );
    }
  }
};

/** For an error message. Never throws, because it is reporting one. */
const extractJsonSafe = (text: string): unknown => {
  try {
    return extractJson(text);
  } catch {
    return text.slice(0, 300);
  }
};

/**
 * Hand a broken reply back and ask for it again, properly.
 *
 * ONE ATTEMPT, AND IT IS A REPAIR RATHER THAN A RE-RUN. The work is already in
 * the text; asking for it again from scratch would throw that away and cost the
 * same a second time. What is wrong is the encoding, not the content.
 *
 * The parser's own complaint goes back with it. Asking blind - "return valid
 * JSON" - mostly does not work, because the model cannot see what it got wrong;
 * telling it the position and the expectation mostly does.
 *
 * Deliberately low effort. Fixing an escape is not a thinking problem, and on a
 * model that reasons by default it would become one, consuming the ceiling
 * before reaching the answer.
 */
const repairJson = async <T>(
  client: LlmClient,
  original: LlmRequest,
  broken: string,
  complaint: string,
  onCost?: (pence: number) => void,
): Promise<T> => {
  const res = await client.complete({
    system:
      'You fix malformed JSON. You are given a document that was meant to be JSON ' +
      'and the parser error it produced. Return the SAME content as valid JSON, ' +
      'changing nothing except what is needed to make it parse.\n\n' +
      'The usual cause is an unescaped quotation mark, backslash or newline inside ' +
      'a string value. Escape them. Do not summarise, shorten or rewrite any text, ' +
      'and do not drop any field.\n\n' +
      'Return JSON only.',
    prompt: `PARSER SAID: ${complaint}\n\nDOCUMENT:\n${broken}`,
    temperature: 0,
    effort: 'low',
    maxTokens: Math.max(original.maxTokens ?? 4096, 4096),
  });
  onCost?.(res.costPence);

  try {
    return extractJson<T>(res.text);
  } catch (err) {
    throw new LlmError(
      client.name,
      null,
      `returned JSON that would not parse, and the repair attempt did not fix it: ` +
        `${(err as Error).message}`,
    );
  }
};

/**
 * Pull a JSON value out of a model response.
 *
 * Models wrap JSON in prose and fences however firmly they are told not to, and
 * failing a whole episode over a stray "Here you go:" would be its own kind of
 * absurd. Everything before the first brace or bracket and after the last is
 * discarded.
 */
/**
 * A reply that was meant to be JSON and was not.
 *
 * `repairable` is the distinction that decides whether a second call is worth
 * making. JSON that was FOUND and would not parse is an encoding problem - an
 * unescaped quote, a stray newline - and handing it back with the parser's own
 * complaint fixes it almost every time. A reply with no JSON in it at all is a
 * model that answered in prose, and it will answer in prose again.
 */
export class JsonExtractError extends Error {
  constructor(
    message: string,
    readonly repairable: boolean,
  ) {
    super(message);
    this.name = 'JsonExtractError';
  }
}

export const extractJson = <T>(text: string): T => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();

  const start = candidate.search(/[[{]/);
  // No JSON at all: the model answered in prose. NOT repairable - it will
  // answer in prose again, and a repair call would be money for nothing.
  if (start < 0) {
    throw new JsonExtractError(`no JSON found in model output: ${text.slice(0, 200)}`, false);
  }

  const opener = candidate[start];
  const closer = opener === "{" ? "}" : "]";
  const end = candidate.lastIndexOf(closer);
  if (end <= start) {
    // Almost always truncation rather than a malformed reply, so the message
    // says which end to look at. Callers using completeJson have already
    // retried with more room by the time this is reached, so a repair would
    // not help either.
    throw new JsonExtractError(
      `unterminated JSON in model output - the reply was almost certainly cut off ` +
        `by the token ceiling rather than malformed. Ends: ...${text.slice(-120)}`,
      false,
    );
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch (err) {
    // Found, but will not parse. Almost always an unescaped quotation mark
    // inside a string, which a show that quotes documents out loud produces
    // constantly. Worth exactly one repair.
    throw new JsonExtractError(`invalid JSON from model: ${(err as Error).message}`, true);
  }
};
