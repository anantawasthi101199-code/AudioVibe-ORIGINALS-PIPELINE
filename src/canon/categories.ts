/**
 * The categories AudioVibe actually has.
 *
 * WHY A COPY OF SOMEONE ELSE'S LIST LIVES HERE. A persona names its category as
 * a string, and the platform resolves that name to an id at publish time. A name
 * the platform does not have fails there - at the last command, after the
 * research, the writing, the voicing and the gate have all been paid for. That
 * is the most expensive possible moment to learn about a typo.
 *
 * Night Shift shipped with "Fiction", which is not one of these. It would have
 * run perfectly and failed on the final call.
 *
 * THE LIVE LIST IS STILL THE AUTHORITY. This is a fast local check, not a
 * second source of truth: the publish client resolves against
 * GET /api/feed/categories and refuses anything it cannot match there. If the
 * platform adds a category, publishing works and this list is merely out of
 * date - so the check here is a WARNING at load, never a hard failure. Being
 * stale must not be able to stop a show that the platform would accept.
 *
 * Taken from migration 063, which trims the active set to fourteen.
 */
export const PLATFORM_CATEGORIES = [
  'Business & Finance',
  'Comedy',
  'Educational',
  'Film & TV',
  'Fitness & Health',
  'Horror & Thriller',
  'Music',
  'News & Politics',
  'Podcasts',
  'Sci-Fi & Fantasy',
  'Science & Tech',
  'Spirituality',
  'Storytelling',
  'True Crime',
] as const;

export const isKnownCategory = (name: string): boolean =>
  PLATFORM_CATEGORIES.some((c) => c.toLowerCase() === name.trim().toLowerCase());

/** The nearest known category, for an error message worth reading. */
export const nearestCategory = (name: string): string | null => {
  const needle = name.trim().toLowerCase();
  return (
    PLATFORM_CATEGORIES.find(
      (c) => c.toLowerCase().includes(needle) || needle.includes(c.toLowerCase().split(' ')[0]!)
    ) ?? null
  );
};
