/**
 * The countries a rapid fire can be pointed at, chosen per run in the studio
 * (owner, 2026-10-05). Up to three; none chosen means the desk's own regions.
 *
 * Each one is a roundup region: what to search, and the words a headline must
 * contain to count as that country's story (case-sensitive proper nouns, see
 * namesRegion). "The world" has no words, so it takes the top story anywhere.
 */
export interface Country {
  /** As the bulletin says it: "the US", "India". */
  name: string;
  queries: string[];
  match: string[];
}

const c = (name: string, capital: string, ...more: string[]): Country => {
  const bare = name.replace(/^the /, '');
  return { name, queries: [bare, capital], match: [bare, capital, ...more] };
};

export const COUNTRIES: Country[] = [
  { name: 'the world', queries: ['world news'], match: [] },
  c('India', 'New Delhi', 'Indian', 'Delhi', 'Modi', 'Mumbai'),
  {
    name: 'the US',
    queries: ['United States', 'White House', 'Washington'],
    match: ['US', 'U.S.', 'America', 'American', 'Trump', 'White House', 'Washington', 'Congress', 'Senate'],
  },
  {
    name: 'the UK',
    queries: ['United Kingdom', 'UK government', 'Britain'],
    match: ['UK', 'Britain', 'British', 'England', 'London', 'Starmer', 'Westminster', 'Scotland', 'Wales'],
  },
  c('China', 'Beijing', 'Chinese', 'Xi', 'Taiwan', 'Hong Kong'),
  c('Russia', 'Moscow', 'Russian', 'Kremlin', 'Putin'),
  c('Ukraine', 'Kyiv', 'Ukrainian', 'Zelensky'),
  c('Israel', 'Jerusalem', 'Israeli', 'Gaza', 'Netanyahu'),
  c('Iran', 'Tehran', 'Iranian'),
  c('Pakistan', 'Islamabad', 'Pakistani'),
  c('Bangladesh', 'Dhaka', 'Bangladeshi'),
  c('Japan', 'Tokyo', 'Japanese'),
  c('South Korea', 'Seoul', 'Korean'),
  c('North Korea', 'Pyongyang', 'Kim Jong'),
  c('Australia', 'Canberra', 'Australian', 'Sydney'),
  c('Canada', 'Ottawa', 'Canadian'),
  c('Mexico', 'Mexico City', 'Mexican'),
  c('Brazil', 'Brasilia', 'Brazilian', 'Lula'),
  c('Argentina', 'Buenos Aires', 'Argentine', 'Argentinian'),
  c('France', 'Paris', 'French', 'Macron'),
  c('Germany', 'Berlin', 'German'),
  c('Italy', 'Rome', 'Italian'),
  c('Spain', 'Madrid', 'Spanish'),
  c('Turkey', 'Ankara', 'Turkish', 'Erdogan'),
  c('Saudi Arabia', 'Riyadh', 'Saudi'),
  c('the UAE', 'Abu Dhabi', 'Emirati', 'Dubai'),
  c('Egypt', 'Cairo', 'Egyptian'),
  c('South Africa', 'Pretoria', 'South African', 'Johannesburg'),
  c('Nigeria', 'Abuja', 'Nigerian', 'Lagos'),
  c('Kenya', 'Nairobi', 'Kenyan'),
  c('Indonesia', 'Jakarta', 'Indonesian'),
  c('Singapore', 'Singapore', 'Singaporean'),
  c('Sri Lanka', 'Colombo', 'Sri Lankan'),
  c('Nepal', 'Kathmandu', 'Nepali', 'Nepalese'),
  c('Afghanistan', 'Kabul', 'Afghan', 'Taliban'),
  c('the EU', 'Brussels', 'European Union', 'European Commission'),
];

/** Up to three, picked by name. Unknown names are refused rather than guessed. */
export const MAX_COUNTRIES = 3;

export const countriesByName = (names: string[]): Country[] =>
  names.map((n) => {
    const found = COUNTRIES.find((x) => x.name === n);
    if (!found) throw new Error(`no country called "${n}"; choose from the list`);
    return found;
  });
