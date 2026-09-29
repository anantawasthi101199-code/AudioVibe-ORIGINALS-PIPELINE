/**
 * Telling the story rather than reporting the scholarship.
 *
 * EVERY CASE HERE IS A SENTENCE FROM A REAL EPISODE. The Descent of Inanna run
 * spent roughly two hundred of its three-hundred-and-eighty-six payoff words on
 * fragment attribution and translation history, and closed on "which telling of
 * that the people who wrote it actually meant to be the last word". One
 * contested claim out of forty-four did all of that.
 *
 * Three rules pushed it there - the beat sheet's "WHERE THE VERSIONS DISAGREE,
 * SAY SO PLAINLY", the writer's "a beat that uses one of these without saying
 * what is unsettled is rejected", and a plan whose spine already ended on the
 * disagreement. All three are off this lane. What is left is a model that will
 * still reach for the register when the material invites it, which is what
 * `findHedging` is for: a prompt is guidance and this is enforcement.
 */
import { Reference, referenceSchema } from '../../evidence/story';
import { HEDGE_PATTERNS, findHedging, renderReference } from '../storyScript';

const reference = (over: Partial<Reference> = {}): Reference =>
  referenceSchema.parse({
    subject: "Inanna's Descent to the Underworld",
    spine: 'She goes down to take her sister\'s throne, is judged, dies, and sends her husband below in her place.',
    world: ['The dead eat dust, and nobody leaves without sending somebody else.'],
    cast: [{ name: 'Ereshkigal', who: 'her older sister, who rules the dead', saidAloud: 'eh-RESH-kee-gal' }],
    sections: [{ heading: 'The seven gates', body: 'At each gate she gave up one more thing.' }],
    glossary: [
      { term: 'cuneiform', plainly: 'Wedge-shaped marks pressed into wet clay, the oldest writing found.' },
    ],
    ending: 'Dumuzi goes below, and Geshtinanna takes half of every year in his place.',
    variants: [
      {
        about: 'whether the Ur fragment belongs to this poem',
        taken: 'told as part of the same tradition',
        alsoSaid: 'Bendt Alster and Dina Katz argue it is a separate composition',
      },
    ],
    gaps: ['Nothing dates the earliest surviving tablet precisely.'],
    ...over,
  });

const beat = (beatId: string, text: string) => ({
  beatId,
  turns: [{ speaker: 'narrator', text }],
});

describe('what the writer is shown', () => {
  it('never shows the writer the disagreements the reference resolved', () => {
    // THE SINGLE MOST IMPORTANT ASSERTION IN THIS FILE. `variants` is the
    // owner's instruction made mechanical: the fusion decides, the run records
    // what it decided, and the listener hears one story. A writer that can see
    // the argument will put the argument in the episode, because it is the
    // most interesting thing on the page.
    const shown = renderReference(reference());

    expect(shown).not.toContain('Alster');
    expect(shown).not.toContain('separate composition');
    expect(shown).not.toContain('whether the Ur fragment');
  });

  it('does not show the writer the gaps either', () => {
    // Same reason. A gap is something for the person deciding whether to
    // publish, not a line for the narrator to read out.
    expect(renderReference(reference())).not.toContain('earliest surviving tablet');
  });

  it('shows the story, the world, the cast and the things to explain', () => {
    const shown = renderReference(reference());

    expect(shown).toContain('The seven gates');
    expect(shown).toContain('eat dust');
    expect(shown).toContain('who rules the dead');
    expect(shown).toContain('cuneiform');
    expect(shown).toContain('Geshtinanna takes half of every year');
  });

  it('never shows the writer a pronunciation', () => {
    // A respelling in the cast reached the script verbatim, so the engine said
    // the name and then spelled it out in syllables - a dictionary entry read
    // aloud, mid-story. The field is dead but older references still carry one,
    // so the renderer has to drop it rather than merely stop asking for it.
    const shown = renderReference(reference());

    expect(shown).not.toContain('eh-RESH-kee-gal');
    expect(shown).not.toContain('said:');
  });

  it('leaves out an empty section rather than printing an empty heading', () => {
    const bare = renderReference(
      reference({ glossary: [], cast: [], world: [] })
    );

    expect(bare).not.toContain('THINGS A LISTENER WILL NOT KNOW');
    expect(bare).not.toContain('THE PEOPLE:');
    expect(bare).toContain('THE STORY, in order:');
  });
});

describe('findHedging', () => {
  // Verbatim from the episode that prompted the rebuild.
  const fromTheRealEpisode = [
    'Who that turns out to be, and how, is where the surviving tablets stop agreeing with each other.',
    'The text does not explain guilty of what.',
    'A separate ending survives on a fragment found at the city of Ur.',
    "Scholars who work on these tablets don't agree on whether that fragment belongs to this same story at all.",
    "What's left unsettled is not whether Dumuzi goes down.",
  ];

  it.each(fromTheRealEpisode)('catches %j', (sentence) => {
    expect(findHedging([beat('ending', sentence)])).not.toHaveLength(0);
  });

  it('names the beat so the rewrite knows where to look', () => {
    const [problem] = findHedging([beat('close', 'It is unclear which version came first.')]);

    expect(problem).toMatch(/^close: /);
    expect(problem).toContain('Say what happened');
  });

  it('leaves a told story alone', () => {
    const told = [
      beat('opening', 'This is a Sumerian story. It comes from Sumer, in what is now southern Iraq.'),
      beat('world', 'The only food or drink down there was dust. Not fire, not torment. Dust, forever.'),
      beat('story', 'At the first gate, Neti told her the price of entry. She handed over her measuring rod.'),
      beat('ending', 'Dumuzi goes below. His sister takes half of every year in his place.'),
    ];

    expect(findHedging(told)).toEqual([]);
  });

  it('allows a hedge about the world rather than about the record', () => {
    // "Nobody knows how old the city is" is a fact about the world and is
    // fine. The register being refused is the one that puts a scholarly
    // argument between the listener and the story.
    const worldly = beat(
      'world',
      'Nobody knows how many people lived in Uruk then. The estimates are guesses built on the size of the walls.'
    );

    expect(findHedging([worldly])).toEqual([]);
  });

  it('reports each distinct hedge in a beat', () => {
    const bad = beat(
      'ending',
      'Some versions say she was spared. It is unclear which came first. ' +
        'What is left unsettled is who took her place.'
    );

    expect(findHedging([bad]).length).toBeGreaterThanOrEqual(3);
  });

  it('has a reason attached to every pattern', () => {
    // A finding the writer cannot act on is a finding that gets ignored, and
    // this loop is rewritten from these strings.
    for (const { why } of HEDGE_PATTERNS) {
      expect(why.length).toBeGreaterThan(10);
    }
  });
});

/**
 * The leak the synthetic tests missed.
 *
 * The first reference this lane ever produced put its disagreements in
 * `variants` exactly as instructed, and then wrote a section about how the
 * poem was dug up and reassembled that said "some scholars count this as part
 * of the same poem, others treat it as a separate, related text".
 *
 * Both halves of that are worth learning from. The recovery story is GOOD
 * material - this show's thesis is literally "and the story of how it survived
 * at all, which is usually stranger than the myth" - so the fix is not to ban
 * the subject. It is that a recovery told as events is a story and a recovery
 * told as the state of an argument is not, and a model writing the first will
 * slide into the second in the same paragraph.
 */
describe('hedging inside a section about how the text survived', () => {
  it('catches the state of an argument', () => {
    const verbatim = beat(
      'story',
      'The fragment breaks off with her crying in the streets. Some scholars count this ' +
        'as part of the same poem, others treat it as a separate, related text.'
    );

    expect(findHedging([verbatim])).not.toHaveLength(0);
  });

  it('leaves the recovery alone when it is told as events', () => {
    // Same subject, same facts, told as things people did. This must survive:
    // banning it would cut the best material the show has.
    const asStory = beat(
      'story',
      'In 1996 a scholar named Bendt Alster went back to the closing lines and found ' +
        'something nobody had noticed. It is Inanna herself who asks for Dumuzi back, ' +
        'the same woman who condemned him. A tablet found at Nippur turned out to hold ' +
        'the other half of one dug up at Ur, and the two had been sitting in different ' +
        'museums for fifty years.'
    );

    expect(findHedging([asStory])).toEqual([]);
  });
})
