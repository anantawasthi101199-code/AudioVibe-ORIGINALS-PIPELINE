import {
  AnthropicClient,
  costPenceFor,
  costPenceWithCache,
  extractJson,
  LlmError,
  OpenAiClient,
  priceFor,
} from '../client';

const post = (status: number, json: unknown, text = '') => async () => ({ status, json, text });

describe('pricing', () => {
  it('prices a known model', () => {
    expect(priceFor('claude-opus-5')).toEqual([1200, 6000]);
  });

  it('prices a dated model id by prefix', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual([80, 320]);
  });

  it('falls back to the MOST expensive price for an unknown model', () => {
    // A budget that silently stops counting is worse than one that
    // overestimates: overestimating stops a run early and somebody looks,
    // counting nothing lets a run spend without limit and nobody does.
    expect(priceFor('some-new-model')).toEqual([1200, 6000]);
  });

  it('computes cost from token counts', () => {
    expect(costPenceFor('claude-haiku-4-5', 1_000_000, 1_000_000)).toBeCloseTo(400);
  });
});

describe('prompt caching', () => {
  // The single biggest saving in the pipeline, and the kind that fails
  // SILENTLY: a cache that stops hitting costs more than no cache at all while
  // every run still succeeds. So both the wire shape and the arithmetic are
  // pinned, and the run reports cached tokens so a regression is visible.

  const usageBody = (usage: Record<string, number>) => ({
    content: [{ type: 'text', text: 'hello' }],
    usage,
  });

  it('sends the system prompt as a plain string when caching is off', async () => {
    let sent: { system?: unknown } | null = null;
    const client = new AnthropicClient('claude-opus-5', 'k', async (_u, _h, body) => {
      sent = body as { system?: unknown };
      return { status: 200, json: usageBody({ input_tokens: 10, output_tokens: 5 }), text: '' };
    });

    await client.complete({ system: 'S', prompt: 'P' });
    expect(sent!.system).toBe('S');
  });

  it('sends the system prompt as a cache-controlled block when caching is on', async () => {
    let sent: { system?: unknown } | null = null;
    const client = new AnthropicClient('claude-opus-5', 'k', async (_u, _h, body) => {
      sent = body as { system?: unknown };
      return { status: 200, json: usageBody({ input_tokens: 10, output_tokens: 5 }), text: '' };
    });

    await client.complete({ system: 'S', prompt: 'P', cacheSystem: true });
    expect(sent!.system).toEqual([
      { type: 'text', text: 'S', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('prices a cache read at a fraction of an ordinary input token', async () => {
    const client = new AnthropicClient('claude-opus-5', 'k', async () => ({
      status: 200,
      json: usageBody({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
      }),
      text: '',
    }));

    const res = await client.complete({ system: 'S', prompt: 'P', cacheSystem: true });
    // A tenth of the 1200p/Mtok input price.
    expect(res.costPence).toBeCloseTo(120);
    expect(res.cachedInputTokens).toBe(1_000_000);
  });

  it('prices a cache write at a premium over an ordinary input token', async () => {
    const client = new AnthropicClient('claude-opus-5', 'k', async () => ({
      status: 200,
      json: usageBody({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
      }),
      text: '',
    }));

    const res = await client.complete({ system: 'S', prompt: 'P', cacheSystem: true });
    expect(res.costPence).toBeCloseTo(1500);
    // Nothing was READ from cache, so nothing is reported as cached. This is
    // what makes a silent invalidator findable: it writes forever and never
    // reads.
    expect(res.cachedInputTokens).toBe(0);
  });

  it('reports total input tokens including the cached ones', async () => {
    // The budget line should read as tokens consumed, not as
    // tokens-except-the-cached-ones, which would understate a run's size.
    const client = new AnthropicClient('claude-opus-5', 'k', async () => ({
      status: 200,
      json: usageBody({
        input_tokens: 100,
        output_tokens: 10,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
      }),
      text: '',
    }));

    const res = await client.complete({ system: 'S', prompt: 'P', cacheSystem: true });
    expect(res.inputTokens).toBe(600);
  });

  it('is cheaper than not caching from the second call onward', () => {
    // The claim the whole optimisation rests on, as arithmetic rather than as
    // a comment. One 2000-token prefix across twelve calls.
    const prefix = 2000;
    const calls = 12;

    const uncached = costPenceFor('claude-opus-5', prefix * calls, 0);
    const cached =
      costPenceWithCache('claude-opus-5', 0, 0, prefix, 0) +
      costPenceWithCache('claude-opus-5', 0, 0, 0, prefix * (calls - 1));

    expect(cached).toBeLessThan(uncached / 4);
  });

  it('costs MORE than not caching on a single call', () => {
    // Which is why cacheSystem is off by default: a one-shot call pays the
    // write premium for a prefix nothing will read back.
    const prefix = 2000;
    expect(costPenceWithCache('claude-opus-5', 0, 0, prefix, 0)).toBeGreaterThan(
      costPenceFor('claude-opus-5', prefix, 0)
    );
  });
});

describe('extractJson', () => {
  it('reads bare JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads JSON out of a fenced block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('reads JSON despite surrounding prose', () => {
    // Models add "Here you go:" however firmly told not to, and failing a whole
    // episode over it would be absurd.
    expect(extractJson('Here you go:\n{"a":1}\nHope that helps!')).toEqual({ a: 1 });
  });

  it('reads a top-level array', () => {
    expect(extractJson('[1,2]')).toEqual([1, 2]);
  });

  it('throws when there is no JSON at all', () => {
    expect(() => extractJson('I cannot do that')).toThrow(/no JSON found/);
  });

  it('throws on malformed JSON rather than returning something wrong', () => {
    expect(() => extractJson('{"a": }')).toThrow(/invalid JSON/);
  });
});

describe('AnthropicClient', () => {
  it('returns text, tokens and cost', async () => {
    const client = new AnthropicClient(
      'claude-opus-5',
      'k',
      post(200, {
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 1000, output_tokens: 500 },
      })
    );
    const res = await client.complete({ system: 's', prompt: 'p' });
    expect(res.text).toBe('hello');
    expect(res.costPence).toBeCloseTo((1000 / 1e6) * 1200 + (500 / 1e6) * 6000);
  });

  it('surfaces the provider error message', async () => {
    const client = new AnthropicClient('claude-opus-5', 'k', post(429, { error: { message: 'rate limited' } }));
    await expect(client.complete({ system: 's', prompt: 'p' })).rejects.toThrow(/rate limited/);
  });

  it('reports a non-JSON error body verbatim, which is what a proxy page looks like', async () => {
    const client = new AnthropicClient('claude-opus-5', 'k', post(502, null, '<html>Bad Gateway</html>'));
    await expect(client.complete({ system: 's', prompt: 'p' })).rejects.toThrow(/Bad Gateway/);
  });

  it('treats an empty completion as a failure', async () => {
    const client = new AnthropicClient('claude-opus-5', 'k', post(200, { content: [] }));
    await expect(client.complete({ system: 's', prompt: 'p' })).rejects.toThrow(LlmError);
  });
});

describe('OpenAiClient', () => {
  it('returns text, tokens and cost', async () => {
    const client = new OpenAiClient(
      'gpt-5',
      'k',
      post(200, {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 100 },
      })
    );
    const res = await client.complete({ system: 's', prompt: 'p' });
    expect(res.text).toBe('ok');
    expect(res.model).toBe('gpt-5');
  });

  it('surfaces the provider error message', async () => {
    const client = new OpenAiClient('gpt-5', 'k', post(400, { error: { message: 'bad request' } }));
    await expect(client.complete({ system: 's', prompt: 'p' })).rejects.toThrow(/bad request/);
  });
});
