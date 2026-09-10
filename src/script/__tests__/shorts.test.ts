/**
 * The short lane is the cheapest content in the pipeline and therefore the
 * easiest place for a quiet quality failure to scale. What is pinned here is
 * the boundary that keeps it honest: a derived short may only ever restate
 * facts the parent episode already verified, and the claims it inherits have
 * to actually reach the beats being written.
 */
import { Claim } from '../../evidence/claim';
import { LlmClient, LlmRequest, LlmResponse } from '../../models/client';
import { Script } from '../write';
import { redistributeClaims, selectShortAngle, SHORT_FORM_GUIDANCE } from '../shorts';

const claim = (id: string, beatId: string): Claim => ({
  id,
  beatId,
  type: 'statistic',
  text: `claim ${id}`,
  sourceId: 's1',
  quote: 'a quote long enough to be locatable in the source document text',
  contested: false,
});

const parent: Script = {
  title: 'The parent episode',
  description: 'x',
  beats: [
    {
      beatId: 'cold_open',
      beatType: 'cold_open',
      turns: [{ speaker: 'reporter', text: 'The filing said nothing for eleven months.' }],
      claimIds: ['c1'],
      revisions: 0,
    },
    {
      beatId: 'mechanism',
      beatType: 'mechanism',
      turns: [{ speaker: 'reporter', text: 'Then the numbers moved.' }],
      claimIds: ['c2'],
      revisions: 0,
    },
  ],
};

const claims = [claim('c1', 'cold_open'), claim('c2', 'mechanism')];

/** A writer that returns one canned response and records what it was asked. */
const cannedWriter = (text: string): LlmClient & { seen: LlmRequest[] } => {
  const seen: LlmRequest[] = [];
  return {
    name: 'canned',
    model: 'test-model',
    seen,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      seen.push(req);
      return { text, inputTokens: 1, outputTokens: 1, costPence: 0.5, model: 'test-model' };
    },
  };
};

describe('selectShortAngle', () => {
  it('returns the chosen angle and its claims', async () => {
    const writer = cannedWriter('{"angle":"the eleven months","claimIds":["c1"],"reason":"specific"}');
    const selection = await selectShortAngle(parent, claims, writer);

    expect(selection.angle).toBe('the eleven months');
    expect(selection.claimIds).toEqual(['c1']);
  });

  it('costs exactly one call', async () => {
    // The entire economic case for deriving rather than writing standalone:
    // roughly twelve pence against a pound ten, because research, extraction,
    // verification and counter-evidence are all inherited rather than repeated.
    const writer = cannedWriter('{"angle":"a","claimIds":["c1"],"reason":""}');
    await selectShortAngle(parent, claims, writer);
    expect(writer.seen).toHaveLength(1);
  });

  it('reports what it spent', async () => {
    const writer = cannedWriter('{"angle":"a","claimIds":["c1"],"reason":""}');
    let spent = 0;
    await selectShortAngle(parent, claims, writer, (p) => (spent += p));
    expect(spent).toBeCloseTo(0.5);
  });

  it('REFUSES a claim that is not in the parent episode', async () => {
    // The rule the whole lane rests on. A short that states something the
    // parent never verified is an unverified claim wearing a verified
    // episode's clothes, and it would ship with the same label and the same
    // apparent authority as everything else.
    const writer = cannedWriter('{"angle":"a","claimIds":["c1","invented"],"reason":""}');
    await expect(selectShortAngle(parent, claims, writer)).rejects.toThrow(/invented/);
  });

  it('gives the model the parent script and the verified facts, and nothing else', async () => {
    const writer = cannedWriter('{"angle":"a","claimIds":["c1"],"reason":""}');
    await selectShortAngle(parent, claims, writer);

    const prompt = writer.seen[0]!.prompt;
    expect(prompt).toContain('The filing said nothing for eleven months.');
    expect(prompt).toContain('[c1]');
    expect(prompt).toContain('[c2]');
  });
});

describe('redistributeClaims', () => {
  it('re-points inherited claims onto the short beats', () => {
    // Without this the writer is handed claims addressed to `mechanism` while
    // writing `pivot`, sees none for the beat in front of it, and writes a beat
    // with no facts in it - which passes silently and reads as filler.
    const out = redistributeClaims(
      claims,
      { angle: 'a', claimIds: ['c1', 'c2'], reason: '' },
      ['hook', 'escalate']
    );

    expect(out.map((c) => c.beatId)).toEqual(['hook', 'escalate']);
  });

  it('keeps everything about a claim except which beat it belongs to', () => {
    const out = redistributeClaims(claims, { angle: 'a', claimIds: ['c1'], reason: '' }, ['hook']);
    expect(out[0]).toEqual({ ...claims[0], beatId: 'hook' });
  });

  it('spreads claims across the beats rather than piling them on one', () => {
    const many = ['c1', 'c2', 'c3', 'c4'].map((id, i) => claim(id, `b${i}`));
    const out = redistributeClaims(
      many,
      { angle: 'a', claimIds: ['c1', 'c2', 'c3', 'c4'], reason: '' },
      ['hook', 'escalate']
    );

    expect(out.map((c) => c.beatId)).toEqual(['hook', 'escalate', 'hook', 'escalate']);
  });

  it('drops claims the selection did not choose', () => {
    const out = redistributeClaims(claims, { angle: 'a', claimIds: ['c2'], reason: '' }, ['hook']);
    expect(out.map((c) => c.id)).toEqual(['c2']);
  });

  it('returns nothing when there are no beats to point at', () => {
    expect(redistributeClaims(claims, { angle: 'a', claimIds: ['c1'], reason: '' }, [])).toEqual([]);
  });
});

describe('SHORT_FORM_GUIDANCE', () => {
  it('is phrased as things to do rather than things to avoid', () => {
    // "Don't sound like a podcast" produces a model's idea of not-a-podcast,
    // which is exclamation marks and false urgency. Every line here should
    // start with an instruction, not a prohibition.
    const openers = SHORT_FORM_GUIDANCE.map((g) => g.split(' ')[0]!.toLowerCase());
    const negative = openers.filter((w) => w === "don't" || w === 'never' || w === 'avoid');
    expect(negative).toHaveLength(0);
  });

  it('forbids the two conventions that get a short skipped', () => {
    const all = SHORT_FORM_GUIDANCE.join(' ').toLowerCase();
    expect(all).toContain('no greeting');
    expect(all).toContain('no sign-off');
  });
});
