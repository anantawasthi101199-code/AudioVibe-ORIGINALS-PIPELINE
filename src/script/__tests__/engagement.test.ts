/**
 * The engagement layer: open loops, hooks, and keeping two hosts distinct.
 *
 * These are the rules that decide whether anyone stays past eight seconds, so
 * what is pinned here is mostly what must be REFUSED - an opening that answers
 * itself, an episode that resolves too early, and two hosts who have quietly
 * become the same person.
 */
import { parsePersona } from '../../canon/load';
import { loadFormat } from '../../formats/load';
import { checkLoopStructure, loopBrief, loopDebt, openBefore } from '../loops';
import { HOOK_MAX_WORDS, rankHooks, scoreHook } from '../hooks';
import {
  BACKCHANNEL_BAND,
  checkVoices,
  isBackchannel,
  measureHost,
  MIN_TURN_LENGTH_RATIO,
} from '../voices';

const loops = [
  { id: 'anomaly', question: 'Why does this not add up?' },
  { id: 'cost', question: 'What did it cost?' },
];

const beat = (id: string, opens: string[] = [], closes: string[] = []) => ({
  id,
  type: id,
  opens,
  closes,
});

describe('open loops', () => {
  it('accepts a well-shaped episode', () => {
    const problems = checkLoopStructure(loops, [
      beat('cold_open', ['anomaly']),
      beat('stakes', ['cost']),
      beat('context'),
      beat('mechanism'),
      beat('payoff', [], ['anomaly']),
      beat('reckoning', [], ['cost']),
    ]);
    expect(problems).toEqual([]);
  });

  it('REFUSES an opening that closes a loop', () => {
    // The rule the whole design turns on. An open loop at the start holds
    // attention for the whole runtime; a closed one lets the listener leave
    // satisfied in the first ten seconds.
    const problems = checkLoopStructure(loops, [
      beat('cold_open', ['anomaly'], ['anomaly']),
      beat('payoff', ['cost'], []),
      beat('end', [], ['cost']),
    ]);
    expect(problems.map((p) => p.rule)).toContain('loopClosedWhereOpened');
  });

  it('REFUSES an opening that opens nothing', () => {
    const problems = checkLoopStructure(loops, [
      beat('cold_open'),
      beat('stakes', ['anomaly', 'cost']),
      beat('payoff', [], ['anomaly', 'cost']),
    ]);
    expect(problems.map((p) => p.rule)).toContain('openingOpensNothing');
  });

  it('REFUSES an episode that resolves everything too early', () => {
    // Once nothing is unresolved there is no reason to keep listening, and the
    // remaining beats are runtime the listener has no motive to hear.
    const problems = checkLoopStructure(loops, [
      beat('cold_open', ['anomaly']),
      beat('payoff', [], ['anomaly']),
      beat('filler_a', ['cost']),
      beat('filler_b', [], ['cost']),
      beat('filler_c'),
      beat('filler_d'),
      beat('filler_e'),
      beat('outro'),
    ]);
    expect(problems.map((p) => p.rule)).toContain('resolvedTooEarly');
  });

  it('refuses a loop closed before anything opened it', () => {
    const problems = checkLoopStructure(loops, [
      beat('cold_open', ['anomaly'], ['cost']),
      beat('payoff', ['cost'], ['anomaly']),
    ]);
    expect(problems.map((p) => p.rule)).toContain('closedBeforeOpened');
  });

  it('refuses a dangling loop unless the format is serialised', () => {
    const beats = [beat('cold_open', ['anomaly']), beat('mid', ['cost']), beat('payoff', [], ['anomaly'])];
    expect(checkLoopStructure(loops, beats).map((p) => p.rule)).toContain('danglingLoop');
    // A serialised show hands over to the next episode on purpose.
    expect(
      checkLoopStructure(loops, beats, { allowDangling: true }).map((p) => p.rule)
    ).not.toContain('danglingLoop');
  });

  it('catches a reference to a loop nobody declared', () => {
    const problems = checkLoopStructure(loops, [beat('cold_open', ['ghost']), beat('end', [], ['ghost'])]);
    expect(problems.map((p) => p.rule)).toContain('unknownLoop');
  });

  it('lets a format opt out entirely by declaring none', () => {
    // Legitimate for a trivial format. A test below asserts the real shows
    // cannot opt out.
    expect(checkLoopStructure([], [beat('a'), beat('b')])).toEqual([]);
  });

  it('tracks how many questions are open after each beat', () => {
    const debt = loopDebt([
      beat('cold_open', ['anomaly']),
      beat('stakes', ['cost']),
      beat('payoff', [], ['anomaly']),
      beat('reckoning', [], ['cost']),
    ]);
    expect(debt).toEqual([1, 2, 1, 0]);
  });

  it('tells the writer what to leave unanswered', () => {
    const beats = [beat('cold_open', ['anomaly']), beat('stakes', ['cost']), beat('payoff', [], ['anomaly'])];
    const brief = loopBrief(beats[1]!, loops, openBefore(beats, 1));

    expect(brief).toMatch(/OPEN this question, and DO NOT ANSWER IT.*What did it cost/s);
    // The one carried in from the cold open must stay shut.
    expect(brief).toMatch(/STILL UNANSWERED.*not add up/s);
  });
});

describe('hooks', () => {
  const strong = 'Twenty-seven men walked into that forest in 1943 and twenty-six walked back out again.';

  it('rewards a specific, unresolved opening', () => {
    const scored = scoreHook(strong);
    expect(scored.score).toBeGreaterThan(0);
    expect(scored.notes.join(' ')).toMatch(/number/);
  });

  it('PUNISHES an opening that announces the episode', () => {
    // "Today we're looking at" tells the listener they are about to be told
    // something, which invites them to decide whether they want to be.
    expect(scoreHook("Today we're looking at a strange case from 1943 involving soldiers.").score)
      .toBeLessThan(0);
    expect(scoreHook('So, this one is genuinely strange, and I want to talk about it.').score)
      .toBeLessThan(0);
  });

  it('PUNISHES an opening that answers itself', () => {
    // A hook containing "because" has usually closed the gap it opened.
    const selfAnswering = 'Twenty-six of the twenty-seven came back, because the last man had already gone home.';
    expect(scoreHook(selfAnswering).notes.join(' ')).toMatch(/closes the gap/);
  });

  it('punishes vagueness where a specific word belongs', () => {
    const vague = 'Something incredible and shocking happened to these people and it is amazing.';
    expect(scoreHook(vague).score).toBeLessThan(scoreHook(strong).score);
  });

  it('punishes asking the question outright', () => {
    // Making the listener ask it is stronger than asking it for them.
    const asked = 'What happened to the twenty-seven men who walked into that forest in 1943?';
    expect(scoreHook(asked).score).toBeLessThan(scoreHook(strong).score);
  });

  it('punishes an opening too long for the gap to land early', () => {
    const long = `${strong} ${'And there is more to it than that. '.repeat(6)}`;
    expect(scoreHook(long).notes.join(' ')).toMatch(/gap arrives late/);
    expect(HOOK_MAX_WORDS).toBeGreaterThan(20);
  });

  it('ranks best-first and drops the unusable', () => {
    const ranked = rankHooks([
      "Today we're looking at a forest.",
      strong,
      'Something amazing happened.',
    ]);
    expect(ranked[0]!.text).toBe(strong);
    expect(ranked.map((r) => r.text)).not.toContain('Something amazing happened.');
  });
});

describe('keeping two hosts distinct', () => {
  const show = parsePersona(`
id: t
handle: t
name: T
category: Educational
thesis: x
audience: y
register: z
hosts:
  - id: teller
    name: Nadia
    role: Holds the documents.
    idiolect: {turnWordsMean: 48, questionRate: 0.1, backchannelRate: 0.02, signature: ["the document says"]}
    voice: {provider: elevenlabs, voiceId: v1}
  - id: presser
    name: Theo
    role: Presses.
    idiolect: {turnWordsMean: 16, questionRate: 0.45, backchannelRate: 0.25, signature: ["hang on"]}
    voice: {provider: elevenlabs, voiceId: v2}
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

  const long = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

  // One host holds the floor, the other reacts. Varied lengths throughout.
  const natural = [
    { speaker: 'teller', text: long(55) },
    { speaker: 'presser', text: 'Hang on. Who signed it?' },
    { speaker: 'teller', text: long(48) },
    { speaker: 'presser', text: 'Right.' },
    { speaker: 'teller', text: long(60) },
    { speaker: 'presser', text: 'And nobody checked that for eleven weeks?' },
    { speaker: 'teller', text: long(40) },
    { speaker: 'presser', text: 'Mm.' },
  ];

  it('accepts a conversation where the two sound different', () => {
    const { problems } = checkVoices(natural, show.hosts);
    expect(problems.filter((p) => p.blocking)).toEqual([]);
  });

  it('BLOCKS two hosts who have converged to the same turn length', () => {
    // The most common way an AI two-hander falls apart, and invisible on
    // read-through because every individual line is fine.
    const converged = Array.from({ length: 8 }, (_, i) => ({
      speaker: i % 2 === 0 ? 'teller' : 'presser',
      text: long(30 + (i % 3) * 12),
    }));
    const { problems } = checkVoices(converged, show.hosts);
    expect(problems.map((p) => p.rule)).toContain('voicesConverged');
    expect(MIN_TURN_LENGTH_RATIO).toBeGreaterThan(1);
  });

  it('BLOCKS a flat turn rhythm', () => {
    // Real conversation puts a four-word turn next to a sixty-word one.
    const flat = Array.from({ length: 8 }, (_, i) => ({
      speaker: i % 2 === 0 ? 'teller' : 'presser',
      text: long(i % 2 === 0 ? 26 : 24),
    }));
    expect(checkVoices(flat, show.hosts).problems.map((p) => p.rule)).toContain('flatTurnRhythm');
  });

  it('BLOCKS a host using the other host s signature phrase', () => {
    // A shared tic is worse than none, because it actively merges the voices.
    const borrowed = [...natural, { speaker: 'teller', text: 'Hang on, that is not right.' }];
    const { problems } = checkVoices(borrowed, show.hosts);
    expect(problems.map((p) => p.rule)).toContain('borrowedSignature');
  });

  it('flags too few acknowledgements as two monologues alternating', () => {
    const noReacts = [
      { speaker: 'teller', text: long(55) },
      { speaker: 'presser', text: long(18) },
      { speaker: 'teller', text: long(60) },
      { speaker: 'presser', text: long(14) },
      { speaker: 'teller', text: long(45) },
      { speaker: 'presser', text: long(20) },
    ];
    expect(checkVoices(noReacts, show.hosts).problems.map((p) => p.rule)).toContain('noBackchannels');
  });

  it('flags wall-to-wall agreement too, because both extremes read as fake', () => {
    const agreeing = [
      { speaker: 'teller', text: long(60) },
      { speaker: 'presser', text: 'Right.' },
      { speaker: 'presser', text: 'Mm.' },
      { speaker: 'presser', text: 'Exactly.' },
      { speaker: 'presser', text: 'Yeah.' },
      { speaker: 'teller', text: long(40) },
    ];
    expect(checkVoices(agreeing, show.hosts).problems.map((p) => p.rule)).toContain(
      'tooManyBackchannels'
    );
    expect(BACKCHANNEL_BAND[0]).toBeGreaterThan(0);
  });

  it('recognises acknowledgement turns without catching short real ones', () => {
    expect(isBackchannel({ speaker: 'a', text: 'Right.' })).toBe(true);
    expect(isBackchannel({ speaker: 'a', text: '[laughs] Mm.' })).toBe(true);
    expect(isBackchannel({ speaker: 'a', text: 'Four million pounds.' })).toBe(false);
  });

  it('measures each host separately', () => {
    const m = measureHost('presser', natural, show.hosts);
    expect(m.turns).toBe(4);
    expect(m.turnWordsMean).toBeLessThan(measureHost('teller', natural, show.hosts).turnWordsMean);
    expect(m.questionRate).toBeGreaterThan(0);
  });

  it('does not judge convergence on an exchange too short to show it', () => {
    const short = [
      { speaker: 'teller', text: long(20) },
      { speaker: 'presser', text: long(18) },
    ];
    expect(checkVoices(short, show.hosts).problems.map((p) => p.rule)).not.toContain(
      'voicesConverged'
    );
  });
});

describe('the shipped formats', () => {
  it('all declare loops - a real show cannot opt out', () => {
    const format = loadFormat('case-study-teardown');
    expect(format.loops.length).toBeGreaterThan(0);
    expect(format.beats[0]!.opens.length).toBeGreaterThan(0);
    expect(format.beats[0]!.closes).toEqual([]);
  });
});
