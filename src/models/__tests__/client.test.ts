import { AnthropicClient, costPenceFor, extractJson, LlmError, OpenAiClient, priceFor } from '../client';

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
