import { parsePersona } from '../../canon/load';
import { parseFormat } from '../../formats/load';
import { Claim } from '../../evidence/claim';
import { LlmClient, LlmRequest, LlmResponse } from '../../models/client';
import {
  beatText,
  critiqueBeat,
  fullText,
  MAX_REVISIONS,
  tailOf,
  wordsForBeat,
  writeBeat,
  writeScript,
  WORDS_PER_SECOND,
} from '../write';

const persona = (hosts: string) =>
  parsePersona(`
id: t
handle: t
name: The Show
category: Educational
thesis: A thesis.
audience: An audience.
register: Plain.
${hosts}
styleCard:
  sentenceWordsMean: 15
  sentenceWordsStdDevMin: 5
  questionsPer100Words: 1
  secondPersonPer100Words: 1
  hedgesPer100WordsMax: 3
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

const SOLO = persona(
  'hosts: [{id: host, name: Host, role: Narrates., voice: {provider: elevenlabs, voiceId: v}}]'
);

const DUO = persona(
  [
    'hosts:',
    '  - {id: reporter, name: Nadia, role: Has read the documents., voice: {provider: elevenlabs, voiceId: v1}}',
    '  - {id: sceptic, name: Theo, role: Presses on what a claim rests on., voice: {provider: elevenlabs, voiceId: v2}}',
  ].join('\n')
);

const FORMAT = parseFormat(`
id: f
name: F
kind: long
intent: x
targetSeconds: [60, 120]
beats:
  - {id: cold_open, type: cold_open, seconds: [20, 40], function: Open with the anomaly., constraints: [One sentence.]}
  - {id: payoff, type: payoff, seconds: [40, 80], function: Land it.}
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

// Varied sentence length, no hedges, no banned phrases: passes first time.
const GOOD = [
  'The alarm had been off for eleven weeks.',
  'Nobody noticed, because the log that would have shown it was filled in every Friday for the week ahead, which meant the column was always complete and never once actually true.',
  'That is the part worth slowing down on.',
  'The regulator found it in a single afternoon.',
  'What took eleven weeks to happen came apart under one question about who had signed the Thursday entry.',
].join(' ');

const soloTurns = (text = GOOD) =>
  JSON.stringify({ turns: [{ speaker: 'host', text }], claimIds: ['c1'] });

const duoTurns = () =>
  JSON.stringify({
    turns: [
      { speaker: 'reporter', text: GOOD },
      {
        speaker: 'sceptic',
        text: 'Wait. Who actually signed that Thursday entry, and did anybody ever check the column against the panel itself?',
      },
    ],
    claimIds: ['c1'],
  });

const fakeWriter = (
  reply: string | ((r: LlmRequest, n: number) => string)
): LlmClient & { seen: LlmRequest[] } => {
  const seen: LlmRequest[] = [];
  return {
    name: 'fake',
    model: 'fake-writer-1',
    seen,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const n = seen.length;
      seen.push(req);
      return {
        text: typeof reply === 'function' ? reply(req, n) : reply,
        inputTokens: 10,
        outputTokens: 20,
        costPence: 0.4,
        model: 'fake-writer-1',
      };
    },
  };
};

const ctx = (p = SOLO) => ({
  persona: p,
  format: FORMAT,
  beat: FORMAT.beats[0]!,
  claims: [claim()],
  angle: 'the alarm',
  isoDate: '2026-09-08',
});

describe('wordsForBeat', () => {
  it('turns a duration range into a word range', () => {
    expect(wordsForBeat(FORMAT.beats[0]!).min).toBe(Math.round(20 * WORDS_PER_SECOND));
  });
});

describe('tailOf', () => {
  it('returns the last words', () => {
    expect(tailOf('one two three four', 2)).toBe('three four');
  });
});

describe('critiqueBeat', () => {
  it('passes a well-formed solo beat', () => {
    expect(critiqueBeat([{ speaker: 'host', text: GOOD }], SOLO, FORMAT.beats[0]!).blocking).toEqual([]);
  });

  it('rejects a speaker who is not in the cast', () => {
    const { blocking } = critiqueBeat([{ speaker: 'ghost', text: GOOD }], SOLO, FORMAT.beats[0]!);
    expect(blocking.join(' ')).toMatch(/not in the cast/);
  });

  it('rejects a one-sided beat on a two-host show', () => {
    // A beat where only one host speaks is not an exchange, whatever its length.
    const { blocking } = critiqueBeat([{ speaker: 'reporter', text: GOOD }], DUO, FORMAT.beats[0]!);
    expect(blocking.join(' ')).toMatch(/only one host speaks/);
  });

  it('rejects a monologue wearing a dialogue costume', () => {
    // What a writer produces by default because it is easier: one host delivers
    // everything and the other says "right".
    const { blocking } = critiqueBeat(
      [
        { speaker: 'reporter', text: GOOD },
        { speaker: 'sceptic', text: 'Right.' },
      ],
      DUO,
      FORMAT.beats[0]!
    );
    expect(blocking.join(' ')).toMatch(/monologue with interruptions/);
  });

  it('accepts a genuine exchange', () => {
    const { blocking } = critiqueBeat(
      [
        {
          speaker: 'reporter',
          text: 'The alarm had been off for eleven weeks, and the maintenance log said the opposite every single Friday.',
        },
        {
          speaker: 'sceptic',
          text: 'Hold on. Somebody filled that in ahead of time? Who signed it, and did anyone ever check the column against the panel?',
        },
      ],
      DUO,
      FORMAT.beats[0]!
    );
    expect(blocking).toEqual([]);
  });

  it('blocks a beat wildly outside its length but only advises a near miss', () => {
    // Rejecting a beat twenty words over teaches the writer to pad or to clip
    // mid-thought.
    expect(
      critiqueBeat([{ speaker: 'host', text: 'Short.' }], SOLO, FORMAT.beats[0]!).blocking.join(' ')
    ).toMatch(/runs \d+ words/);

    const nearMiss = critiqueBeat(
      [{ speaker: 'host', text: `${GOOD} One more sentence goes here.` }],
      SOLO,
      FORMAT.beats[0]!
    );
    expect(nearMiss.blocking.filter((b) => /runs \d+ words/.test(b))).toEqual([]);
  });

  it('blocks a banned phrase', () => {
    const { blocking } = critiqueBeat(
      [{ speaker: 'host', text: `${GOOD} A cautionary tale, really.` }],
      SOLO,
      FORMAT.beats[0]!
    );
    expect(blocking.join(' ')).toMatch(/cautionary tale/);
  });
});

describe('writeBeat', () => {
  it('returns turns and the claims used', async () => {
    const beat = await writeBeat(ctx(), fakeWriter(soloTurns()));
    expect(beat.beatId).toBe('cold_open');
    expect(beat.turns[0]!.speaker).toBe('host');
    expect(beat.claimIds).toEqual(['c1']);
    expect(beat.revisions).toBe(0);
  });

  it('tells the writer it may only state facts from the claims', async () => {
    const w = fakeWriter(soloTurns());
    await writeBeat(ctx(), w);
    expect(w.seen[0]!.system).toMatch(/ONLY if it appears in the CLAIMS/);
  });

  it('passes the show canon and the banned phrases', async () => {
    const w = fakeWriter(soloTurns());
    await writeBeat(ctx(), w);
    expect(w.seen[0]!.system).toContain('Reconstruct what was knowable then.');
    expect(w.seen[0]!.system).toContain('Never mock a named individual.');
    expect(w.seen[0]!.system).toContain("let's dive in");
    expect(w.seen[0]!.system).toContain('cautionary tale');
  });

  it('gives a two-host show conversation guidance and the cast', async () => {
    const w = fakeWriter(duoTurns());
    await writeBeat(ctx(DUO), w);
    expect(w.seen[0]!.system).toMatch(/WRITING A CONVERSATION/);
    expect(w.seen[0]!.system).toContain('reporter (Nadia)');
    expect(w.seen[0]!.system).toContain('sceptic (Theo)');
  });

  it('does NOT give a solo show conversation guidance', async () => {
    const w = fakeWriter(soloTurns());
    await writeBeat(ctx(), w);
    expect(w.seen[0]!.system).not.toMatch(/WRITING A CONVERSATION/);
  });

  it('does not hand the writer the whole corpus', async () => {
    const w = fakeWriter(soloTurns());
    await writeBeat(ctx(), w);
    expect(w.seen[0]!.prompt).not.toContain('DOCUMENT');
    expect(w.seen[0]!.prompt).toContain('[c1]');
  });

  it('strips audio tags the renderer does not know', async () => {
    // The provider speaks anything bracketed it does not recognise, so an
    // invented tag becomes a host saying "thoughtful" out loud mid-sentence.
    const beat = await writeBeat(ctx(), fakeWriter(soloTurns(`[thoughtful] ${GOOD} [laughs]`)));
    expect(beat.turns[0]!.text).not.toContain('[thoughtful]');
    expect(beat.turns[0]!.text).toContain('[laughs]');
  });

  describe('revision', () => {
    const failsThenPasses = (_r: LlmRequest, n: number) =>
      n === 0 ? soloTurns('Too short.') : soloTurns();

    it('REVISES a beat that fails, and hands it the failures', async () => {
      // Writing once and judging wasted every rejection: the critique knew
      // exactly what was wrong and the only response was a human.
      const w = fakeWriter(failsThenPasses);
      const beat = await writeBeat(ctx(), w);

      expect(beat.revisions).toBe(1);
      expect(w.seen).toHaveLength(2);
      expect(w.seen[1]!.prompt).toMatch(/WHAT FAILED/);
      expect(w.seen[1]!.prompt).toMatch(/runs \d+ words/);
    });

    it('hands back the previous draft as well as the failures', async () => {
      // Failures alone produce a fresh draft that fails differently; both
      // together produce a repair.
      const w = fakeWriter(failsThenPasses);
      await writeBeat(ctx(), w);
      expect(w.seen[1]!.prompt).toMatch(/YOUR PREVIOUS DRAFT/);
      expect(w.seen[1]!.prompt).toContain('Too short.');
    });

    it('revises cooler than it drafts', async () => {
      // A hot rewrite discards the parts that were working.
      const w = fakeWriter(failsThenPasses);
      await writeBeat(ctx(), w);
      expect(w.seen[1]!.temperature).toBeLessThan(w.seen[0]!.temperature!);
    });

    it('gives up after a bounded number of attempts rather than burning calls', async () => {
      // Past two, the failure is usually in the claims or the beat definition
      // rather than the prose, and more calls arrive at the same place.
      const w = fakeWriter(soloTurns('Too short.'));
      const beat = await writeBeat(ctx(), w);
      expect(beat.revisions).toBe(MAX_REVISIONS);
      expect(w.seen).toHaveLength(MAX_REVISIONS + 1);
    });

    it('does not revise a beat that passes first time', async () => {
      const w = fakeWriter(soloTurns());
      await writeBeat(ctx(), w);
      expect(w.seen).toHaveLength(1);
    });
  });
});

describe('writeScript', () => {
  const both = (req: LlmRequest) =>
    req.system.includes('title and description')
      ? '{"title":"The Thursday Column","description":"One. Two."}'
      : soloTurns();

  it('writes every beat in order and then the title', async () => {
    const script = await writeScript(
      { persona: SOLO, format: FORMAT, claims: [claim()], angle: 'the alarm', isoDate: '2026-09-08' },
      fakeWriter(both)
    );
    expect(script.beats.map((b) => b.beatId)).toEqual(['cold_open', 'payoff']);
    expect(script.title).toBe('The Thursday Column');
  });

  it('gives each beat the tail of the one before, so joins are not seams', async () => {
    const w = fakeWriter(both);
    await writeScript({ persona: SOLO, format: FORMAT, claims: [], angle: 'a', isoDate: '2026-09-08' }, w);
    expect(w.seen[0]!.prompt).toContain('This is the opening beat.');
    expect(w.seen[1]!.prompt).toContain('THE PREVIOUS BEAT ENDED');
  });

  it('gives each beat only its own claims', async () => {
    const w = fakeWriter(both);
    await writeScript(
      {
        persona: SOLO,
        format: FORMAT,
        claims: [claim({ id: 'open1', beatId: 'cold_open' }), claim({ id: 'pay1', beatId: 'payoff' })],
        angle: 'a',
        isoDate: '2026-09-08',
      },
      w
    );
    expect(w.seen[0]!.prompt).toContain('[open1]');
    expect(w.seen[0]!.prompt).not.toContain('[pay1]');
  });
});

describe('beatText and fullText', () => {
  it('joins turns and strips tags, because tags are not words', () => {
    expect(
      beatText({
        turns: [
          { speaker: 'a', text: '[laughs] One.' },
          { speaker: 'b', text: 'Two.' },
        ],
      })
    ).toBe('One.\nTwo.');
  });

  it('joins beats with a blank line', () => {
    expect(
      fullText({
        personaId: 't',
        formatId: 'f',
        title: 'T',
        description: 'D',
        writerModel: 'm',
        beats: [
          { beatId: 'a', beatType: 'cold_open', turns: [{ speaker: 'host', text: 'One.' }], claimIds: [], revisions: 0 },
          { beatId: 'b', beatType: 'payoff', turns: [{ speaker: 'host', text: 'Two.' }], claimIds: [], revisions: 0 },
        ],
      })
    ).toBe('One.\n\nTwo.');
  });
});
