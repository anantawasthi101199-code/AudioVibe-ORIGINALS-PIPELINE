import { parsePersona } from '../../canon/load';
import { parseFormat } from '../../formats/load';
import { Claim, LedgerReport } from '../../evidence/claim';
import { VerificationReport } from '../../evidence/verify';
import { Script } from '../../script/write';
import { GateInput, MAX_VOCABULARY_OVERLAP, runGate, formatGateReport } from '../gate';

const PERSONA = parsePersona(`
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
`);

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

  it('BLOCKS a beat below its evidence floor', () => {
    // A format's claim floors are not advisory.
    const report = runGate(input({ ledger: ledger({ claimsByBeat: { cold_open: 1, payoff: 1 } }) }));
    expect(report.passed).toBe(false);
    expect(report.findings.some((f) => f.check === 'evidenceDensity')).toBe(true);
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

  it('BLOCKS an episode far outside its format length', () => {
    expect(runGate(input({ durationS: 60 })).passed).toBe(false);
    expect(runGate(input({ durationS: 900 })).passed).toBe(false);
  });

  it('allows modest duration drift', () => {
    expect(runGate(input({ durationS: 290 })).passed).toBe(true);
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
    const report = runGate(
      input({
        durationS: 60,
        ledger: ledger({ ok: false, problems: [{ claimId: 'c1', kind: 'shape', detail: 'x' }] }),
      })
    );
    expect(report.findings.filter((f) => f.blocking).length).toBeGreaterThan(1);
  });
});

describe('formatGateReport', () => {
  it('says plainly whether it passed', () => {
    expect(formatGateReport(runGate(input()))).toContain('GATE: passed');
    expect(formatGateReport(runGate(input({ durationS: 10 })))).toContain('GATE: FAILED');
  });

  it('separates blocking from advisory', () => {
    const text = formatGateReport(runGate(input({ durationS: 10 })));
    expect(text).toContain('Blocking:');
  });

  it('always reports the prose measurements', () => {
    expect(formatGateReport(runGate(input()))).toMatch(/Prose: \d+ words/);
  });
});
