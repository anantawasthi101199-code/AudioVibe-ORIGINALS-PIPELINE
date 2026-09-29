/**
 * Which of the optional stages run.
 *
 * WHAT IS IN HERE AND WHAT IS NOT. The brief, the corpus, the research and the
 * script are the pipeline: without any one of them there is no episode. What is
 * listed here is every pass that CALLS A MODEL without being load-bearing -
 * each one makes an episode better or safer, each one has a price, and each is
 * a reasonable thing to switch off.
 *
 * A DETERMINISTIC CHECK IS NEVER IN THIS LIST. The style card, `critiqueBeat`,
 * `findHedging`, speakability, self-similarity, the quote ledger and the gate
 * are arithmetic over text already on disk. They are free, they always run,
 * and they always report. Switching one off would save nothing and lose the
 * only account of what is wrong with an episode, so the only question this file
 * answers is which passes get PAID FOR.
 *
 * SWITCHED OFF IS NOT THE SAME AS PASSED, and that distinction is the whole
 * reason this module records what it decided rather than just acting on it. A run
 * without the grounding review has not been found to be well-sourced; it has not
 * been looked at. The flags go onto the run manifest and the gate says out loud
 * which safety passes were skipped, so a report can never read as clean when it
 * is merely quiet. Getting this wrong is how the held gate came to print
 * "GATE: passed" over a script nothing had checked.
 *
 * Set per run with a flag, or for a machine with an environment variable:
 *
 *   npm run foundry -- make --show x --topic "y" --grounding
 *   npm run foundry -- make --show x --topic "y" --no-perform
 *   FOUNDRY_STAGE_GROUNDING=on
 */

/** The stages that may be switched off. */
export const OPTIONAL_STAGES = [
  /**
   * Searching for sources that disagree with a contested claim.
   *
   * SAFETY. The counter-evidence pass is what stops confident one-sidedness,
   * which is the commonest way generated content is false while every sentence
   * is individually sourced.
   */
  'counterEvidence',
  /**
   * Narrowing, rebinding and hedging the claims that failed verification.
   *
   * Without it, a claim that says slightly more than its quote is simply lost
   * rather than trimmed to what the quote supports. Not unsafe - the writer never
   * sees an unverified claim either way - but it throws away paid research, and
   * one episode named six men and sentenced two before this existed.
   */
  'repair',
  /**
   * Going back to the fetched corpus for a name nobody placed, or a counted
   * sequence the claims summarised instead of giving.
   *
   * Nearly free, because the documents are already on disk.
   */
  'gaps',
  /**
   * The delivery pass over the finished script.
   *
   * Quality only. It cannot add a fact, so switching it off cannot make an
   * episode less true, only less listenable.
   */
  'perform',
  /**
   * Reading the finished script against the ledger for anything it states that no
   * claim supports.
   *
   * SAFETY, and the only check that can catch prose invented between the claims.
   * Default OFF at the owner's instruction while the writing is being tuned, which
   * is a defensible trade for a draft nobody publishes and a bad one for anything
   * that goes out.
   */
  'grounding',
  /**
   * Reading the fused reference back against the documents it came from.
   *
   * SINGLE-STORY LANE ONLY, and it is that lane's entire evidence apparatus:
   * there is no claim ledger, no verifier and no grounding pass, so with this
   * off nothing at all has checked what the episode says.
   *
   * It is also the most expensive single check in the studio, because it
   * re-reads every chosen document with a second model family - 51.6p on the
   * first real run, more than the fusion it was checking.
   */
  'referenceCheck',
  /**
   * Rewriting a script that failed its own style checks.
   *
   * NOT A CHECK - THE CHECKS ARE FREE. `critiqueBeat`, the style card and
   * `findHedging` are deterministic arithmetic over the prose and cost
   * nothing, so they run either way and their findings are always reported.
   * What this flag controls is whether the studio PAYS A MODEL to act on them.
   *
   * It is the largest avoidable cost there is. One run spent 11.7p writing a
   * script and 87.1p rewriting it, and the rewrites were oscillating rather
   * than converging: draft one averaged 24.4 words a sentence against a target
   * of 13, the rewrite over-corrected to 4.1 words of variance against a
   * minimum of 5, and six problems were still outstanding when the budget of
   * two revisions ran out.
   */
  'scriptRevisions',
] as const;

export type OptionalStage = (typeof OPTIONAL_STAGES)[number];

export type StageFlags = Record<OptionalStage, boolean>;

/**
 * The stages whose absence changes whether an episode can be trusted.
 *
 * Reported by the gate when they are off. `perform` and `repair` are not here:
 * the first cannot affect truth, and the second only ever removes material.
 */
export const SAFETY_STAGES: readonly OptionalStage[] = ['counterEvidence', 'grounding'];

/**
 * What runs when nobody says otherwise.
 *
 * EVERYTHING IS OFF, at the owner's instruction, and this is a deliberate
 * reversal of how this file used to read. It previously said "everything else
 * is on, because everything else was built in response to a fault that reached
 * a finished episode", which was true and is still true - and it had produced a
 * pipeline where one episode cost 232p, of which 139p was checking and
 * rewriting rather than making.
 *
 * THE INSTRUCTION, IN THE OWNER'S WORDS: "remove all the checks, i dont want to
 * waste money on any checks revisions or gates, we will add them one by one
 * later. we start with minimal cost and keep adding stuff as we go along."
 *
 * So the floor is the cheapest thing that produces an episode, and each pass
 * goes back on one at a time, by name, when it has earned its cost:
 *
 *   npm run foundry -- make --show x --topic "y" --reference-check
 *   npm run foundry -- make --show x --topic "y" --script-revisions --perform
 *   FOUNDRY_STAGE_REFERENCE_CHECK=on
 *
 * WHAT THIS DOES NOT SWITCH OFF, because it is free. Every deterministic check
 * in the studio still runs and still reports: the style card, `critiqueBeat`,
 * `findHedging`, the speakability check, self-similarity, the quote ledger and
 * the gate itself are arithmetic over text that is already on disk. They cost
 * nothing, so switching them off would save nothing and lose the only account
 * of what is wrong with an episode. Only the passes that call a model are here.
 *
 * READ THE GATE REPORT ANYWAY. A run with everything off has not been found to
 * be good; it has not been looked at by anything that costs money. The gate
 * says which passes were skipped for exactly this reason, and it fails closed
 * on the single-story lane when the reference was never checked.
 */
export const STAGE_DEFAULTS: StageFlags = {
  counterEvidence: false,
  repair: false,
  gaps: false,
  perform: false,
  grounding: false,
  referenceCheck: false,
  scriptRevisions: false,
};

const envName = (stage: OptionalStage): string =>
  `FOUNDRY_STAGE_${stage.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;

/** Whether a string means on, off, or nothing at all. */
const parse = (raw: string | undefined): boolean | undefined => {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return undefined;
  if (['on', 'true', '1', 'yes'].includes(value)) return true;
  if (['off', 'false', '0', 'no'].includes(value)) return false;
  return undefined;
};

/**
 * Resolve the flags: defaults, then the environment, then the run's own overrides.
 *
 * Last wins, which is the order somebody would expect: a flag typed on the
 * command line beats a machine setting, and a machine setting beats the default.
 */
export const stageFlags = (overrides: Partial<StageFlags> = {}): StageFlags => {
  const flags = { ...STAGE_DEFAULTS };

  for (const stage of OPTIONAL_STAGES) {
    const fromEnv = parse(process.env[envName(stage)]);
    if (fromEnv !== undefined) flags[stage] = fromEnv;
    const override = overrides[stage];
    if (override !== undefined) flags[stage] = override;
  }

  return flags;
};

/** The off ones, for printing and for the manifest. */
export const stagesOff = (flags: StageFlags): OptionalStage[] =>
  OPTIONAL_STAGES.filter((s) => !flags[s]);

/**
 * `--grounding` / `--no-grounding` style overrides, read off an argv array.
 *
 * Lives here rather than in the CLI so the flag name and the stage name cannot
 * drift apart: adding a stage to OPTIONAL_STAGES gives it a flag for free.
 */
export const stageOverridesFromArgv = (argv: string[]): Partial<StageFlags> => {
  const out: Partial<StageFlags> = {};

  for (const stage of OPTIONAL_STAGES) {
    // Hyphenated on the command line, camel in the code: --counter-evidence.
    const flag = stage.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    if (argv.includes(`--no-${flag}`)) out[stage] = false;
    if (argv.includes(`--${flag}`)) out[stage] = true;
  }

  return out;
};
