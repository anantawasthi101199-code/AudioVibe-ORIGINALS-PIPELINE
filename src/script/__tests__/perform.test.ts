/**
 * The performance pass is allowed to rewrite prose, which means it is capable of
 * inventing. These tests pin the guard that stops it.
 *
 * The pipeline has already been caught inventing something that read beautifully:
 * the seven items taken from Inanna at the seven gates, of which the evidence
 * supported one. A prompt saying "do not add facts" is the same kind of
 * instruction that failed on the writer, the extractor and the question rate.
 */
import { checkNoNewFacts, MAX_SHRINK, PERFORMANCE_GUIDANCE, performanceSystem } from '../perform';
import { loadPersona } from '../../canon/load';

describe('checkNoNewFacts', () => {
  it('says nothing when the polish only moved words around', () => {
    const before = 'Inanna walked to the gate. The crown was taken from her head there.';
    const after = 'Inanna walked to the gate. There, the crown was taken from her head.';
    expect(checkNoNewFacts(before, after).added).toEqual([]);
  });

  it('catches a number the draft did not have', () => {
    // The real case: the claims say she was hung on a hook and do not say for how
    // long, and a script said "for three days and three nights".
    const before = 'Her body was hung from a hook on the wall, left there in view.';
    const after = 'Her body hung from a hook for 3 days, left there in view.';
    expect(checkNoNewFacts(before, after).added).toContain('3');
  });

  it('catches a name the draft did not have', () => {
    const before = 'The gatekeeper let her through, one gate at a time.';
    const after = 'Neti the gatekeeper let her through, one gate at a time.';
    expect(checkNoNewFacts(before, after).added).toContain('neti');
  });

  it('allows a name to move to the front of a sentence', () => {
    // A capital at the start of a sentence says nothing about whether it is a
    // name, so moving one there must not read as an addition.
    const before = 'The crown was taken from Inanna at the first gate.';
    const after = 'Inanna lost the crown at the first gate.';
    expect(checkNoNewFacts(before, after).added).toEqual([]);
  });

  it('is not fooled by punctuation on a number', () => {
    const before = 'It ran to 1,400 lines across fifty tablets.';
    const after = 'It ran to 1,400 lines. Fifty tablets carried it.';
    expect(checkNoNewFacts(before, after).added).toEqual([]);
  });

  it('ignores delivery tags, which are not words anybody hears', () => {
    const before = 'She went down to the gate and knocked.';
    const after = '[quietly] She went down to the gate. [pauses] And knocked.';
    expect(checkNoNewFacts(before, after).added).toEqual([]);
  });
});

describe('the performance prompt', () => {
  const persona = loadPersona('mythic-archives');

  it('states the no-new-facts rule as overriding', () => {
    const system = performanceSystem(persona);
    expect(system).toMatch(/may not add a fact/i);
    expect(system).toMatch(/discarded/i);
  });

  it('tells it not to make the script longer', () => {
    // A polish pass that grows is a pass that is writing, and writing is where
    // invention comes from.
    expect(performanceSystem(persona)).toMatch(/may not[\s\S]*longer|Make it longer/i);
  });

  it('is about delivery rather than craft', () => {
    // Every line has to be something a good writer would not know from the text
    // alone. "Write well" produces a model's idea of well-written, which is the
    // flat thing this network keeps cutting out.
    expect(PERFORMANCE_GUIDANCE.join(' ')).not.toMatch(/\bwrite well\b|\bbe vivid\b|\bengaging\b/i);
    expect(PERFORMANCE_GUIDANCE.join(' ')).toMatch(/breath|ear|aloud|listener/i);
  });

  it('keeps a shrink floor, so cutting content is not mistaken for polish', () => {
    expect(MAX_SHRINK).toBeGreaterThan(0.5);
    expect(MAX_SHRINK).toBeLessThan(1);
  });
});

/**
 * CONTRACTIONS AND POSSESSIVES, which rejected a whole performance pass.
 *
 * The pass turned "that is" into "that's" - the exact spoken-English edit it exists
 * to make - and the guard reported it as an invented fact, so the entire polish was
 * discarded. Third false positive from a heuristic guard of mine in one session,
 * and the lesson each time is the same: validate a guard against real output before
 * letting it decide anything.
 */
describe('checkNoNewFacts - word forms', () => {
  it('allows a contraction of words already in the draft', () => {
    const before = 'That is where the oldest copy stops.';
    const after = "That's where the oldest copy stops.";
    expect(checkNoNewFacts(before, after).added).toEqual([]);
  });

  it('allows a possessive of a name already in the draft', () => {
    const before = 'The crown of Inanna was taken at the gate.';
    const after = "Inanna's crown was taken at the gate.";
    expect(checkNoNewFacts(before, after).added).toEqual([]);
  });

  it('still catches a genuinely new name in possessive form', () => {
    const before = 'The crown was taken at the gate.';
    const after = "Ereshkigal's gatekeeper took the crown at the gate.";
    // Reported as the word that actually appeared, apostrophe and all, because the
    // message exists for somebody reading the script to find the sentence.
    expect(checkNoNewFacts(before, after).added).toContain("ereshkigal's");
  });
});

/**
 * WHO IS SPEAKING BELONGS TO THE DRAFT, AND THIS PASS USED TO BE ABLE TO CHANGE IT.
 *
 * A solo myth episode came back from the performance pass with every turn
 * relabelled "host" against a persona whose one host is "narrator". Nothing
 * between here and the render looks at a speaker id, so the run died at the
 * render itself with `no voice for speaker "host" (have: narrator)` - after the
 * research, the script and this pass had all been paid for, at the one stage
 * that spends real money and the last one that could have caught it.
 *
 * The cause was two halves of the same omission: the prompt never said what the
 * valid ids were, and the reassembly took `t.speaker` from the reply verbatim.
 */
describe('the speaker id survives the performance pass', () => {
  const solo = loadPersona('mythic-archives');

  it('names the valid ids in the prompt', () => {
    const system = performanceSystem(solo);

    expect(system).toContain('"narrator"');
    expect(system).toMatch(/SPEAKER IDS ARE FIXED/i);
  });

  it('puts a real id in the return shape rather than a placeholder', () => {
    // The placeholder was the bug. A model shown {"speaker": "..."} invents a
    // plausible label, and "host" is the most plausible one there is.
    const system = performanceSystem(solo);

    expect(system).toContain('{"speaker": "narrator"');
    expect(system).not.toContain('{"speaker": "..."');
  });

  it('the show under test really does have one host called narrator', () => {
    // So that a persona rename turns this file red rather than making the
    // assertions above quietly vacuous.
    expect(solo.hosts.map((h) => h.id)).toEqual(['narrator']);
  });
})
