/**
 * How long a title may be.
 *
 * WHY 45 (owner, 2026-10-12). The app shows a title on two lines, on the audio
 * card and on Now Playing, and anything past that ends in "...". "How Albert
 * Hofmann discovered LSD's effects on his bicycle ride home in 1943" (76) did.
 * Measured with the app's own fonts on a 360dp phone, the narrowest common
 * width: 45 characters fits both places for practically every title, 50 does
 * not. The AudioVibe API refuses anything longer, so this is the same number
 * as AUDIO_TITLE_MAX there, and the gate blocks a run whose title is over it.
 *
 * No imports, so every writer can use it without a cycle.
 */
export const TITLE_MAX = 45;

export const TITLE_RULE =
  `THE TITLE IS AT MOST ${TITLE_MAX} CHARACTERS, spaces included, so the app shows all of it. ` +
  'Name the thing in a few words; never the whole story in one sentence.';
