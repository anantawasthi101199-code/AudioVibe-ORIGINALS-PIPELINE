import { parsePersona } from '../../canon/load';
import { parseFormat } from '../../formats/load';
import { Claim } from '../../evidence/claim';
import { LlmClient, LlmRequest, LlmResponse } from '../../models/client';
import { fullText, tailOf, wordsForBeat, writeBeat, writeScript, WORDS_PER_SECOND } from '../write';

const PERSONA = parsePersona(`
id: t
handle: t
name: The Show
category: Educational
thesis: A thesis.
audience: An audience.
register: Plain.
voice: {provider: elevenlabs, voiceId: v}
styleCard:
  sentenceWordsMean: 15
  sentenceWordsStdDevMin: 5
  questionsPer100Words: 1
  secondPersonPer100Words: 1
  hedgesPer100WordsMax: 2
  metaphorDomains: [engineering]
  forbiddenPhrases: [cautionary tale]
canon:
  - {kind: belief, text: Reconstruct what was knowable then.}
  - {kind: taboo, text: Never mock a named individual.}
  - {kind: stylistic_rule, text: Numbers spoken as speech.}
formats: [f]
episodeSeconds: [300, 400]
allowedRiskTiers: [general]
`);

const FORMAT = parseFormat(`
id: f
name: F
kind: long
intent: x
targetSeconds: [30, 60]
beats:
  - {id: cold_open, type: cold_open, seconds: [8, 14], function: Open with the anomaly., constraints: [One sentence.]}
  - {id: payoff, type: payoff, seconds: [20, 40], function: Land it.}
tensionCurve: [0.9, 1.0]
`);

const claim = (over: Partial<Claim> = {}): Claim => ({
  id: 'c1',
  text: 'The alarm was off for eleven weeks.',
  type: 'chronology',
  beatId: 'cold_open',
  sourceId: 's1',
  quote: 'x'.repeat(50),
  contested: false,
  ...over,
});

const fakeWriter = (reply: string | ((r: LlmRequest) => string)): LlmClient & { seen: LlmRequest[] } => {
  const seen: LlmRequest[] = [];
  return {
    name: 'fake',
    model: 'fake-writer-1',
    seen,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      seen.push(req);
      return {
        text: typeof reply === 'function' ? reply(req) : reply,
        inputTokens: 10,
        outputTokens: 20,
        costPence: 0.4,
        model: 'fake-writer-1',
      };
    },
  };
};

describe('wordsForBeat', () => {
  it('turns a duration range into a word range', () => {
    const w = wordsForBeat(FORMAT.beats[0]!);
    expect(w.min).toBe(Math.round(8 * WORDS_PER_SECOND));
    expect(w.max).toBe(Math.round(14 * WORDS_PER_SECOND));
  });
});

describe('tailOf', () => {
  it('returns the last words', () => {
    expect(tailOf('one two three four', 2)).toBe('three four');
  });
});

describe('writeBeat', () => {
  const ctx = {
    persona: PERSONA,
    format: FORMAT,
    beat: FORMAT.beats[0]!,
    claims: [claim()],
    angle: 'the alarm',
    isoDate: '2026-09-08',
  };

  it('returns the beat text and the claims it used', async () => {
    const w = fakeWriter('{"text":"The alarm had been off for eleven weeks.","claimIds":["c1"]}');
    const beat = await writeBeat(ctx, w);
    expect(beat.beatId).toBe('cold_open');
    expect(beat.text).toBe('The alarm had been off for eleven weeks.');
    expect(beat.claimIds).toEqual(['c1']);
  });

  it('tells the writer it may only state facts from the claims', async () => {
    // The writer cannot introduce facts. Claims are pre-verified against their
    // sources; anything it adds from its own knowledge is not.
    const w = fakeWriter('{"text":"x","claimIds":[]}');
    await writeBeat(ctx, w);
    expect(w.seen[0]!.system).toMatch(/ONLY if it appears in the CLAIMS/);
    expect(w.seen[0]!.system).toMatch(/Do not add\s+figures, dates, names or causes/);
  });

  it('passes the show canon into the system prompt', async () => {
    const w = fakeWriter('{"text":"x","claimIds":[]}');
    await writeBeat(ctx, w);
    expect(w.seen[0]!.system).toContain('Reconstruct what was knowable then.');
    expect(w.seen[0]!.system).toContain('Never mock a named individual.');
  });

  it('passes the banned phrase list, so the writer avoids them up front', async () => {
    const w = fakeWriter('{"text":"x","claimIds":[]}');
    await writeBeat(ctx, w);
    expect(w.seen[0]!.system).toContain("let's dive in");
    expect(w.seen[0]!.system).toContain('cautionary tale');
  });

  it('gives the beat its own constraints and length budget', async () => {
    const w = fakeWriter('{"text":"x","claimIds":[]}');
    await writeBeat(ctx, w);
    expect(w.seen[0]!.prompt).toContain('One sentence.');
    expect(w.seen[0]!.prompt).toMatch(/LENGTH: \d+ to \d+ words/);
  });

  it('does NOT hand the writer the whole corpus', async () => {
    // A writer holding fourteen documents starts summarising them instead of
    // writing the beat.
    const w = fakeWriter('{"text":"x","claimIds":[]}');
    await writeBeat(ctx, w);
    expect(w.seen[0]!.prompt).not.toContain('DOCUMENT');
    expect(w.seen[0]!.prompt).toContain('[c1]');
  });

  it('tells a beat with no claims not to state new facts', async () => {
    const w = fakeWriter('{"text":"x","claimIds":[]}');
    await writeBeat({ ...ctx, claims: [] }, w);
    expect(w.seen[0]!.prompt).toContain('without stating new facts');
  });
});

describe('writeScript', () => {
  it('writes every beat in order and then the title', async () => {
    const w = fakeWriter((req) =>
      req.system.includes('title and description')
        ? '{"title":"The Thursday Column","description":"One. Two."}'
        : '{"text":"Some prose for this beat.","claimIds":[]}'
    );

    const script = await writeScript(
      { persona: PERSONA, format: FORMAT, claims: [claim()], angle: 'the alarm', isoDate: '2026-09-08' },
      w
    );

    expect(script.beats.map((b) => b.beatId)).toEqual(['cold_open', 'payoff']);
    expect(script.title).toBe('The Thursday Column');
    expect(script.writerModel).toBe('fake-writer-1');
  });

  it('gives each beat the tail of the one before, so joins are not seams', async () => {
    // The reason beats are written sequentially rather than in parallel, at a
    // real cost in wall-clock time.
    const w = fakeWriter((req) =>
      req.system.includes('title and description')
        ? '{"title":"T","description":"D"}'
        : '{"text":"Alpha beta gamma delta epsilon.","claimIds":[]}'
    );

    await writeScript(
      { persona: PERSONA, format: FORMAT, claims: [], angle: 'a', isoDate: '2026-09-08' },
      w
    );

    expect(w.seen[0]!.prompt).toContain('This is the opening beat.');
    expect(w.seen[1]!.prompt).toContain('THE PREVIOUS BEAT ENDED');
    expect(w.seen[1]!.prompt).toContain('epsilon');
  });

  it('gives each beat only its own claims', async () => {
    const w = fakeWriter((req) =>
      req.system.includes('title and description')
        ? '{"title":"T","description":"D"}'
        : '{"text":"x","claimIds":[]}'
    );

    await writeScript(
      {
        persona: PERSONA,
        format: FORMAT,
        claims: [claim({ id: 'open1', beatId: 'cold_open' }), claim({ id: 'pay1', beatId: 'payoff' })],
        angle: 'a',
        isoDate: '2026-09-08',
      },
      w
    );

    expect(w.seen[0]!.prompt).toContain('[open1]');
    expect(w.seen[0]!.prompt).not.toContain('[pay1]');
    expect(w.seen[1]!.prompt).toContain('[pay1]');
  });

  it('reports cost for every call', async () => {
    const costs: number[] = [];
    const w = fakeWriter((req) =>
      req.system.includes('title and description')
        ? '{"title":"T","description":"D"}'
        : '{"text":"x","claimIds":[]}'
    );
    await writeScript({ persona: PERSONA, format: FORMAT, claims: [], angle: 'a', isoDate: '2026-09-08' }, w, (c) =>
      costs.push(c)
    );
    // Two beats plus the title.
    expect(costs).toHaveLength(3);
  });
});

describe('fullText', () => {
  it('joins beats with a blank line', () => {
    expect(
      fullText({
        personaId: 't',
        formatId: 'f',
        title: 'T',
        description: 'D',
        writerModel: 'm',
        beats: [
          { beatId: 'a', beatType: 'cold_open', text: 'One.', claimIds: [] },
          { beatId: 'b', beatType: 'payoff', text: 'Two.', claimIds: [] },
        ],
      })
    ).toBe('One.\n\nTwo.');
  });
});
