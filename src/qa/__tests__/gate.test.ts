import { parsePersona } from '../../canon/load';
import { parseFormat } from '../../formats/load';
import { Claim, LedgerReport } from '../../evidence/claim';
import { VerificationReport } from '../../evidence/verify';
import { Script } from '../../script/write';
import { GateInput, MAX_VOCABULARY_OVERLAP, runGate, formatGateReport } from '../gate';

const PERSONA_YAML = `
id: t
handle: t
name: The Show
category: Educational
thesis: x
audience: y
register: z
hosts: [{id: host, name: Host, role: Narrates the show., voice: {provider: elevenlabs, voiceId: v}}]
styleCard:
  sentenceWordsMean: 15
  sentenceWordsStdDevMin: 5
  questionsPer100Words: 1
  secondPersonPer100Words: 1
  hedgesPer100WordsMax: 3
  metaphorDomains: [x]
formats: [f]
episodeSeconds: [300, 400]
allowedRiskTiers: [general]
`;

const PERSONA = parsePersona(PERSONA_YAML);



const FORMAT = parseFormat(`
id: f
name: F
kind: long
intent: x
targetSeconds: [300, 400]
beats:
  - {id: cold_open, type: cold_open, seconds: [100, 150], function: Open., minClaims: 1}
  - {id: payoff, type: payoff, seconds: [200, 260], function: Land., minClaims: 2}
tensionCurve: [0.9, 1.0]
`);

// Varied sentence lengths, no hedges, no banned phrases.
const GOOD_PROSE = [
  'The alarm had been off for eleven weeks.',
  'Nobody noticed, because the log that would have shown it was filled in on Fridays for the week ahead, which meant the column was always complete and never once true.',
  'That is the part worth slowing down on.',
  'The regulator found it in a single afternoon.',
  'What took eleven weeks to happen unravelled entirely under one question about who had signed the Thursday entry.',
].join(' ');

const script = (text = GOOD_PROSE): Script => ({
  personaId: 't',
  formatId: 'f',
  title: 'A Title',
  description: 'A description.',
  writerModel: 'writer-1',
  beats: [
    {
      beatId: 'cold_open',
      beatType: 'cold_open',
      turns: [{ speaker: 'host', text }],
      claimIds: ['c1'],
      revisions: 0,
    },
    {
      beatId: 'payoff',
      beatType: 'payoff',
      turns: [{ speaker: 'host', text: 'It cost four million pounds in the end.' }],
      claimIds: ['c2', 'c3'],
      revisions: 0,
    },
  ],
});

const claim = (over: Partial<Claim> = {}): Claim => ({
  id: 'c1',
  text: 'x',
  type: 'chronology',
  beatId: 'cold_open',
  sourceId: 's1',
  quote: 'q'.repeat(50),
  contested: false,
  ...over,
});

const ledger = (over: Partial<LedgerReport> = {}): LedgerReport => ({
  ok: true,
  problems: [],
  tierByBeat: { cold_open: 'T1', payoff: 'T1' },
  claimsByBeat: { cold_open: 1, payoff: 2 },
  ...over,
});

const verification = (over: Partial<VerificationReport> = {}): VerificationReport => ({
  results: [],
  blocking: [],
  verifierModel: 'verifier-1',
  costPence: 0,
  ...over,
});

const input = (over: Partial<GateInput> = {}): GateInput => ({
  persona: PERSONA,
  format: FORMAT,
  script: script(),
  claims: [claim(), claim({ id: 'c2', beatId: 'payoff' }), claim({ id: 'c3', beatId: 'payoff' })],
  ledger: ledger(),
  verification: verification(),
  counterEvidence: [],
  durationS: 350,
  ...over,
});

describe('runGate', () => {
  it('passes a clean episode', () => {
    const report = runGate(input());
    expect(report.passed).toBe(true);
    expect(report.findings.filter((f) => f.blocking)).toEqual([]);
  });

  it('BLOCKS on a ledger problem', () => {
    const report = runGate(
      input({
        ledger: ledger({
          ok: false,
          problems: [{ claimId: 'c1', kind: 'quote_not_in_source', detail: 'quote does not occur' }],
        }),
      })
    );
    expect(report.passed).toBe(false);
    expect(report.findings.some((f) => f.check === 'ledger')).toBe(true);
  });

  it('BLOCKS on a failed factuality verdict', () => {
    const report = runGate(
      input({
        verification: verification({
          blocking: [{ claimId: 'c1', verdict: 'partially_entailed', reason: 'only an association' }],
        }),
      })
    );
    expect(report.passed).toBe(false);
    expect(report.findings.some((f) => f.check === 'factuality')).toBe(true);
  });

  it('BLOCKS a beat that CITES too few claims', () => {
    // A format's claim floors are not advisory.
    const thin = script();
    thin.beats = thin.beats.map((b) => ({ ...b, claimIds: [] }));
    const report = runGate(input({ script: thin }));
    expect(report.passed).toBe(false);
    expect(report.findings.some((f) => f.check === 'evidenceDensity')).toBe(true);
  });

  it('is not satisfied by claims the research merely ASSIGNED to a beat', () => {
    // THE DIFFERENCE IS THE WHOLE CHECK. claimsByBeat counts claims whose
    // beatId says they belong to a beat, which is a fact about the research.
    // One episode's longest beat reached the gate citing zero claims against a
    // floor of seven, and the gate was satisfied because the extractor had
    // assigned it plenty.
    const thin = script();
    thin.beats = thin.beats.map((b) => ({ ...b, claimIds: [] }));
    const report = runGate(
      input({ script: thin, ledger: ledger({ claimsByBeat: { cold_open: 50, payoff: 50 } }) })
    );
    expect(report.findings.some((f) => f.check === 'evidenceDensity')).toBe(true);
  });

  it('says how much of the paid-for research reached the episode', () => {
    // Advisory. Over-researching is not a broken run, but an episode using half
    // of what it paid for is either thin or has lost claims to repair.
    const thin = script();
    thin.beats = thin.beats.map((b, i) => ({ ...b, claimIds: i === 0 ? ['c1'] : [] }));
    const report = runGate(
      input({
        script: thin,
        claims: [claim(), claim({ id: 'c2' }), claim({ id: 'c3' }), claim({ id: 'c4' })],
      })
    );
    const use = report.findings.find((f) => f.check === 'claimUse');
    expect(use).toBeDefined();
    expect(use!.blocking).toBe(false);
    expect(use!.detail).toMatch(/uses 1 of 4/);
  });

  it('BLOCKS a contested claim nobody searched against', () => {
    // The check that separates true from confidently one-sided.
    const report = runGate(input({ claims: [claim({ contested: true })], counterEvidence: [] }));
    expect(report.passed).toBe(false);
    expect(report.findings.some((f) => f.check === 'counterEvidence')).toBe(true);
  });

  it('requires a HUMAN when counter-evidence actually exists', () => {
    // No arithmetic can tell whether the script acknowledges disconfirmation or
    // talks past it.
    const report = runGate(
      input({
        claims: [claim({ contested: true }), claim({ id: 'c2', beatId: 'payoff' }), claim({ id: 'c3', beatId: 'payoff' })],
        counterEvidence: [{ claimId: 'c1', sources: [{ id: 'x' } as never], queries: ['q'] }],
      })
    );
    expect(report.needsHumanReview).toBe(true);
    expect(report.humanReviewReasons.join(' ')).toMatch(/acknowledges them/);
  });

  it('requires a human when a beat rests on T4 sources', () => {
    // Not blocking: a well-framed anecdote is legitimate. But somebody has to
    // have looked at the framing.
    const report = runGate(input({ ledger: ledger({ tierByBeat: { cold_open: 'T4', payoff: 'T1' } }) }));
    expect(report.passed).toBe(true);
    expect(report.needsHumanReview).toBe(true);
    expect(report.humanReviewReasons.join(' ')).toMatch(/one person's account/);
  });

  it('BLOCKS uniform sentence length via the style card', () => {
    const uniform = Array.from({ length: 10 }, (_, i) => `Alpha beta gamma delta ${i}.`).join(' ');
    const report = runGate(input({ script: script(uniform) }));
    expect(report.passed).toBe(false);
    expect(report.findings.some((f) => f.check.startsWith('style:'))).toBe(true);
  });

  it('BLOCKS an episode too similar to an earlier one', () => {
    const report = runGate(input({ priorTexts: [{ label: 'last week', text: GOOD_PROSE }] }));
    expect(report.passed).toBe(false);
    expect(report.findings.some((f) => f.check === 'selfSimilarity')).toBe(true);
    expect(MAX_VOCABULARY_OVERLAP).toBeLessThan(1);
  });

  it('allows an unrelated prior episode', () => {
    const report = runGate(
      input({ priorTexts: [{ label: 'last week', text: 'sourdough proving basket kitchen flour oven' }] })
    );
    expect(report.findings.some((f) => f.check === 'selfSimilarity')).toBe(false);
  });

  it('REPORTS an episode far outside its format length without blocking it', () => {
    // THIS USED TO BLOCK, and blocking it was wrong. A format's target length
    // is a planning number - roughly what shape of story suits the show - and
    // enforcing it on a finished episode makes the writer pad to reach it. The
    // very next episode after the floor was tightened was described as "forced
    // to be long", and the cheapest padding is describing something already
    // described.
    //
    // Still reported, because a big miss is worth knowing about: half the
    // target usually means thin research, double usually means rambling beats.
    // Both worth a look, neither worth refusing to publish over.
    for (const durationS of [60, 900]) {
      const report = runGate(input({ durationS }));
      expect(report.passed).toBe(true);
      const duration = report.findings.find((f) => f.check === 'duration');
      expect(duration).toBeDefined();
      expect(duration!.blocking).toBe(false);
    }
  });

  it('says nothing at all about a duration inside the guide', () => {
    expect(runGate(input({ durationS: 290 })).findings.some((f) => f.check === 'duration')).toBe(
      false
    );
  });

  it('BLOCKS a show making claims about named parties it is not cleared for', () => {
    const report = runGate(
      input({
        claims: [
          claim({ type: 'attribution' }),
          claim({ id: 'c2', beatId: 'payoff' }),
          claim({ id: 'c3', beatId: 'payoff' }),
        ],
      })
    );
    expect(report.passed).toBe(false);
    expect(report.findings.some((f) => f.check === 'riskTier')).toBe(true);
  });

  it('reports every problem at once, so one run tells you everything', () => {
    // Two genuinely blocking problems. This used to pair a ledger fault with a
    // duration miss, and duration stopped blocking when length became a guide
    // rather than a target - so the test was asserting "more than one" against
    // a pair that had quietly become one.
    const report = runGate(
      input({
        ledger: ledger({ ok: false, problems: [{ claimId: 'c1', kind: 'shape', detail: 'x' }] }),
        verification: verification({
          blocking: [{ claimId: 'c2', verdict: 'not_entailed', reason: 'says nothing about it' }],
        }),
      })
    );
    expect(report.findings.filter((f) => f.blocking).length).toBeGreaterThan(1);
    expect(report.findings.filter((f) => f.blocking).map((f) => f.check)).toEqual(
      expect.arrayContaining(['ledger', 'factuality'])
    );
  });
});

describe('formatGateReport', () => {
  // A SHORT DURATION USED TO BE THE HANDY WAY TO MAKE THE GATE FAIL in these
  // formatting tests, and it stopped failing when length became a guide. Using
  // a real blocking fault instead is also a better test: the report's job is to
  // present findings that matter.
  const failing = () =>
    input({
      ledger: ledger({ ok: false, problems: [{ claimId: 'c1', kind: 'shape', detail: 'x' }] }),
    });

  it('says plainly whether it passed', () => {
    expect(formatGateReport(runGate(input()))).toContain('GATE: passed');
    expect(formatGateReport(runGate(failing()))).toContain('GATE: FAILED');
  });

  it('separates blocking from advisory', () => {
    const text = formatGateReport(runGate(failing()));
    expect(text).toContain('Blocking:');
  });

  it('always reports the prose measurements', () => {
    expect(formatGateReport(runGate(input()))).toMatch(/Prose: \d+ words/);
  });
});

describe('beat openers', () => {
  // A repeated beat opening is heard immediately and is invisible to
  // sentence-level opener diversity: four beats opening "Start with..." is four
  // sentences out of two hundred and forty, which no whole-script ratio flags.
  // A real episode did exactly that.

  const withOpenings = (openings: string[]): Script => ({
    ...script(),
    beats: openings.map((text, i) => ({
      beatId: `b${i}`,
      beatType: 'turn' as const,
      turns: [{ speaker: 'host', text }],
      claimIds: [],
      revisions: 0,
    })),
  });

  it('blocks when two beats open the same way', () => {
    const findings = runGate(
      input({
        script: withOpenings([
            'Start with the name, because the pamphlet mostly does not.',
            'Start with the shape of it, before the woman herself.',
        ]),
      })
    ).findings;

    const opener = findings.find((f) => f.check === 'beatOpeners');
    expect(opener?.blocking).toBe(true);
    expect(opener?.detail).toContain('start with');
  });

  it('says how many beats share the opening', () => {
    const findings = runGate(
      input({
        script: withOpenings([
            // The real four, one of which a three-word window would miss.
            'Start with the name of her.',
            'Start with the shape of it.',
            "Start with what's dated here.",
        ]),
      })
    ).findings;

    expect(findings.find((f) => f.check === 'beatOpeners')?.detail).toContain('opens 3 beats');
  });

  it('passes when the beats open differently', () => {
    const findings = runGate(
      input({
        script: withOpenings([
            'The Justiciary Court clerk wrote down one confession.',
            'Nobody had written the other two up, which happens.',
            'By two in the morning the corridor had gone quiet.',
        ]),
      })
    ).findings;

    expect(findings.find((f) => f.check === 'beatOpeners')).toBeUndefined();
  });

  it('compares the opening WORDS, not the whole sentence', () => {
    // Two beats opening "Start with" are the same tell whether or not the rest
    // of the sentence differs, which is the entire point.
    const findings = runGate(
      input({
        script: withOpenings([
            'Start with the completely different first thing.',
            'Start with the entirely unrelated second thing.',
        ]),
      })
    ).findings;

    expect(findings.find((f) => f.check === 'beatOpeners')).toBeDefined();
  });
});

describe("a show's own evidence policy", () => {
  /**
   * Tiers have been recorded on every claim since the ledger existed, and until
   * now nothing could refuse one. Right for most shows, wrong for a health
   * show: a claim sourced to a news write-up of a press release about a
   * preprint passes every other check and is still not evidence about the
   * world.
   */
  const src = (id: string, over: Partial<Source> = {}): Source =>
    ({
      id,
      url: `https://example.test/${id}`,
      title: id,
      retrievedAt: '2026-09-13T00:00:00.000Z',
      contentHash: id,
      tier: 'T1',
      text: 'x'.repeat(500),
      httpStatus: 200,
      ...over,
    }) as unknown as Source;

  const strict = (over: Record<string, unknown>) =>
    parsePersona(
      PERSONA_YAML.replace('allowedRiskTiers:', `${Object.entries(over)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : String(v)}`)
        .join('\n')}\nallowedRiskTiers:`)
    );

  it('BLOCKS a source weaker than the show will rest on', () => {
    const report = runGate(
      input({
        persona: strict({ minSourceTier: 'T2' }),
        claims: [claim({ sourceId: 's1' })],
        sources: [src('s1', { tier: 'T3' })],
      })
    );
    expect(report.findings.some((f) => f.check === 'sourceTier' && f.blocking)).toBe(true);
  });

  it('accepts a source at or above the floor', () => {
    const report = runGate(
      input({
        persona: strict({ minSourceTier: 'T2' }),
        claims: [claim({ sourceId: 's1' })],
        sources: [src('s1', { tier: 'T1' })],
      })
    );
    expect(report.findings.some((f) => f.check === 'sourceTier')).toBe(false);
  });

  it('BLOCKS a source older than the show wants', () => {
    const report = runGate(
      input({
        persona: strict({ maxSourceAgeDays: 30 }),
        claims: [claim({ sourceId: 's1' })],
        sources: [src('s1', { publishedAt: '2026-01-01T00:00:00.000Z' })],
        now: new Date('2026-09-13T00:00:00.000Z'),
      })
    );
    expect(report.findings.some((f) => f.check === 'sourceAge' && f.blocking)).toBe(true);
  });

  it('says nothing about age when the source does not declare one', () => {
    // An undated document is not a stale one, and guessing would reject most
    // primary records.
    const report = runGate(
      input({
        persona: strict({ maxSourceAgeDays: 30 }),
        claims: [claim({ sourceId: 's1' })],
        sources: [src('s1')],
        now: new Date('2026-09-13T00:00:00.000Z'),
      })
    );
    expect(report.findings.some((f) => f.check === 'sourceAge')).toBe(false);
  });

  it('does nothing at all for a show with no policy', () => {
    // A 1732 army report is not out of date, and a myth retelling citing a
    // Victorian translation is not badly sourced.
    const report = runGate(input({ claims: [claim({ sourceId: 's1' })], sources: [src('s1', { tier: 'T4' })] }));
    expect(report.findings.some((f) => f.check === 'sourceTier' || f.check === 'sourceAge')).toBe(
      false
    );
  });
});
