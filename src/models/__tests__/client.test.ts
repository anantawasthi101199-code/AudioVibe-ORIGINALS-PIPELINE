import type { LlmRequest } from '../client';
import { setSleep } from '../retry';
import {
  AnthropicClient,
  completeJson,
  costPenceFor,
  costPenceWithCache,
  extractJson,
  LlmError,
  OpenAiClient,
  priceFor,
  supportsEffort,
  supportsTemperature,
} from '../client';

const post = (status: number, json: unknown, text = '') => async () => ({ status, json, text });

// Retries are real, so a 429 or a 502 in any test below would wait out an
// actual backoff. Replaced wholesale rather than per test, because the
// alternative is quietly rewriting tests to use statuses that are never
// retried - which tests the wrong thing to keep the suite fast.
beforeAll(() => setSleep(async () => undefined));
afterAll(() => setSleep(null));

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

describe('completeJson', () => {
  // THE BUG THAT KILLED THE SECOND REAL EPISODE. A truncated reply is a 200
  // with perfectly valid text that simply stops mid-string, so the parse fails
  // with "unterminated JSON" and sends you hunting for a prompt problem that
  // is not there. The API says plainly that it hit the ceiling.

  const client = (replies: Array<{ text: string; truncated?: boolean }>) => {
    const seen: LlmRequest[] = [];
    let i = 0;
    return {
      seen,
      client: {
        name: 'fake',
        model: 'm',
        async complete(req: LlmRequest): Promise<LlmResponse> {
          seen.push(req);
          const r = replies[Math.min(i++, replies.length - 1)]!;
          return {
            text: r.text,
            inputTokens: 1,
            outputTokens: 1,
            costPence: 1,
            model: 'm',
            truncated: r.truncated,
          };
        },
      } as LlmClient,
    };
  };

  it('parses a complete reply without a second call', async () => {
    const c = client([{ text: '{"a":1}' }]);
    expect(await completeJson(c.client, { system: 'S', prompt: 'P' })).toEqual({ a: 1 });
    expect(c.seen).toHaveLength(1);
  });

  it('RETRIES with double the room when the reply was cut off', async () => {
    const c = client([
      { text: '{"angle":"the North Berwick trials as reconst', truncated: true },
      { text: '{"angle":"done"}' },
    ]);

    const out = await completeJson(c.client, { system: 'S', prompt: 'P', maxTokens: 1500 });

    expect(out).toEqual({ angle: 'done' });
    expect(c.seen[1]!.maxTokens).toBe(3000);
  });

  it('gives up after ONE retry rather than doubling forever', async () => {
    // A loop that kept doubling would turn a runaway response into a runaway
    // bill. If twice the room is not enough, the ceiling was not the problem.
    const c = client([{ text: '{"a":', truncated: true }]);

    await expect(completeJson(c.client, { system: 'S', prompt: 'P' })).rejects.toThrow(
      /ran out of room twice/
    );
    expect(c.seen).toHaveLength(2);
  });

  it('does NOT retry a reply with no JSON in it at all', async () => {
    // A model that answered in prose answers in prose again. Repairing that is
    // money for nothing, which is why "repairable" is a property of the error
    // rather than a blanket retry.
    const c = client([{ text: 'I am afraid I cannot do that' }]);

    await expect(completeJson(c.client, { system: 'S', prompt: 'P' })).rejects.toThrow(
      /no JSON found/
    );
    expect(c.seen).toHaveLength(1);
  });

  it('REPAIRS JSON that was found but would not parse', async () => {
    // The commonest cause is an unescaped quotation mark inside a string, which
    // a show that quotes documents out loud produces constantly. No amount of
    // extra room fixes it - the reply was complete, it was simply invalid.
    const c = client([
      { text: '{"text": "the record says "witches" were tried"}' },
      { text: '{"text": "the record says \\"witches\\" were tried"}' },
    ]);

    const out = await completeJson<{ text: string }>(c.client, { system: 'S', prompt: 'P' });
    expect(out.text).toContain('witches');
    expect(c.seen).toHaveLength(2);
  });

  it('hands the parser complaint back, not just an order to try again', async () => {
    // Asking blind mostly does not work, because the model cannot see what it
    // got wrong. Telling it the position and the expectation mostly does.
    const c = client([
      { text: '{"a": "b" "c"}' },
      { text: '{"a": "b"}' },
    ]);

    await completeJson(c.client, { system: 'S', prompt: 'P' });
    expect(c.seen[1]!.prompt).toMatch(/PARSER SAID:/);
    expect(c.seen[1]!.prompt).toContain('{"a": "b" "c"}');
  });

  it('repairs at LOW effort, because escaping is not a thinking problem', async () => {
    const c = client([{ text: '{"a": "b" "c"}' }, { text: '{"a": "b"}' }]);
    await completeJson(c.client, { system: 'S', prompt: 'P' });
    expect(c.seen[1]!.effort).toBe('low');
  });

  it('gives up if the repair does not fix it', async () => {
    const c = client([{ text: '{"a": "b" "c"}' }, { text: '{"still": "broken" "x"}' }]);
    await expect(completeJson(c.client, { system: 'S', prompt: 'P' })).rejects.toThrow(
      /repair attempt did not fix it/
    );
    expect(c.seen).toHaveLength(2);
  });

  it('RETRIES a reply that is valid JSON in the wrong shape', async () => {
    // The third kind of failure: not truncated, not malformed, just missing the
    // field. A real beat came back as perfectly good JSON with no "turns" key
    // and nothing retried it - all anybody saw was a bare Zod path.
    const c = client([{ text: '{"beats": []}' }, { text: '{"turns": ["a"]}' }]);
    const shape = {
      parse: (v: unknown) => {
        const o = v as { turns?: string[] };
        if (!o.turns) throw new Error('turns: Required');
        return o as { turns: string[] };
      },
      label: 'a beat',
    };

    const out = await completeJson(c.client, { system: 'S', prompt: 'P' }, undefined, shape);
    expect(out.turns).toEqual(['a']);
    expect(c.seen).toHaveLength(2);
  });

  it('re-asks the ORIGINAL question with the complaint, not "fix your output"', async () => {
    // A wrong shape usually means the task was misread. Re-reading the task
    // with the mistake named works better than editing the mistake.
    const c = client([{ text: '{"wrong": 1}' }, { text: '{"turns": ["a"]}' }]);
    const shape = {
      parse: (v: unknown) => {
        const o = v as { turns?: string[] };
        if (!o.turns) throw new Error('turns: Required');
        return o as { turns: string[] };
      },
      label: 'a beat',
    };

    await completeJson(c.client, { system: 'S', prompt: 'ORIGINAL TASK' }, undefined, shape);
    expect(c.seen[1]!.prompt).toContain('ORIGINAL TASK');
    expect(c.seen[1]!.prompt).toContain('turns: Required');
    expect(c.seen[1]!.prompt).toContain('{"wrong":1}');
  });

  it('gives up after one shape retry, and says what it got', async () => {
    const c = client([{ text: '{"wrong": 1}' }]);
    const shape = {
      parse: (v: unknown) => {
        const o = v as { turns?: string[] };
        if (!o.turns) throw new Error('turns: Required');
        return o as { turns: string[] };
      },
      label: 'the "before" beat',
    };

    await expect(
      completeJson(c.client, { system: 'S', prompt: 'P' }, undefined, shape)
    ).rejects.toThrow(/wrong shape for the "before" beat twice.*It returned/s);
    expect(c.seen).toHaveLength(2);
  });

  it('does not check a shape nobody asked for', async () => {
    const c = client([{ text: '{"anything": true}' }]);
    await expect(completeJson(c.client, { system: 'S', prompt: 'P' })).resolves.toEqual({
      anything: true,
    });
  });

  it('counts the repair toward the budget', async () => {
    let spent = 0;
    const c = client([{ text: '{"a": "b" "c"}' }, { text: '{"a": "b"}' }]);
    await completeJson(c.client, { system: 'S', prompt: 'P' }, (p) => (spent += p));
    expect(spent).toBe(2);
  });

  it('counts BOTH calls toward the budget', async () => {
    let spent = 0;
    const c = client([{ text: '{', truncated: true }, { text: '{"a":1}' }]);
    await completeJson(c.client, { system: 'S', prompt: 'P' }, (p) => (spent += p));
    expect(spent).toBe(2);
  });

  it('says the reply was cut off, not that it was malformed', async () => {
    expect(() => extractJson('{"angle":"the trials as reconst')).toThrow(/cut off/);
  });
});

describe('temperature', () => {
  // THE BUG THAT KILLED THE FIRST REAL EPISODE. Sonnet 5 rejects every value
  // except 1 with a 400, and the client sent 0.7 on the very first call of the
  // run - in the brief stage, after the search budget had already gone.

  const body = (usage = { input_tokens: 1, output_tokens: 1 }) => ({
    content: [{ type: 'text', text: 'hi' }],
    usage,
  });

  const sentBy = async (model: string, temperature?: number) => {
    let sent: Record<string, unknown> = {};
    const client = new AnthropicClient(model, 'k', async (_u, _h, b) => {
      sent = b as Record<string, unknown>;
      return { status: 200, json: body(), text: '' };
    });
    await client.complete({ system: 'S', prompt: 'P', temperature });
    return sent;
  };

  it('OMITS temperature on a model that rejects it', async () => {
    expect(await sentBy('claude-sonnet-5', 0.7)).not.toHaveProperty('temperature');
    expect(await sentBy('claude-opus-5', 0)).not.toHaveProperty('temperature');
  });

  it('omits it on an UNKNOWN model, because that is the survivable direction', async () => {
    // Omitting from a model that would have accepted it costs a little
    // control. Sending to one that rejects it kills the run.
    expect(await sentBy('claude-some-future-6', 0.3)).not.toHaveProperty('temperature');
  });

  it('still sends it where it works', async () => {
    expect(await sentBy('claude-haiku-4-5', 0.2)).toMatchObject({ temperature: 0.2 });
  });

  it('sends nothing when the caller asked for nothing', async () => {
    expect(await sentBy('claude-haiku-4-5')).not.toHaveProperty('temperature');
  });

  it('applies the same rule to the OpenAI client', async () => {
    // The verifier asks for zero on every single claim, so getting this wrong
    // would 400 thirty times in a row.
    let sent: Record<string, unknown> = {};
    const client = new OpenAiClient('gpt-5', 'k', async (_u, _h, b) => {
      sent = b as Record<string, unknown>;
      return { status: 200, json: { choices: [{ message: { content: 'x' } }] }, text: '' };
    });
    await client.complete({ system: 'S', prompt: 'P', temperature: 0 });
    expect(sent).not.toHaveProperty('temperature');
  });

  it('knows which models still take one', () => {
    expect(supportsTemperature('claude-haiku-4-5-20251001')).toBe(true);
    expect(supportsTemperature('claude-sonnet-5')).toBe(false);
    expect(supportsTemperature('gpt-5-mini')).toBe(false);
  });
});

describe('effort', () => {
  // THE BUG THAT KILLED THE THIRD REAL EPISODE, with the least helpful error
  // message of the three: "returned no text". On Claude 5 the default effort is
  // high, thinking is on, and thinking tokens count against max_tokens - so a
  // mechanical task with a modest ceiling can spend its whole budget reasoning
  // and come back with content blocks and no text block among them.

  const reply = (over: Record<string, unknown> = {}) => ({
    content: [{ type: 'text', text: 'hi' }],
    usage: { input_tokens: 1, output_tokens: 1 },
    ...over,
  });

  const sentBy = async (model: string, effort?: LlmRequest['effort']) => {
    let sent: Record<string, unknown> = {};
    const client = new AnthropicClient(model, 'k', async (_u, _h, b) => {
      sent = b as Record<string, unknown>;
      return { status: 200, json: reply(), text: '' };
    });
    await client.complete({ system: 'S', prompt: 'P', effort });
    return sent;
  };

  it('sends output_config on a model that supports it', async () => {
    expect(await sentBy('claude-sonnet-5', 'low')).toMatchObject({
      output_config: { effort: 'low' },
    });
  });

  it('OMITS it on claude-haiku-4-5, which does not take the parameter', async () => {
    // The gap in the middle of the allow-list. The clerk runs on Haiku, so a
    // blanket "send effort to Anthropic models" would 400 every
    // counter-evidence query - a stage that fails quietly into an empty query
    // list rather than loudly.
    expect(await sentBy('claude-haiku-4-5', 'low')).not.toHaveProperty('output_config');
  });

  it('omits it on an unknown model', async () => {
    expect(await sentBy('claude-something-7', 'low')).not.toHaveProperty('output_config');
  });

  it('sends nothing when no effort was asked for', async () => {
    expect(await sentBy('claude-sonnet-5')).not.toHaveProperty('output_config');
  });

  it('treats a reply with NO TEXT as truncation, not as a failure', async () => {
    // So completeJson retries with more room. Thrown, it killed a run that a
    // second attempt would have finished.
    const client = new AnthropicClient('claude-sonnet-5', 'k', async () => ({
      status: 200,
      json: reply({ content: [{ type: 'thinking', thinking: '...' }], stop_reason: 'max_tokens' }),
      text: '',
    }));

    const res = await client.complete({ system: 'S', prompt: 'P' });
    expect(res.truncated).toBe(true);
    expect(res.text).toBe('');
  });

  it('still fails loudly on an empty reply that did NOT run out of room', async () => {
    // That one is a real anomaly and more room would not fix it.
    const client = new AnthropicClient('claude-sonnet-5', 'k', async () => ({
      status: 200,
      json: reply({ content: [], stop_reason: 'end_turn' }),
      text: '',
    }));

    await expect(client.complete({ system: 'S', prompt: 'P' })).rejects.toThrow(/no text/);
  });

  it('maps effort to reasoning_effort for the gpt-5 family', async () => {
    // Same intent expressed once at the call site, each provider handed the
    // name it recognises.
    let sent: Record<string, unknown> = {};
    const client = new OpenAiClient('gpt-5-mini', 'k', async (_u, _h, b) => {
      sent = b as Record<string, unknown>;
      return { status: 200, json: { choices: [{ message: { content: 'x' } }] }, text: '' };
    });

    await client.complete({ system: 'S', prompt: 'P', effort: 'low' });
    expect(sent.reasoning_effort).toBe('low');
    expect(sent).not.toHaveProperty('output_config');
  });

  it('does not send reasoning_effort to a model that does not reason', async () => {
    let sent: Record<string, unknown> = {};
    const client = new OpenAiClient('gpt-4o', 'k', async (_u, _h, b) => {
      sent = b as Record<string, unknown>;
      return { status: 200, json: { choices: [{ message: { content: 'x' } }] }, text: '' };
    });

    await client.complete({ system: 'S', prompt: 'P', effort: 'low' });
    expect(sent).not.toHaveProperty('reasoning_effort');
  });

  it('treats EMPTY OpenAI content as truncation, not as a failure', async () => {
    // The mirror of the Claude case: reasoning tokens come out of
    // max_completion_tokens, so a tight ceiling returns a valid response with
    // nothing in it. Thrown, it killed a run on the first of thirty-five
    // claims.
    const client = new OpenAiClient('gpt-5-mini', 'k', async () => ({
      status: 200,
      json: { choices: [{ message: { content: '' }, finish_reason: 'length' }] },
      text: '',
    }));

    const res = await client.complete({ system: 'S', prompt: 'P' });
    expect(res.truncated).toBe(true);
  });

  it('still fails loudly on empty content that did NOT run out of room', async () => {
    const client = new OpenAiClient('gpt-5-mini', 'k', async () => ({
      status: 200,
      json: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] },
      text: '',
    }));

    await expect(client.complete({ system: 'S', prompt: 'P' })).rejects.toThrow(/no text/);
  });

  it('knows which models take an effort', () => {
    expect(supportsEffort('claude-sonnet-5')).toBe(true);
    expect(supportsEffort('claude-opus-5')).toBe(true);
    expect(supportsEffort('claude-haiku-4-5')).toBe(false);
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

  it('recovers when a stray bracket comes before the object', () => {
    // A beat came back beginning "[before]", copied from a label in its own
    // prompt, and the parse started there rather than at the object two lines
    // down. Taking the first bracket of either kind is right most of the time
    // and wrong in exactly this way.
    expect(extractJson('[before]\n{"turns":[{"speaker":"a","text":"x"}]}')).toEqual({
      turns: [{ speaker: 'a', text: 'x' }],
    });
  });

  it('still reads a top-level array when that is genuinely what was sent', () => {
    // The recovery must not break the case it is guarding, which is why it only
    // runs after the ordinary parse has failed.
    expect(extractJson('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
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
