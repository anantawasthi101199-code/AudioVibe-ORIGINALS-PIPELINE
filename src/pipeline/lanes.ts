/**
 * Which lane a channel's runs go through, decided in ONE place.
 *
 * The lanes are mutually exclusive by construction:
 *
 *   fiction   persona.fiction is true            pipeline/fiction.ts
 *   news      desks/<id>.yaml exists             pipeline/news.ts
 *   business  casebooks/<id>.yaml exists         pipeline/business.ts
 *   story     none of the above                  pipeline/episode.ts
 *
 * A channel that qualifies for two is refused outright, and so is a run whose
 * format belongs to another lane: `make --show myths-of-the-world --format
 * biz-short` would otherwise hand a business beat sheet to the myth writer.
 */
import { Persona } from '../canon/schema';
import { hasCasebook } from '../business/casebook';
import { hasNewsDesk } from '../news/desk';

export type Lane = 'fiction' | 'news' | 'business' | 'story';

/** Formats that belong to one lane only, by id prefix. */
const OWNED: Array<[RegExp, Lane]> = [
  [/^news-/, 'news'],
  [/^biz-/, 'business'],
];

export const laneOf = (persona: Persona): Lane => {
  const claims: Lane[] = [];
  if (persona.fiction) claims.push('fiction');
  if (hasNewsDesk(persona.id)) claims.push('news');
  if (hasCasebook(persona.id)) claims.push('business');
  if (claims.length > 1) {
    throw new Error(
      `${persona.id} qualifies for the ${claims.join(' and ')} lanes at once. A channel is one ` +
        `kind of show; remove the extra desk, casebook or fiction flag.`
    );
  }
  return claims[0] ?? 'story';
};

/** Refuse a format that belongs to a different lane from the channel's. */
export const assertFormatInLane = (lane: Lane, formatId: string): void => {
  const owner = OWNED.find(([re]) => re.test(formatId))?.[1];
  if (owner && owner !== lane) {
    throw new Error(`"${formatId}" is a ${owner} format and this channel is on the ${lane} lane.`);
  }
  if (!owner && (lane === 'news' || lane === 'business')) {
    throw new Error(`the ${lane} lane only runs its own formats, and "${formatId}" is not one.`);
  }
};
