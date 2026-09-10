/**
 * Continuity checking, which is to fiction what verification is to reporting.
 *
 * The failures pinned here are the ones that would let a series rot quietly:
 * a checker that stays silent about a fact being read as approval, a revisable
 * fact being enforced so the twist can never land, and a failed episode
 * entering the bible so every later one is checked against something nobody
 * heard.
 */
import { LlmClient, LlmRequest, LlmResponse } from '../../models/client';
import { Script } from '../../script/write';
import { Bible } from '../bible';
import {
  applyEpisode,
  checkContinuity,
  obviousContradictions,
  unknownNames,
} from '../continuity';

const script = (text: string, title = 'An episode'): Script => ({
  title,
  description: 'x',
  beats: [
    {
      beatId: 'cold_open',
      beatType: 'cold_open',
      turns: [{ speaker: 'senior', text }],
      claimIds: [],
      revisions: 0,
    },
  ],
});

const bible: Bible = {
  personaId: 'night-shift',
  entities: [
    {
      id: 'ruth',
      kind: 'character',
      name: 'Ruth',
      summary: 'Charge nurse.',
      introducedIn: 'ep1',
      facts: [
        { text: 'Ruth has 3 sisters.', episodeId: 'ep1', revisable: false },
        { text: 'Ruth believes her brother is dead.', episodeId: 'ep2', revisable: true },
      ],
    },
  ],
  episodes: [{ id: 'ep1', title: 'Handover', synopsis: 'A quiet night.' }],
};

const cannedChecker = (text: string): LlmClient & { seen: LlmRequest[] } => {
  const seen: LlmRequest[] = [];
  return {
    name: 'canned',
    model: 'checker-1',
    seen,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      seen.push(req);
      return { text, inputTokens: 1, outputTokens: 1, costPence: 0.3, model: 'checker-1' };
    },
  };
};

describe('checkContinuity', () => {
  it('reports a contradiction as blocking', async () => {
    const checker = cannedChecker('[{"index":0,"verdict":"contradicts","reason":"she has two"}]');
    const report = await checkContinuity(script('Ruth and her two sisters.'), bible, checker);

    expect(report.blocking).toHaveLength(1);
    expect(report.blocking[0]!.entityName).toBe('Ruth');
  });

  it('treats UNCLEAR as blocking', async () => {
    // Same call the evidence lane makes on partially_entailed. A checker that
    // cannot tell whether the episode contradicts the series has not
    // established that it does not.
    const checker = cannedChecker('[{"index":0,"verdict":"unclear","reason":"ambiguous"}]');
    const report = await checkContinuity(script('Ruth mentioned family.'), bible, checker);

    expect(report.blocking).toHaveLength(1);
  });

  it('treats a fact the checker SKIPPED as unclear, not as consistent', async () => {
    // The failure that would let a truncated response wave through the whole
    // bible. Silence about a fact is the same as being unable to tell.
    const checker = cannedChecker('[]');
    const report = await checkContinuity(script('Something happened.'), bible, checker);

    expect(report.findings[0]!.verdict).toBe('unclear');
    expect(report.blocking).toHaveLength(1);
  });

  it('does not check revisable facts', async () => {
    // Fiction turns on things being revealed as untrue. Enforcing a belief
    // would forbid the twist, which is a check working against what it
    // protects.
    const checker = cannedChecker('[{"index":0,"verdict":"consistent","reason":"fine"}]');
    await checkContinuity(script('Her brother walked in.'), bible, checker);

    expect(checker.seen[0]!.prompt).not.toContain('brother is dead');
  });

  it('costs nothing on a first episode', async () => {
    // Nothing established, nothing to contradict. Not an early return that
    // skips the report - the unknown-name list still matters, because a first
    // episode is exactly where the cast gets decided.
    const checker = cannedChecker('[]');
    const empty: Bible = { personaId: 'night-shift', entities: [], episodes: [] };
    const report = await checkContinuity(script('Somebody said Ruth arrived.'), empty, checker);

    expect(checker.seen).toHaveLength(0);
    expect(report.costPence).toBe(0);
    expect(report.unknownEntities).toContain('Ruth');
  });

  it('checks the whole bible in one call', async () => {
    // One call rather than one per fact: every fact is checked against the
    // SAME script, so per-fact calls would re-send the expensive half of the
    // prompt each time for no gain in isolation.
    const many: Bible = {
      ...bible,
      entities: [
        {
          ...bible.entities[0]!,
          facts: Array.from({ length: 10 }, (_, i) => ({
            text: `Fact number ${i}.`,
            episodeId: 'ep1',
            revisable: false,
          })),
        },
      ],
    };

    const checker = cannedChecker(
      JSON.stringify(
        Array.from({ length: 10 }, (_, i) => ({ index: i, verdict: 'consistent', reason: '' }))
      )
    );
    await checkContinuity(script('Anything.'), many, checker);

    expect(checker.seen).toHaveLength(1);
  });

  it('blocks on an arithmetic contradiction even when the model says consistent', async () => {
    // The deterministic pass is kept alongside the model's answer rather than
    // replaced by it. A model that reads "her 2 sisters" as consistent with
    // "3 sisters" is wrong, and its opinion does not overturn arithmetic.
    const checker = cannedChecker('[{"index":0,"verdict":"consistent","reason":"looks fine"}]');
    const report = await checkContinuity(script('Ruth and her 2 sisters.'), bible, checker);

    expect(report.blocking.map((f) => f.reason)).toContain(
      'the bible says 3 sisters, the script says 2'
    );
  });

  it('names the checker, so a report says who checked it', async () => {
    const checker = cannedChecker('[{"index":0,"verdict":"consistent","reason":""}]');
    const report = await checkContinuity(script('x'), bible, checker);
    expect(report.checkerModel).toBe('checker-1');
  });
});

describe('unknownNames', () => {
  it('finds a name the bible has never heard of', () => {
    expect(unknownNames(script('She called for Marguerite immediately.'), bible)).toContain(
      'Marguerite'
    );
  });

  it('does not flag a name the bible knows', () => {
    expect(unknownNames(script('She told Ruth about it.'), bible)).not.toContain('Ruth');
  });

  it('does not flag ordinary words at the start of a sentence', () => {
    // The reason this check is advisory rather than blocking: capitalised
    // words are a poor proxy for proper nouns, and sentence openers would
    // otherwise drown the real findings.
    expect(unknownNames(script('Nothing happened. Everything was quiet.'), bible)).toEqual([]);
  });
});

describe('obviousContradictions', () => {
  it('catches a different number in the same frame', () => {
    const found = obviousContradictions(script('Ruth and her 2 sisters were waiting.'), bible);
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toContain('says 2');
  });

  it('does not fire on the same number', () => {
    expect(obviousContradictions(script('Ruth and her 3 sisters.'), bible)).toEqual([]);
  });

  it('does not fire on a number in an unrelated frame', () => {
    // A deterministic check that produces false positives gets switched off,
    // and then it catches nothing. This one stays narrow on purpose.
    expect(obviousContradictions(script('Ruth waited 2 hours.'), bible)).toEqual([]);
  });

  it('ignores revisable facts', () => {
    expect(obviousContradictions(script('Ruth has 9 brothers.'), bible)).toEqual([]);
  });

  it('does not fire when the entity is not in the episode at all', () => {
    expect(obviousContradictions(script('Femi counted 2 sisters on the ward.'), bible)).toEqual([]);
  });
});

describe('applyEpisode', () => {
  const extracted = {
    newEntities: [
      { id: 'femi', kind: 'character' as const, name: 'Femi', summary: 'Two years in.' },
    ],
    facts: [
      { entityId: 'femi', text: 'Femi trained in Leeds.', revisable: false },
      { entityId: 'ruth', text: 'Ruth kept the letter.', revisable: true },
    ],
    synopsis: 'A letter arrived.',
  };

  it('adds new entities and their facts', () => {
    const next = applyEpisode(bible, extracted, { id: 'ep2', title: 'The Letter' });
    const femi = next.entities.find((e) => e.id === 'femi');

    expect(femi?.introducedIn).toBe('ep2');
    expect(femi?.facts[0]!.text).toBe('Femi trained in Leeds.');
  });

  it('appends to an entity that already exists rather than replacing it', () => {
    const next = applyEpisode(bible, extracted, { id: 'ep2', title: 'The Letter' });
    const ruth = next.entities.find((e) => e.id === 'ruth');

    expect(ruth?.facts).toHaveLength(3);
    expect(ruth?.introducedIn).toBe('ep1');
  });

  it('DROPS a fact pointing at nothing rather than inventing an entity for it', () => {
    // Silently creating an entity to hang an orphan fact on is how a bible
    // fills with one-fact entities nobody named. The fact is still recoverable
    // from the run artifact if it mattered.
    const orphan = { ...extracted, facts: [{ entityId: 'nobody', text: 'x', revisable: false }] };
    const next = applyEpisode(bible, orphan, { id: 'ep2', title: 'x' });

    expect(next.entities.map((e) => e.id)).not.toContain('nobody');
  });

  it('does not mutate the bible it was given', () => {
    // Pure, so a caller can look at the result before writing it and a failed
    // episode leaves the series exactly as it found it.
    const before = JSON.stringify(bible);
    applyEpisode(bible, extracted, { id: 'ep2', title: 'x' });
    expect(JSON.stringify(bible)).toBe(before);
  });

  it('records the episode in listening order', () => {
    const next = applyEpisode(bible, extracted, { id: 'ep2', title: 'The Letter' });
    expect(next.episodes.map((e) => e.id)).toEqual(['ep1', 'ep2']);
  });
});
