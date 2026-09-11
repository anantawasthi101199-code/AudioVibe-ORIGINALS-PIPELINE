/**
 * Category names, checked locally so a typo does not cost an episode.
 *
 * The platform resolves a name to an id on the last call of the pipeline. A
 * name it does not have fails there - after the research, the writing, the
 * voicing and the gate have all been paid for. Night Shift shipped with
 * "Fiction", which is not a category, and would have done exactly that.
 */
import { loadAllPersonas } from '../load';
import { PLATFORM_CATEGORIES, isKnownCategory, nearestCategory } from '../categories';

describe('isKnownCategory', () => {
  it('accepts a real one', () => {
    expect(isKnownCategory('Business & Finance')).toBe(true);
  });

  it('ignores case and surrounding space, because the API does too', () => {
    expect(isKnownCategory('  business & finance ')).toBe(true);
  });

  it('REJECTS "Fiction", which is the one that actually shipped', () => {
    // There is no Fiction category. Audio drama lives in Storytelling.
    expect(isKnownCategory('Fiction')).toBe(false);
  });

  it('rejects a slug where a name belongs', () => {
    // The API wants the display name. A slug is the other easy mistake.
    expect(isKnownCategory('science-tech')).toBe(false);
  });
});

describe('nearestCategory', () => {
  it('suggests the real one for a near miss', () => {
    expect(nearestCategory('Business')).toBe('Business & Finance');
  });

  it('returns null rather than a misleading guess', () => {
    expect(nearestCategory('Underwater Basket Weaving')).toBeNull();
  });
});

describe('the shipped shows', () => {
  it.each(loadAllPersonas().map((p) => [p.id, p.category] as const))(
    '%s publishes into a category the platform has',
    (_id, category) => {
      expect(PLATFORM_CATEGORIES).toContain(category);
    }
  );
});
