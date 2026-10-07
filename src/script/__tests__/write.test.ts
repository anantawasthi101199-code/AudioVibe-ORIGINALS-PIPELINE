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

/**
 * Requests that actually wrote a beat.
 *
 * writeScript now makes a PLANNING call first, which deliberately sees every
 * claim and the whole beat sheet - that is the entire point of it. Tests about
 * what a BEAT is shown have to exclude it, or they end up asserting that the
 * planner is as blinkered as the writer, which is the opposite of the design.
 */
const beatCalls = (w: { seen: LlmRequest[] }): LlmRequest[] =>
  w.seen.filter(
    (r) => !r.system.includes('plan one episode') && !r.system.includes('title and description')
  );

const ctx = (p = SOLO, allowRevisions = false) => ({
  allowRevisions,
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
        {
          // The long turn goes to the SCEPTIC, which keeps the split near even.
          // Handing it to the reporter made one voice 74% of the beat and
          // tripped the monologue check - a fixture that trips an unrelated
          // rule tests nothing.
          speaker: 'sceptic',
          text: 'A contractor signed it, every Friday, in the same blue biro. He was working from a printed rota that nobody had updated since the panel was replaced in the March, so the column he was filling in described a system that had stopped existing.',
        },
        {
          speaker: 'reporter',
          text: 'And nobody reading it afterwards had any reason to think that.',
        },
      ],
      DUO,
      FORMAT.beats[0]!
    );
    expect(blocking).toEqual([]);
  });

  it('does NOT block a beat that comes in short', () => {
    // THERE IS NO FLOOR ANY MORE, and its removal is a correction. It was
    // raised to 0.85 of the minimum one commit after an episode came in short,
    // and the very next episode was described as "forced to be long" - which is
    // what a floor produces once a beat has said everything its claims support.
    // The cheapest padding is describing something already described.
    //
    // Length follows the material now. A short beat that says everything once
    // is the right beat.
    const short = critiqueBeat([{ speaker: 'host', text: 'Short.' }], SOLO, FORMAT.beats[0]!);
    expect(short.blocking.filter((b) => /runs \d+ words/.test(b))).toEqual([]);
    expect(short.advisory.join(' ')).toMatch(/runs \d+ words/);
  });

  it('still blocks a beat that runs away with itself', () => {
    // The ceiling survives, because a beat half again over its slot has started
    // rambling - a real fault rather than an arithmetic one.
    const { max } = wordsForBeat(FORMAT.beats[0]!);
    const rambling = Array.from({ length: Math.round(max * 1.8) }, () => 'word').join(' ');
    expect(
      critiqueBeat([{ speaker: 'host', text: rambling }], SOLO, FORMAT.beats[0]!).blocking.join(' ')
    ).toMatch(/well past the \d+/);
  });

  it('only advises a beat that is a little over', () => {
    // Rejecting a beat twenty words over still teaches the writer to pad or to
    // clip mid-thought, so the HIGH edge is unchanged.
    const { max } = wordsForBeat(FORMAT.beats[0]!);
    const slightlyOver = Array.from({ length: max + 12 }, () => 'word').join(' ');
    const nearMiss = critiqueBeat(
      [{ speaker: 'host', text: slightlyOver }],
      SOLO,
      FORMAT.beats[0]!
    );
    expect(nearMiss.blocking.filter((b) => /runs \d+ words/.test(b))).toEqual([]);
    expect(nearMiss.advisory.join(' ')).toMatch(/runs \d+ words against a guide/);
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
    const beat = await writeBeat(ctx(), fakeWriter(soloTurns(`[ponderous] ${GOOD} [laughs]`)));
    expect(beat.turns[0]!.text).not.toContain('[ponderous]');
    expect(beat.turns[0]!.text).toContain('[laughs]');
  });

  describe('revision', () => {
    // THE TRIGGER USED TO BE A BEAT THAT WAS TOO SHORT, and it stopped being a
    // failure when length became a guide rather than a target. Using the
    // negation tic instead is a better fixture anyway: it is the fault the
    // revision loop most often has to fix on a real run, and it is one a
    // listener actually complained about.
    // THREE OF THEM, because the negation opener now has a budget of one and
    // BLOCKS at more than double it. Measured: the reference corpus opens a
    // sentence with "Not" in 11% of its beat-sized chunks, so a flat ban refused
    // writing chosen as the standard - but the episode that prompted the check had
    // four in one beat, and three is unambiguously the tic rather than a choice.
    // The revision loop only acts on blocking findings, so an advisory fixture
    // would leave this test asserting a rewrite that never happens.
    const failsThenPasses = (_r: LlmRequest, n: number) =>
      n === 0
        ? soloTurns(
            `${GOOD} Not a legend, not a heist film pitch. ` +
              `Not a gang bursting through a wall with a sledgehammer. ` +
              `Not from the newspaper version either.`
          )
        : soloTurns();

    it('REVISES a beat that fails, and hands it the failures', async () => {
      // Writing once and judging wasted every rejection: the critique knew
      // exactly what was wrong and the only response was a human.
      const w = fakeWriter(failsThenPasses);
      const beat = await writeBeat(ctx(SOLO, true), w);

      expect(beat.revisions).toBe(1);
      expect(w.seen).toHaveLength(2);
      expect(w.seen[1]!.prompt).toMatch(/WHAT FAILED/);
      expect(w.seen[1]!.prompt).toMatch(/denying something nobody said/);
    });

    it('hands back the previous draft as well as the failures', async () => {
      // Failures alone produce a fresh draft that fails differently; both
      // together produce a repair.
      const w = fakeWriter(failsThenPasses);
      await writeBeat(ctx(SOLO, true), w);
      expect(w.seen[1]!.prompt).toMatch(/YOUR PREVIOUS DRAFT/);
      expect(w.seen[1]!.prompt).toContain('Not a legend');
    });

    it('revises cooler than it drafts', async () => {
      // A hot rewrite discards the parts that were working.
      const w = fakeWriter(failsThenPasses);
      await writeBeat(ctx(SOLO, true), w);
      expect(w.seen[1]!.temperature).toBeLessThan(w.seen[0]!.temperature!);
    });

    it('gives up after a bounded number of attempts rather than burning calls', async () => {
      // Past two, the failure is usually in the claims or the beat definition
      // rather than the prose, and more calls arrive at the same place.
      // A draft that keeps failing the same way. "Too short" used to be the
      // handy one and stopped being a failure when length became a guide.
      // Three openers, for the same reason as failsThenPasses above: the budget
      // is one and it blocks at more than double, so a single one is advisory and
      // would never trigger the loop this test is about.
      const w = fakeWriter(
        soloTurns(
          `${GOOD} Not a legend, not a heist film pitch. ` +
            `Not a gang bursting through a wall with a sledgehammer. ` +
            `Not from the newspaper version either.`
        )
      );
      const beat = await writeBeat(ctx(SOLO, true), w);
      expect(beat.revisions).toBe(MAX_REVISIONS);
      expect(w.seen).toHaveLength(MAX_REVISIONS + 1);
    });

    it('does not revise a beat that passes first time', async () => {
      const w = fakeWriter(soloTurns());
      await writeBeat(ctx(SOLO, true), w);
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
    // beatCalls, because seen[0] is now the planning call.
    expect(beatCalls(w)[0]!.prompt).toContain('This is the opening beat.');
    expect(beatCalls(w)[1]!.prompt).toContain('IT ENDED ON');
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
    // The BEAT writer, not the planner. The planner sees every claim by design.
    const first = beatCalls(w)[0]!;
    expect(first.prompt).toContain('[open1]');
    expect(first.prompt).not.toContain('[pay1]');
  });

  it('lets the PLANNER see every claim, because that is its whole job', () => {
    // The plan is the only thing in the system that sees the episode as one
    // story. A planner shown a tenth of the facts at a time would reproduce the
    // disconnection it exists to fix.
    const w = fakeWriter(both);
    return writeScript(
      {
        persona: SOLO,
        format: FORMAT,
        claims: [claim({ id: 'open1', beatId: 'cold_open' }), claim({ id: 'pay1', beatId: 'payoff' })],
        angle: 'a',
        isoDate: '2026-09-08',
      },
      w
    ).then(() => {
      const plan = w.seen.find((r) => r.system.includes('plan one episode'))!;
      expect(plan.prompt).toContain('[open1]');
      expect(plan.prompt).toContain('[pay1]');
    });
  });

  it('gives a beat the WHOLE episode so far, not just the last sentence', async () => {
    // Twenty-five words was the entire memory a beat had of its own episode,
    // and most of what went wrong with the first real one follows from it: a
    // beat that cannot see what was said cannot avoid repeating it, cannot know
    // who has been introduced, and cannot overturn something never established.
    const w = fakeWriter(both);
    await writeScript(
      { persona: SOLO, format: FORMAT, claims: [], angle: 'a', isoDate: '2026-09-08' },
      w
    );

    const second = beatCalls(w)[1]!;
    expect(second.prompt).toContain('THE EPISODE SO FAR');
    // Labelled with hyphens rather than brackets, because `[cold_open]` is both
    // JSON array syntax and an audio tag, and a model shown that copied it.
    expect(second.prompt).toContain('--- cold_open ---');
    expect(second.prompt).not.toContain('[cold_open]');
  });

  it('tells the opening beat that nothing has been said yet', async () => {
    const w = fakeWriter(both);
    await writeScript(
      { persona: SOLO, format: FORMAT, claims: [], angle: 'a', isoDate: '2026-09-08' },
      w
    );
    expect(beatCalls(w)[0]!.prompt).toContain('Nothing has been said yet');
  });

  it('writes the beats even when planning fails', async () => {
    // A failed plan must not cost the episode. Without one every beat falls
    // back to what it had before, which is worse but is not nothing.
    const w = fakeWriter((req) =>
      req.system.includes('plan one episode') ? 'not json at all' : both(req)
    );

    const script = await writeScript(
      { persona: SOLO, format: FORMAT, claims: [], angle: 'a', isoDate: '2026-09-08' },
      w
    );
    expect(script.beats).toHaveLength(FORMAT.beats.length);
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

/**
 * SKIPPED MATERIAL, which is the check that protects the content from all the
 * others.
 *
 * Every check on prose creates pressure, and a writer under pressure buys
 * compliance with the cheapest thing it has. Adding rewrite pressure for sentence
 * length, handovers and questions moved all three to reference level and produced
 * an episode of the Descent of Inanna WITH NO SEVEN GATES IN IT - no crown, no
 * earrings, no measuring rod, no "naked before Ereshkigal" - while its own plan
 * said "stripped of one garment or piece of regalia at each". Its story beat had
 * left six of twenty-five facts unused and come in under its length guide.
 */
describe('critiqueBeat - material the beat was given and skipped', () => {
  const beat = FORMAT.beats[0]!;
  const short = 'A short beat that says almost nothing at all about the subject it was given.';

  const facts = (n: number): Claim[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `c${i + 1}`,
      text: `Verified fact number ${i + 1} about the thing that happened.`,
      type: 'chronology' as const,
      beatId: beat.id,
      sourceId: 's1',
      quote: `Verified fact number ${i + 1} about the thing that happened, as the source has it.`,
      contested: false,
      status: 'verified' as const,
    }));

  it('asks for a rewrite when a short beat leaves its own facts unused', () => {
    const { blocking } = critiqueBeat(
      [{ speaker: 'host', text: short }],
      SOLO,
      beat,
      undefined,
      undefined,
      facts(6),
      ['c1'] // cited one of six
    );
    expect(blocking.join(' ')).toMatch(/leaves 5 of its 6 facts unused/);
  });

  it('says nothing when the beat used what it was given', () => {
    const { blocking } = critiqueBeat(
      [{ speaker: 'host', text: short }],
      SOLO,
      beat,
      undefined,
      undefined,
      facts(6),
      ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']
    );
    expect(blocking.join(' ')).not.toMatch(/facts unused/);
  });

  it('allows one unused fact, because one that does not fit is taste', () => {
    const { blocking } = critiqueBeat(
      [{ speaker: 'host', text: short }],
      SOLO,
      beat,
      undefined,
      undefined,
      facts(6),
      ['c1', 'c2', 'c3', 'c4', 'c5']
    );
    expect(blocking.join(' ')).not.toMatch(/facts unused/);
  });

  /**
   * A BEAT AT ITS FULL LENGTH THAT STILL LEFT FACTS HAS MORE MATERIAL THAN FITS,
   * which is an editorial decision and none of this function's business. Without
   * this half, the check would be a word floor wearing a disguise, and a floor
   * makes a beat pad - which is settled policy the owner was explicit about.
   */
  it('says nothing about unused facts when the beat is at full length', () => {
    const long = Array.from(
      { length: 200 },
      (_, i) => `Sentence ${i} carries a little of the story forward.`
    ).join(' ');

    const { blocking } = critiqueBeat(
      [{ speaker: 'host', text: long }],
      SOLO,
      beat,
      undefined,
      undefined,
      facts(6),
      ['c1']
    );
    expect(blocking.join(' ')).not.toMatch(/facts unused/);
  });
});
