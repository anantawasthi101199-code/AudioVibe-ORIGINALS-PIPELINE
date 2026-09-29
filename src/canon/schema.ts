/**
 * What a show IS, as data.
 *
 * THE TWO FAILURE MODES THIS EXISTS TO PREVENT. Drift, where episode 20 does
 * not sound like episode 1. And sameness, where all five shows sound like the
 * same model wearing different hats. Both come from the same mistake: putting
 * the persona in a system prompt. A paragraph of prose cannot be diffed, cannot
 * be scored against a draft, and quietly drifts every time someone reworks it.
 *
 * So a persona is structured, retrieved at generation time, and - the part that
 * matters most - MEASURABLE. `styleCard` below is numbers rather than
 * adjectives, because stage 7 has to score a draft for "does this sound like
 * the show" automatically, and that is not a judgeable question when the answer
 * is "warm but not chatty".
 */
import { z } from 'zod';
import { idiolectSchema } from '../script/voices';

/**
 * Canon entries are append-only and effective-dated.
 *
 * A show has to be able to evolve without retconning what it already said. If a
 * belief is simply edited in place, a callback to episode 3 starts referring to
 * something the show no longer thinks, and the archive quietly becomes wrong.
 */
export const canonKindSchema = z.enum([
  /** A position the show holds and argues from. */
  'belief',
  /** Something the show will not do. Load-bearing: see the note in the type. */
  'taboo',
  /** A repeating structural element listeners come to expect. */
  'recurring_segment',
  /** A phrase the show owns. Budgeted, not unlimited - see styleCard. */
  'catchphrase',
  /** A fact about the show itself that must stay true across episodes. */
  'biographical_fact',
  /** A rule about how it writes, as opposed to what it thinks. */
  'stylistic_rule',
]);

export type CanonKind = z.infer<typeof canonKindSchema>;

export const canonEntrySchema = z.object({
  kind: canonKindSchema,
  text: z.string().min(1),
  /**
   * ISO date this became true. Absent means "from the beginning".
   *
   * Present so a script generated for episode 30 can be given the canon as it
   * stood then, rather than as it stands now.
   */
  since: z.string().date().optional(),
  /** ISO date this stopped being true. Absent means it still is. */
  until: z.string().date().optional(),
});

export type CanonEntry = z.infer<typeof canonEntrySchema>;

/**
 * Measurable style targets.
 *
 * Every field here is something a draft can be scored against without a human
 * reading it. Adjectives are deliberately absent: they cannot fail a test.
 */
export const styleCardSchema = z.object({
  /**
   * Target mean words per sentence, and the spread around it.
   *
   * The SPREAD is the important half. Uniform sentence length is the single
   * clearest tell of generated prose, so a show that hits its mean with no
   * variance has failed this check rather than passed it.
   */
  sentenceWordsMean: z.number().positive(),
  sentenceWordsStdDevMin: z.number().nonnegative(),

  /** Questions per hundred words. A show that never asks one lectures. */
  questionsPer100Words: z.number().nonnegative(),

  /** "You" and "your" per hundred words. How directly it addresses a listener. */
  secondPersonPer100Words: z.number().nonnegative(),

  /**
   * Hedges ("might", "perhaps", "arguably") per hundred words, as a CEILING.
   *
   * Hedging is how a grounded show turns into a mushy one. The evidence layer
   * decides how confident a claim is allowed to be; prose should not add a
   * second, vaguer layer of doubt on top of it.
   */
  hedgesPer100WordsMax: z.number().nonnegative(),

  /**
   * Where the show is allowed to draw metaphors from.
   *
   * Narrow on purpose. A show that reaches for any image at all sounds like
   * every other show; one that always reaches into the same two or three
   * domains develops a texture listeners recognise.
   */
  metaphorDomains: z.array(z.string().min(1)).min(1),

  /**
   * Phrases this show may never use, on top of the network-wide banned list.
   *
   * The network list catches model tells. This one catches things that are fine
   * generally but wrong for this show.
   */
  forbiddenPhrases: z.array(z.string().min(1)).default([]),

  /** Times per episode a catchphrase may appear. Beyond this it is a tic. */
  catchphraseBudget: z.number().int().nonnegative().default(2),
});

export type StyleCard = z.infer<typeof styleCardSchema>;

/**
 * The voice, bound permanently to the show.
 *
 * NEVER CHANGES. Voice is what a show IS to a listener, far more than its
 * artwork or its name, and swapping it silently is the audio equivalent of
 * replacing a presenter between episodes without saying so. If a vendor
 * deprecates a voice that is a show-level event with an announcement, which is
 * why this lives in the persona file and not in the environment: a value that
 * can drift by deployment is a value that will.
 */
export const voiceSchema = z.object({
  provider: z.enum(['elevenlabs', 'inworld', 'gemini', 'chatterbox']),
  voiceId: z.string().min(1),
  /**
   * The voice to use when drafting on a cheaper provider.
   *
   * A VOICE ID BELONGS TO A PROVIDER. "onyx" means nothing to ElevenLabs and a
   * twenty-character Eleven id means nothing to OpenAI, so switching engines
   * means switching ids. Holding both is the alternative to editing `voiceId`
   * back and forth, which is a thing somebody eventually forgets to undo - and
   * the way you find out is a published episode in the wrong voice.
   *
   * Optional. A show without one simply cannot be drafted on the cheap engine,
   * which is a clear failure rather than a silent substitution.
   */
  draftVoiceId: z.string().min(1).optional(),
  /** Provider-specific knobs, kept opaque so adding a provider is not a schema change. */
  settings: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),

  /**
   * How this person speaks, in plain English, sent to the engine as direction.
   *
   * WHY A SHOW SHOULD OWN THIS SENTENCE RATHER THAN HAVE IT DERIVED. It used to
   * be inferred from two Eleven numbers, `stability` and `style`, mapped onto
   * three phrases each. That produces a delivery nobody chose: every show in the
   * studio got "Speak as one half of a two-person conversation that is already
   * underway", which is right for a two-hander and wrong for a single expert
   * explaining something - and a listener heard exactly that, a health show
   * reading its research like a mystery.
   *
   * The numbers still set steadiness and colour. This says who is talking, and
   * it is the line that decides whether a listener trusts the voice.
   *
   * Optional, because a show without one gets the derived default it had
   * before, which is serviceable and generic.
   */
  direction: z.string().min(1).optional(),

  /**
   * Speaking rate, where 1 is the engine's own pace.
   *
   * Kept out of `settings` because it is not provider-specific: every engine has
   * a notion of speed and a show's pace is a property of the show. 1.0 is the
   * default and the range the engines accept is roughly 0.25 to 2.
   */
  speed: z.number().min(0.5).max(2).optional(),
});

export type Voice = z.infer<typeof voiceSchema>;

/**
 * A speaking part.
 *
 * WHY SHOWS HAVE HOSTS AND NOT A VOICE. Narrated prose read by a single
 * synthetic voice is the most AI-sounding format that exists, because polished
 * monologue is exactly what text-to-speech has always produced. Two people
 * talking is dramatically more listenable, and the reason is not the technology
 * - it is that conversation carries hesitation, interruption, disagreement and
 * repair, none of which survive in prose written to be read aloud.
 *
 * So a show is a cast. A narrated show is simply a cast of one, which keeps
 * one code path for both instead of a special case.
 */
export const hostSchema = z.object({
  /** Referenced by the writer and in every script turn. */
  id: z.string().regex(/^[a-z0-9_]+$/, 'lowercase, digits and underscores only'),
  /** What listeners hear them called. */
  name: z.string().min(1),
  /**
   * What this host is FOR in a conversation.
   *
   * Load-bearing rather than colour. Two hosts with the same job produce the
   * thing every AI podcast does, which is two voices agreeing enthusiastically
   * for ten minutes. Give one the job of pressing on the weak point and the
   * conversation acquires a reason to exist.
   */
  role: z.string().min(1),
  voice: voiceSchema,
  /**
   * How this host TALKS, as numbers.
   *
   * Optional so a narrated show does not have to state it, but on a two-host
   * show it is what stops the pair converging into one person. See
   * script/voices.ts for what each field does and why turn length is the one
   * that matters most.
   */
  idiolect: idiolectSchema.optional(),
});

export type Host = z.infer<typeof hostSchema>;

export const personaSchema = z.object({
  /** Stable id. Used in run artifacts and sent to the platform as persona_ref. */
  id: z.string().regex(/^[a-z0-9-]+$/, 'lowercase, digits and hyphens only'),

  /** The account handle on AudioVibe. Must already exist with is_ai set. */
  handle: z.string().min(1),

  /** Display name of the show. */
  name: z.string().min(1),

  /** Which AudioVibe category its content belongs in. */
  category: z.string().min(1),

  /** One sentence on what the show is for. Kept to one on purpose. */
  thesis: z.string().min(1),

  /** Who it is talking to. Shapes assumed knowledge, not tone. */
  audience: z.string().min(1),

  /** How it sounds, in prose. The only prose field, and it does not gate anything. */
  register: z.string().min(1),

  /**
   * The cast. One host is a narrated show; two is a conversation.
   *
   * Capped at two on purpose. Three synthetic voices in one room is where
   * listeners stop being able to tell who is speaking, and turn-taking stops
   * carrying meaning.
   */
  hosts: z.array(hostSchema).min(1).max(2),

  styleCard: styleCardSchema,
  canon: z.array(canonEntrySchema).default([]),

  /** Beat sheets this show is allowed to use, by id. */
  formats: z.array(z.string().min(1)).min(1),

  /** Target episode length in seconds, as a range. */
  episodeSeconds: z.tuple([z.number().positive(), z.number().positive()]),

  /**
   * Risk tiers this show is allowed to make claims in.
   *
   * Health, finance, legal and claims about named living people demand T1/T2
   * sources and 100% human review. A show that is not cleared for a tier does
   * not get an episode quietly downgraded; it does not get the topic.
   */
  allowedRiskTiers: z.array(z.enum(['general', 'health', 'finance', 'legal', 'named_person'])),

  /**
   * How this show says goodbye.
   *
   * WHY A SHOW NEEDS ONE, AND WHY IT LIVES HERE. The `myth-told` sheet ends
   * "No sign-off, no call to action, no naming the show, no next-time", which
   * was written against the real fault of episodes trailing off into filler -
   * and it overshot. The Inanna episode's last sentence is an unresolved
   * scholarly question, so a listener who stayed fifteen minutes is handed a
   * shrug and silence. A show somebody comes back to has to sound like it
   * expects them back.
   *
   * On the persona rather than the format because it is a property of the
   * SHOW: it should be the same words at the end of every episode whatever
   * shape that episode was, which is the whole point of a sign-off.
   *
   * A STRING OR A LIST. Give several and the show picks one per episode, chosen
   * from the topic so it is stable on a re-render and different between
   * episodes - which is how a real presenter sounds, saying roughly the same
   * thing a slightly different way each week.
   *
   * The writer is told to land on it in its own words rather than to recite it,
   * so it varies further and stays recognisable. THIS FIELD IS THE ONE PLACE TO
   * EDIT IT: nothing else in the pipeline hard-codes a goodbye.
   *
   * Absent means no sign-off, which is right for the shows whose formats
   * genuinely should stop rather than close.
   */
  signoff: z.union([z.string(), z.array(z.string().min(1)).min(1)]).optional(),

  /**
   * How the show says goodbye at the end of a SHORT.
   *
   * A different job from the long sign-off. A short is ninety seconds to three
   * minutes, it is usually somebody's first contact with the show, and it has
   * to earn a follow rather than thank somebody for staying fifteen minutes.
   * Using the long one would spend a fifth of the episode on goodbye.
   */
  signoffShort: z.union([z.string(), z.array(z.string().min(1)).min(1)]).optional(),

  /**
   * The weakest source this show will rest a claim on.
   *
   * WHY A SHOW NEEDS ITS OWN FLOOR. Tiers are recorded on every claim already,
   * and until now nothing could refuse one. That is right for most shows: a
   * myth retelling cites a Victorian translation and a good blog post about a
   * manuscript, and neither is a problem.
   *
   * It is wrong for a health show, and the failure is specific and invisible. A
   * claim sourced to a news write-up of a press release about a preprint passes
   * every check there is - the quote occurs, the verifier agrees the quote
   * supports the claim, the tier is recorded - and is still not evidence about
   * the world. The only thing that catches it is a show being able to say "a T3
   * source is not good enough for me".
   *
   * Absent means the network floor, which is that any tier may be used and a T4
   * beat asks for human review.
   */
  minSourceTier: z.enum(['T1', 'T2', 'T3', 'T4']).optional(),

  /**
   * How old a source may be, in days.
   *
   * For anything that reports on a moving situation. Nothing in retrieval knows
   * what "recent" means: a search returns what it returns, and a claim verified
   * against a two-year-old article passes exactly as happily as one from this
   * morning. A show about a live subject needs to be able to say how stale is
   * too stale, and every other show needs this to stay absent - a 1732 army
   * report is not out of date.
   */
  maxSourceAgeDays: z.number().positive().optional(),

  /**
   * Whether this show is fiction.
   *
   * A PROPERTY OF THE SHOW, NEVER OF AN EPISODE. A show that reconstructs cases
   * from filings one week and invents a story the next has destroyed the only
   * thing the evidence pipeline was buying it: a listener's ability to know,
   * without checking, which kind of thing they are hearing. There is no format
   * flag for this and there should never be one.
   *
   * What it changes is which checks apply, not how many. Fiction skips the
   * evidence pipeline entirely - no search, no corpus, no quote binding, no
   * verifier - because there is nothing to bind a made-up scene to. In its
   * place it gets continuity checking, which is the same discipline pointed at
   * a different ground truth: an episode may not contradict what the series has
   * already established, and every named thing in it has to exist in the bible.
   *
   * It changes nothing about disclosure. A fiction show is labelled AI exactly
   * as a factual one is. "It is obviously a story" is not a disclosure, and the
   * EU AI Act does not have a fiction exemption.
   */
  fiction: z.boolean().default(false),

  /**
   * Whether episodes publish into a series shelf rather than as loose cards.
   *
   * A SERIAL REQUIRES THIS. Without it every episode lands in the catalogue
   * unnumbered and unordered, and a serial a listener cannot play in order is
   * not a serial - it is a pile of audio that happens to share a voice.
   *
   * A topic show does not need it and may not want it. Business Teardowns's episodes
   * stand alone, so each one competes on its own subject and gets its own shot
   * at a feed; a shelf would add a follow surface but would also mean somebody
   * arriving at episode nine feels late. That is a real trade and it belongs to
   * the show rather than to a default.
   *
   * Off by default because the failure directions are asymmetric. A serial that
   * forgot the flag has published loose episodes that have to be reattached one
   * by one; a topic show that forgot it has published exactly what it meant to.
   */
  publishesAsSeries: z.boolean().default(false),
});

export type Persona = z.infer<typeof personaSchema>;

/** True when the show is a conversation rather than narration. */
export const isDialogueShow = (persona: Persona): boolean => persona.hosts.length > 1;

/** Look a host up by id, or throw naming what was available. */
export const hostById = (persona: Persona, id: string): Host => {
  const host = persona.hosts.find((h) => h.id === id);
  if (!host) {
    throw new Error(
      `${persona.id} has no host "${id}" (has: ${persona.hosts.map((h) => h.id).join(', ')})`
    );
  }
  return host;
};

/** Canon entries in force on a given date. */
export const canonAsOf = (persona: Persona, isoDate: string): CanonEntry[] =>
  persona.canon.filter(
    (e) => (!e.since || e.since <= isoDate) && (!e.until || e.until > isoDate)
  );

/** Canon entries of one kind, in force today. */
export const canonOfKind = (
  persona: Persona,
  kind: CanonKind,
  isoDate: string
): CanonEntry[] => canonAsOf(persona, isoDate).filter((e) => e.kind === kind);
