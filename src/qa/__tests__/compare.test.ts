/**
 * A judge that is not controlled for bias is not a measurement. These tests are
 * almost entirely about the controls rather than about the judging.
 */
import { LlmClient, LlmRequest, LlmResponse } from '../../models/client';
import { compare, Contender, formatComparison } from '../compare';

const A: Contender = { label: 'run-a', title: 'The Thursday Column', text: 'Script A text.' };
const B: Contender = { label: 'run-b', title: 'The Friday Column', text: 'Script B text.' };

const judge = (
  reply: string | ((r: LlmRequest, n: number) => string)
): LlmClient & { seen: LlmRequest[] } => {
  const seen: LlmRequest[] = [];
  return {
    name: 'fake',
    model: 'fake-judge-1',
    seen,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const n = seen.length;
      seen.push(req);
      return {
        text: typeof reply === 'function' ? reply(req, n) : reply,
        inputTokens: 10,
        outputTokens: 5,
        costPence: 0.05,
        model: 'fake-judge-1',
      };
    },
  };
};

describe('compare', () => {
  it('asks BOTH orderings', () => {
    // Position bias makes judges favour whichever came first, independently of
    // quality. Asking once measures the order as much as the writing.
    return compare(A, B, judge('{"winner":"A","reason":"sharper open"}')).then((r) => {
      expect(r.forward).toBe('a');
      expect(r.reversed).toBe('b');
      expect(r.outcome).toBe('tie');
    });
  });

  it('reports a winner when both orderings agree', async () => {
    // A wins whichever position it is in: forward says A, reversed says B
    // (which is A in that ordering).
    const j = judge((req) =>
      req.prompt.indexOf('Script A text.') < req.prompt.indexOf('Script B text.')
        ? '{"winner":"A","reason":"more specific"}'
        : '{"winner":"B","reason":"more specific"}'
    );
    const r = await compare(A, B, j);
    expect(r.outcome).toBe('a');
    expect(r.reason).toBe('more specific');
  });

  it('records BOTH verdicts, so the disagreement rate stays visible', async () => {
    // If most pairs disagree the judge is measuring nothing, and that should be
    // discoverable rather than hidden behind a tie.
    const r = await compare(A, B, judge('{"winner":"A","reason":"x"}'));
    expect(r.forward).not.toBe(r.reversed);
    expect(r.reason).toMatch(/orderings disagreed/);
  });

  it('honours an explicit tie', async () => {
    const r = await compare(A, B, judge('{"winner":"tie","reason":"very close"}'));
    expect(r.outcome).toBe('tie');
    expect(r.reason).toBe('very close');
  });

  it('tells the judge that length does not matter', async () => {
    // Judges reward length. Saying so does not eliminate it but measurably
    // reduces it.
    const j = judge('{"winner":"tie","reason":"x"}');
    await compare(A, B, j);
    expect(j.seen[0]!.system).toMatch(/Length\. A shorter script is not worse/);
  });

  it('does not tell the judge which run produced which script', async () => {
    // Labels invite it to reason about the pipeline rather than the writing.
    const j = judge('{"winner":"tie","reason":"x"}');
    await compare(A, B, j);
    expect(j.seen[0]!.prompt).not.toContain('run-a');
    expect(j.seen[0]!.prompt).not.toContain('run-b');
    // Titles ARE included: a title is part of what a listener chooses on.
    expect(j.seen[0]!.prompt).toContain('The Thursday Column');
  });

  it('judges at temperature 0', async () => {
    const j = judge('{"winner":"tie","reason":"x"}');
    await compare(A, B, j);
    expect(j.seen[0]!.temperature).toBe(0);
  });

  it('treats unparseable output as a tie rather than a winner', async () => {
    const r = await compare(A, B, judge('I think the first one, probably'));
    expect(r.outcome).toBe('tie');
  });

  it('sums the cost of both calls', async () => {
    const r = await compare(A, B, judge('{"winner":"tie","reason":"x"}'));
    expect(r.costPence).toBeCloseTo(0.1);
  });
});

describe('formatComparison', () => {
  it('names the winner', async () => {
    const j = judge((req) =>
      req.prompt.indexOf('Script A text.') < req.prompt.indexOf('Script B text.')
        ? '{"winner":"A","reason":"r"}'
        : '{"winner":"B","reason":"r"}'
    );
    expect(formatComparison(await compare(A, B, j))).toContain('winner: run-a');
  });

  it('says plainly when the orderings disagreed', async () => {
    const text = formatComparison(await compare(A, B, judge('{"winner":"A","reason":"x"}')));
    expect(text).toMatch(/orderings disagreed/);
    expect(text).toMatch(/position rather than quality/);
  });
});
