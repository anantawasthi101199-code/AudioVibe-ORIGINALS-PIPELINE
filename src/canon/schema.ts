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
  /** Provider-specific knobs, kept opaque so adding a provider is not a schema change. */
  settings: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
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
