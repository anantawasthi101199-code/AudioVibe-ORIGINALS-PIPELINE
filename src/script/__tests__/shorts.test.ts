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
  const slot = (id: string, minClaims = 0) => ({ id, minClaims });
  const pick = (...ids: string[]) => ({ angle: 'a', claimIds: ids, reason: '' });

  it('re-points inherited claims onto the short beats', () => {
    // Without this the writer is handed claims addressed to `mechanism` while
    // writing `pivot`, sees none for the beat in front of it, and writes a beat
    // with no facts in it - which passes silently and reads as filler.
    const out = redistributeClaims(claims, pick('c1', 'c2'), [slot('hook'), slot('escalate')]);
    expect(out.map((c) => c.beatId)).toEqual(['hook', 'escalate']);
  });

  it('keeps everything about a claim except which beat it belongs to', () => {
    const out = redistributeClaims(claims, pick('c1'), [slot('hook')]);
    expect(out[0]).toEqual({ ...claims[0], beatId: 'hook' });
  });

  it('FILLS THE FLOORS BEFORE SPREADING', () => {
    // The bug a plain round-robin hides. Two claims, four beats, and the two
    // beats that actually require a fact are the first and the last. Dealing
    // them in order puts both on beats that needed neither and fails the short
    // at the gate for having no facts in the beat that answers the question -
    // after a render has been paid for.
    const out = redistributeClaims(claims, pick('c1', 'c2'), [
      slot('hook', 1),
      slot('escalate'),
      slot('pivot'),
      slot('land', 1),
    ]);

    expect(out.map((c) => c.beatId).sort()).toEqual(['hook', 'land']);
  });

  it('spreads what is left over after the floors are met', () => {
    const many = ['c1', 'c2', 'c3', 'c4'].map((id, i) => claim(id, `b${i}`));
    const out = redistributeClaims(many, pick('c1', 'c2', 'c3', 'c4'), [
      slot('hook', 1),
      slot('land', 1),
    ]);

    // Two fill the floors, two spread across both beats.
    expect(out.map((c) => c.beatId)).toEqual(['hook', 'land', 'hook', 'land']);
  });

  it('REFUSES a selection too thin to meet the floors', () => {
    // A short with nothing to say in the beat that answers the question. Worth
    // failing here, where the parent's claims are still in hand and another
    // selection costs one call, rather than at the gate after the render.
    expect(() =>
      redistributeClaims(claims, pick('c1'), [slot('hook', 1), slot('land', 1)])
    ).toThrow(/require 2/);
  });

  it('drops claims the selection did not choose', () => {
    const out = redistributeClaims(claims, pick('c2'), [slot('hook')]);
    expect(out.map((c) => c.id)).toEqual(['c2']);
  });

  it('returns nothing when there are no beats to point at', () => {
    expect(redistributeClaims(claims, pick('c1'), [])).toEqual([]);
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
