/**
 * The roster, and the check that a name is not used before the listener has
 * been told whose it is.
 *
 * The example throughout is the real one. In the first solo episode Carl Wood
 * WALKED OUT OF THE VAULT in the `wrong` beat having never been introduced, and
 * Hugh Doyle was SENTENCED in `payoff` having never appeared at all. Nothing in
 * the pipeline could see it, because each beat was written by a call that knew
 * the story so far but had no roster to check a name against.
 */
import { StoryPlan, checkCast, planBrief, storyPlanSchema } from '../plan';

const PLAN: StoryPlan = storyPlanSchema.parse({
  spine: 'Six men drilled into a vault over a bank holiday, failed, and went back the next night.',
  cast: [
    { name: 'Brian Reader', who: 'the oldest of them, brought in for his name', introducedIn: 'before' },
    { name: 'Carl Wood', who: 'the one who walked out with Reader', introducedIn: 'before' },
    { name: 'Hugh Doyle', who: 'the plumber who let them park behind his shop', introducedIn: 'wrong' },
  ],
  beats: [
    { beatId: 'cold_open', happens: 'The alarm goes off and nobody comes.', leaves: '' },
    { beatId: 'before', happens: 'Who they were, and the first night.', leaves: '' },
    { beatId: 'wrong', happens: 'The second night.', leaves: '' },
    { beatId: 'payoff', happens: 'What they took and what it cost them.', leaves: '' },
  ],
});

describe('checkCast', () => {
  it('catches a man who acts before he is introduced', () => {
    // The actual sentence from the episode, in the actual beat it was in.
    const problems = checkCast(
      'Brian Reader decides he has had enough. So does Carl Wood.',
      PLAN,
      'cold_open'
    );
    expect(problems.join(' ')).toContain('Carl Wood');
    expect(problems.join(' ')).toContain('Brian Reader');
  });

  it('allows a name once its introducing beat has been reached', () => {
    expect(checkCast('Brian Reader liked antique clocks.', PLAN, 'before')).toEqual([]);
    expect(checkCast('Brian Reader liked antique clocks.', PLAN, 'payoff')).toEqual([]);
  });

  it('matches on the surname alone, because that is how a beat refers back', () => {
    expect(checkCast('Doyle got a suspended sentence.', PLAN, 'before')).toHaveLength(1);
  });

  it('does not fire on a word that merely contains a name', () => {
    // "Reader" inside "readers" would make this check fire on prose about the
    // audience, which is the kind of false positive that gets a check deleted.
    expect(checkCast('Readership of the case files was limited.', PLAN, 'cold_open')).toEqual([]);
  });

  it('ignores a plan whose beat is not in this format', () => {
    expect(checkCast('Carl Wood.', PLAN, 'not_a_beat')).toEqual([]);
  });
});

describe('planBrief', () => {
  it('tells the writer who may be named, who to introduce, and who to hold back', () => {
    const brief = planBrief(PLAN, 'before');
    expect(brief).toContain('YOU INTRODUCE THESE');
    expect(brief).toContain('Carl Wood');
    // Doyle comes later and must not be named yet.
    expect(brief).toMatch(/Do NOT name these yet[^\n]*Hugh Doyle/);
  });

  it('says plainly when nobody has been introduced yet', () => {
    expect(planBrief(PLAN, 'cold_open')).toContain('Nobody has been introduced yet');
  });

  it('still works for a plan with no cast, so an old checkpoint does not crash', () => {
    const old = storyPlanSchema.parse({ spine: 'x', beats: [{ beatId: 'a', happens: 'y' }] });
    expect(planBrief(old, 'a')).toContain('THE WHOLE EPISODE');
  });
});
