/**
 * Turning a topic into a corpus and a set of verified claims.
 *
 * Four steps, and the boundaries between them are where the honesty lives:
 *
 *   1. BRIEF   - the model proposes an angle and search queries. A judgement
 *                about what to look for, which cannot be false in the way a
 *                citation can.
 *   2. GATHER  - the search engine proposes URLs; the fetcher proves they
 *                exist. A model never originates an address.
 *   3. EXTRACT - the model reads the corpus and proposes claims, each with a
 *                quote it says came from a specific source. It is checked
 *                deterministically, so "says" is not taken on trust.
 *   4. COUNTER - for contested claims, disconfirming evidence is actively
 *                searched for rather than waited for.
 *
 * Step 4 is the one that separates "true" from "confidently one-sided", and it
 * is the step every content pipeline skips. A show that says "this was the
 * famous result, and here is what happened when people tried to repeat it" is
 * doing something the genre does not do, is more interesting than the confident
 * version, and is defensible.
 */
import { z } from 'zod';
import { Persona } from '../canon/schema';
import { EpisodeFormat } from '../formats/schema';
import { completeJson, extractJson, LlmClient } from '../models/client';
import { Claim, claimSchema, checkLedger, UnsupportedClaim, unsupportedClaimSchema } from './claim';
import { FetchDeps, fetchSource } from './fetch';
import { selectPassages } from './passages';
import { rankCandidates, SearchProvider } from './search';
import { Source, SourceTier, TIER_RANK, tierForUrl } from './source';

export const briefSchema = z.object({
  /** The specific angle, narrower than the topic. */
  angle: z.string().min(1),
  /** What the episode will have to establish to work. */
  mustEstablish: z.array(z.string().min(1)).min(1),
  /** Queries for the search engine. */
  /**
   * Queries for the search engine.
   *
   * THE CEILING IS FOR AN ANTHOLOGY. Twelve was right while every format
   * researched one subject. A source format researches ten separate stories and
   * needs one or two aimed at each, plus a few for the shared background, so a
   * twelve-query cap would have forced it to drop stories or to search for the
   * tradition in general - which returns overviews, and an overview has one
   * sentence about each story.
   */
  queries: z.array(z.string().min(1)).min(3).max(30),
  /** Claims the writer expects to be contested, driving the counter-evidence pass. */
  likelyContested: z.array(z.string()).default([]),
});

export type Brief = z.infer<typeof briefSchema>;

export const corpusSchema = z.object({
  sources: z.array(z.custom<Source>()),
  /** URLs that were tried and failed, with why. Keeps a thin corpus diagnosable. */
  rejected: z.array(z.object({ url: z.string(), reason: z.string() })),
});

export type Corpus = z.infer<typeof corpusSchema>;

/**
 * Both arrays default to empty, because an ABSENT array means an empty one.
 *
 * A model asked for claims and anything it could not support omits
 * "unsupported" entirely when there was nothing it could not support. That is
 * the natural reading of the instruction and it is what one actually did - on
 * the last chunk of a real run, after the first three had succeeded and been
 * paid for.
 *
 * This does not weaken anything. Claim floors are checked per beat in the gate,
 * deterministically, so a beat that genuinely returned nothing still blocks
 * there. What defaulting removes is a schema error standing in for a content
 * problem the gate is better placed to report.
 */
export const claimSetSchema = z.object({
  claims: z.array(claimSchema).default([]),
  unsupported: z.array(unsupportedClaimSchema).default([]),
});

export type ClaimSet = z.infer<typeof claimSetSchema>;

// ---------------------------------------------------------------------------
// 1. Brief
// ---------------------------------------------------------------------------

export const BRIEF_SYSTEM = `You plan the research for one episode of an audio show.

You are NOT writing the episode. You are deciding what has to be found out
before anyone can write it, and what to search for.

Return JSON only:
{
  "angle": "the specific thing this episode is about, narrower than the topic",
  "mustEstablish": ["facts the episode cannot work without"],
  "queries": ["search engine queries, 5 to 10"],
  "likelyContested": ["claims you expect informed people to disagree about"]
}

Write queries a search engine will answer well: specific nouns, names, dates,
document types. Prefer queries that would surface primary documents - filings,
reports, court records, published research - over queries that would surface
commentary about them.

SEARCH TWICE OVER: once for what happened, and once for WHO AND WHERE AND WHEN.
A listener has nothing to look anything up with, so an episode that can say what
somebody did but not who they were is an episode they cannot follow.

So alongside the queries about events, write queries that would find:
- who each main person was. Their job, their age, their rank, what they had
  done before, why they are in this at all.
- where the places are, and what kind of place they were at the time.
- what any institution, office, title or treaty named here was actually for.
- what else was happening then, so the whole thing can be fixed in time.

Put the same things in mustEstablish. "Who Arnold Paole was" belongs there
exactly as much as "what happened when his grave was opened", and it is the one
that gets forgotten.

Be honest in likelyContested. It drives a search for evidence AGAINST the
episode's reading, and an empty list means that search does not happen.`;

/**
 * Which story each beat of a source script is supposed to tell.
 *
 * THE LINK THAT WAS MISSING, and its absence cost a whole run. `repeats: 10`
 * expands into ten beats with the same id shape, the same type and the SAME
 * FUNCTION TEXT - "One complete story: what it was, who it happened to..." -
 * because that is what the beat sheet says once and the loader copies ten
 * times. Every stage downstream therefore saw ten indistinguishable jobs.
 *
 * The brief had already done the hard part. It chose ten specific stories and
 * listed them: Ganesha's head, the churning of the ocean, Sudarshana, Nandi,
 * Ganga's descent, Bhasmasura, Daksha's sacrifice, Narasimha, Kamadhenu,
 * Garuda. Nothing downstream was ever told. The extractor took whatever the
 * corpus held most of, which meant Nandi twice and Garuda twice - and
 * Narasimha and Kamadhenu, chosen by the brief and searched for, never appeared
 * at all. The silent dropping is the worse half: a set can lose three of the
 * stories it paid to research and still look complete.
 *
 * Pairing them by position is the whole fix, and it is safe because both lists
 * come from the same format: the brief is told how many stories to choose, and
 * mustEstablish is documented as one line per story.
 *
 * Undefined for a format that is not an anthology, and for any beat the brief
 * did not name - a short list is a thin brief rather than a reason to stop, and
 * the starvation check reports what actually went missing.
 */
export const storyForBeat = (
  brief: Brief,
  format: EpisodeFormat,
  beatIndex: number
): string | undefined => (format.sourceOnly ? brief.mustEstablish[beatIndex] : undefined);

/**
 * The brief for a SOURCE format, where the job is the opposite of the usual one.
 *
 * EVERY OTHER FORMAT NARROWS. "The specific thing this episode is about,
 * narrower than the topic" is right for one story told properly, and it is
 * exactly wrong for an anthology: ten self-contained stories need ten different
 * subjects, and a brief that picked one angle would research that angle ten
 * times over and produce ten versions of one story.
 *
 * So a source brief WIDENS. The topic names a body of material - a mythology, a
 * period, a category of thing - and the brief chooses ten specific stories out
 * of it and researches each one separately.
 */
export const SOURCE_BRIEF_SYSTEM = `You plan the research for a set of SHORT, SELF-CONTAINED stories.

You are NOT writing them. You are choosing WHICH stories to tell and deciding
what has to be found out about each one.

This is not one episode about one subject. It is a set of separate short pieces,
each heard on its own by somebody who has heard none of the others. The topic
names a body of material; your job is to pick specific stories out of it.

Return JSON only:
{
  "angle": "the body of material and what these have in common, one line",
  "mustEstablish": ["one line per story: WHICH story it is, named specifically"],
  "queries": ["search engine queries"],
  "likelyContested": ["claims you expect informed people to disagree about"]
}

CHOOSING THEM IS THE WHOLE JOB, and it is what makes the set worth hearing:

- DIFFERENT STORIES, not different angles on one. If two of them share a main
  character, an event and an outcome, one of them is wasted.
- EACH ONE STANDS ALONE. A listener meets it in a feed knowing nothing. A story
  that only makes sense after another has been heard cannot be in the set.
- PICK THE ONES WITH SOMETHING SPECIFIC IN THEM: a name, a number, an object, a
  strange detail somebody wrote down. A story whose whole content is "and then
  the god was angry" has nothing to say for ninety seconds.
- RANGE OVER THE MATERIAL. The famous ones earn their place, and a set that is
  ONLY the famous ones is the set everybody has already heard. Mix what people
  half-know with what they do not.
- NAME EACH ONE IN mustEstablish so the research can be pointed at it: "Ymir,
  and the world made out of his body", not "a creation story".

THE QUERIES ARE PER STORY, NOT PER SET. Aim each one at a named story, plus two
or three for the shared background. A query about the body of material in
general returns overviews, and an overview gives one sentence per story, which
is not enough to tell any of them.

Prefer queries that would surface primary material - translations of the actual
texts, scholarly editions, collected folklore, published research - over
commentary about it.`;

export const buildBrief = async (
  topic: string,
  persona: Persona,
  format: EpisodeFormat,
  writer: LlmClient,
  onCost?: (pence: number) => void
): Promise<Brief> => {
  // completeJson rather than complete: a brief that runs out of room comes back
  // as valid JSON cut off mid-string, and parsing that says "unterminated JSON"
  // - which sends you looking for a prompt problem that is not there.
  return briefSchema.parse(
    await completeJson(
      writer,
      {
        // A source format is researched the other way round. See
        // SOURCE_BRIEF_SYSTEM.
        system: format.sourceOnly ? SOURCE_BRIEF_SYSTEM : BRIEF_SYSTEM,
        prompt: [
          `SHOW: ${persona.name}`,
          `THESIS: ${persona.thesis}`,
          `AUDIENCE: ${persona.audience}`,
          `FORMAT: ${format.name} - ${format.intent}`,
          format.sourceOnly ? `HOW MANY STORIES: ${format.beats.length}` : '',
          `TOPIC: ${topic}`,
        ]
          .filter(Boolean)
          .join('\n'),
        temperature: 0.7,
        // Medium: choosing an angle and writing searchable queries is a
        // judgement, but a small one.
        effort: 'medium',
        maxTokens: 4000,
      },
      onCost
    )
  );
};

// ---------------------------------------------------------------------------
// 2. Gather
// ---------------------------------------------------------------------------

export interface GatherOptions {
  /** How many documents to end up with. */
  targetSources: number;
  /** How many search results to consider per query before fetching. */
  perQuery: number;
}

export const DEFAULT_GATHER: GatherOptions = { targetSources: 14, perQuery: 8 };

/**
 * How many documents a format needs.
 *
 * FOURTEEN WAS SIZED FOR ONE SUBJECT and is simply too few for ten. An
 * anthology researches ten separate stories in one pass, so fourteen documents
 * is one and a bit per story before any of them turns out to be a blog post -
 * and the round-robin above can only spread what it is allowed to fetch.
 *
 * Two per story plus a few for the shared background, capped so a long format
 * cannot quietly commission a hundred fetches.
 */
/**
 * How many documents one SHORT may draw on.
 *
 * TWO, AND THIS IS ABOUT FLOW RATHER THAN ABOUT EVIDENCE. A ninety-second story
 * stitched from four documents is a compilation: four writers' emphases, four
 * sets of names for the same people, four points at which the telling changes
 * register. A listener hears that as the thing jumping around, and it is the
 * difference a listener actually named on a real set - the story drawing on two
 * sources was the best one in it, and the story drawing on four was the worst.
 *
 * A LONG EPISODE IS THE OPPOSITE CASE and is deliberately untouched. Fifteen
 * minutes assembling what fourteen documents separately establish is the whole
 * point of the factual lane; breadth there is the product.
 */
export const MAX_SOURCES_PER_SHORT = 2;

/**
 * Keep each story to the documents that actually carry it.
 *
 * RANKED BY HOW MUCH OF THE STORY EACH SOURCE HOLDS, then by tier. The document
 * a story is mostly built from is the one that tells it; a document
 * contributing a single claim is a footnote, and a footnote read aloud in a
 * ninety-second story is a seam.
 *
 * DETERMINISTIC AND FREE. No model decides this, and it runs on what is already
 * on disk, so it costs nothing and gives the same answer twice.
 *
 * WHAT IT COSTS, said plainly: facts. A story trimmed from four sources to two
 * loses whatever only the other two carried, and can fall below its claim
 * floor - at which point the gate reports it as thin, which is true and is the
 * thing somebody can act on.
 */
export const concentrateSources = (
  claims: Claim[],
  sources: Source[],
  maxPerBeat = MAX_SOURCES_PER_SHORT
): { claims: Claim[]; dropped: Array<{ beatId: string; sourceId: string; claims: number }> } => {
  const tierOf = new Map(sources.map((src) => [src.id, src.tier]));
  const byBeat = new Map<string, Claim[]>();
  for (const claim of claims) {
    byBeat.set(claim.beatId, [...(byBeat.get(claim.beatId) ?? []), claim]);
  }

  const keep: Claim[] = [];
  const dropped: Array<{ beatId: string; sourceId: string; claims: number }> = [];

  for (const [beatId, beatClaims] of byBeat) {
    const counts = new Map<string, number>();
    for (const claim of beatClaims) {
      counts.set(claim.sourceId, (counts.get(claim.sourceId) ?? 0) + 1);
    }

    const ranked = [...counts.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const ta = TIER_RANK[tierOf.get(a[0]) as SourceTier] ?? 9;
      const tb = TIER_RANK[tierOf.get(b[0]) as SourceTier] ?? 9;
      if (ta !== tb) return ta - tb;
      // A stable last resort, so the same corpus gives the same answer twice.
      return a[0].localeCompare(b[0]);
    });

    const kept = new Set(ranked.slice(0, maxPerBeat).map(([id]) => id));
    for (const [id, n] of ranked.slice(maxPerBeat)) dropped.push({ beatId, sourceId: id, claims: n });
    keep.push(...beatClaims.filter((c) => kept.has(c.sourceId)));
  }

  return { claims: keep, dropped };
};

/**
 * Drop claims resting on sources the show will not stand behind.
 *
 * A SHOW'S EVIDENCE POLICY, ENFORCED BEFORE THE WRITER RATHER THAN AT THE GATE.
 * Honest Health declares `minSourceTier: T2` because a health claim sourced to a
 * news write-up of a press release about a preprint passes every other check in
 * this pipeline and is still not evidence about the world.
 *
 * It was only checked at the gate, which is after the script and after the
 * audio. A fever episode was written around a Wikipedia article, voiced, and
 * then told at the gate that the show does not rest claims on sources that weak
 * - at which point the only fix is to write it again.
 *
 * The same shape of fault as the quote check running after the render: a rule
 * that can be applied for free, applied too late to save anything.
 *
 * Returns what was dropped so the run can say so, rather than a beat quietly
 * arriving short of its floor with no explanation.
 */
export const enforceSourceTier = (
  claims: Claim[],
  sources: Source[],
  minTier: SourceTier
): { claims: Claim[]; dropped: Array<{ claimId: string; url: string; tier: string }> } => {
  const floor = TIER_RANK[minTier];
  const byId = new Map(sources.map((src) => [src.id, src]));
  const dropped: Array<{ claimId: string; url: string; tier: string }> = [];

  const keep = claims.filter((claim) => {
    const src = byId.get(claim.sourceId);
    // A claim whose source is not in the corpus is somebody else's problem -
    // repair drops it as `unsourced` - and is not silently binned here too.
    if (!src) return true;

    if (TIER_RANK[src.tier] <= floor) return true;
    dropped.push({ claimId: claim.id, url: src.url, tier: src.tier });
    return false;
  });

  return { claims: keep, dropped };
};

export const gatherFor = (format: EpisodeFormat): GatherOptions =>
  format.sourceOnly
    ? // THREE PER STORY, AND IT WAS TWO. Two documents is one telling plus a
      // fragment, which is enough to say a story happened and not enough to
      // tell it to the end: the first real set stopped Garuda's story at the
      // theft of the nectar, because what Vishnu made of him afterwards was in
      // none of the two documents that story got.
      //
      // A myth is retold constantly and no two retellings carry the same
      // details, so depth here is what makes a story complete rather than
      // merely sourced.
      { targetSources: Math.min(45, format.beats.length * 3 + 6), perQuery: 10 }
    : DEFAULT_GATHER;

/**
 * Search, then fetch, until there are enough documents or candidates run out.
 *
 * Fetch failures are recorded rather than swallowed. A corpus that came out
 * thin should say whether that is because the topic is obscure or because
 * fifteen paywalls said no, and those call for completely different responses.
 */
export const gatherCorpus = async (
  queries: string[],
  search: SearchProvider,
  fetchDeps: FetchDeps,
  opts: GatherOptions = DEFAULT_GATHER
): Promise<Corpus> => {
  // EACH QUERY KEEPS ITS OWN CANDIDATES. Pooling them and ranking the lot
  // together is what this used to do, and it hands the whole corpus to whichever
  // subject the internet has written most about.
  //
  // Measured, on a real run: a brief asked thirteen good questions about ten
  // different Hindu myths - Samudra Manthan, Dadhichi's bones, Nandi, Sati,
  // seven others. Eleven of the fourteen documents that came back were about
  // Ganesha, because Ganesha outranks everything else on every general web
  // search. Seven of the ten stories fetched NOTHING, and the episode written
  // from that corpus told the Ganesha story four times and then spent two beats
  // explaining that the search had not found much.
  //
  // The brief was not at fault and neither was the writer. A ranking that cannot
  // see which question a document answers will always spend its whole budget on
  // the loudest one.
  const perQuery: Array<{ query: string; ranked: ReturnType<typeof rankCandidates> }> = [];
  for (const query of queries) {
    try {
      const found = await search.search(query, opts.perQuery);
      perQuery.push({ query, ranked: rankCandidates(found, tierForUrl) });
    } catch {
      // One failed query should not lose the other nine.
      perQuery.push({ query, ranked: [] });
    }
  }

  const sources: Source[] = [];
  const rejected: Corpus['rejected'] = [];
  const haveIds = new Set<string>();
  const seenUrls = new Set<string>();

  // ROUND ROBIN, so every question is answered once before any is answered
  // twice. A query whose results are all dead still costs only its turn.
  const depth = Math.max(0, ...perQuery.map((q) => q.ranked.length));
  for (let round = 0; round < depth; round++) {
    for (const { ranked } of perQuery) {
      if (sources.length >= opts.targetSources) break;

      const candidate = ranked[round];
      if (!candidate || seenUrls.has(candidate.url)) continue;
      seenUrls.add(candidate.url);

      try {
        const source = await fetchSource(candidate.url, fetchDeps);
        if (haveIds.has(source.id)) continue;
        haveIds.add(source.id);
        sources.push(source);
      } catch (err) {
        rejected.push({ url: candidate.url, reason: (err as Error).message });
      }
    }
    if (sources.length >= opts.targetSources) break;
  }

  return { sources, rejected };
};

// ---------------------------------------------------------------------------
// 3. Extract
// ---------------------------------------------------------------------------

export const EXTRACT_SYSTEM = `You extract factual claims from a corpus of documents,
for one episode of an audio show.

You will be given the episode's beats and a numbered corpus. For each beat,
propose the claims that beat needs, and for EACH claim give a quote from ONE
document that establishes it.

RULES, and these are not style preferences:

1. THE CLAIM MUST SAY NO MORE THAN ITS QUOTE ESTABLISHES. This is the rule
   that decides whether an episode gets made, and it is the one most often
   broken. A claim bundling three facts where the quote supports one is
   rejected, and rejected claims are not available to write from.

   WRONG: "Geillis Duncan, a servant, was tortured with pilliwinks by her
   employer during the North Berwick trials."
   QUOTE: "she was tortured with the pilliwinks upon her fingers"
   The quote supports the torture and the instrument. It says nothing about
   her name, her job, who did it, or which trials. Four facts, one supported.

   RIGHT: "She was tortured with pilliwinks, a thumbscrew, applied to her
   fingers."
   And then, if her name and her employer matter, they are SEPARATE claims
   with their own quotes.

   One claim, one fact, one quote. If you find yourself writing "and" or a
   comma-separated list of circumstances, split it.

   THE COMMONEST VERSION OF THIS IS A PRONOUN. If the quote says "she was
   tortured", the claim may not say "Geillis Duncan was tortured" unless the
   SAME quote also names her. Resolving a pronoun from elsewhere in the
   document, or from what you know, is adding a fact the quote does not carry.
   Either find a quote that names her, or write the claim about "she" and let a
   separate claim establish who she is.

   THE SAME APPLIES TO WHAT A THING IS. If the quote says "the pilliwinks", the
   claim may not gloss it as "the pilliwinks, a thumbscrew" unless the quote
   says so. Glosses are facts.

   FOUR MORE WAYS THIS HAPPENS, every one of them from a real episode that
   failed on it. All four are the same move as the pronoun: reaching into the
   surrounding document, or into what you know, for something the quote itself
   does not carry.

   COMPLETING A NAME. Quote: "Wood, 59, of Cheshunt". The claim may not say
   "Carl Wood is 59". The quote says Wood. Another claim can establish that
   Wood is Carl Wood.

   DECODING AN INITIAL OR A COURT FORM. Quote: "in 1985 you took part in the
   Security Express robbery" from a sentencing remark addressed to TP. The
   claim may not say "Perkins took part". Sentencing remarks address defendants
   as "you" and abbreviate them to initials; resolving that is exactly this
   mistake in its most tempting form.

   NAMING THE SPEAKER OF A QUOTATION. Quote: "the burglary stood in a class of
   its own". The claim may not say "Judge Kinch said it stood in a class of its
   own" unless the quote names him. Who said it is a second fact and needs a
   second quote.

   ANCHORING IT IN TIME. Quote: "they drilled through the wall but could not
   move the cabinets". The claim may not say "on the FIRST night they drilled
   through". Which night is not in the quote, however obvious it is from the
   document around it.

2. The quote must be COPIED EXACTLY from the document. Not paraphrased, not
   tidied, not shortened with ellipses. It is checked character by character
   against the source and a paraphrase is rejected.
3. The quote must be at least 40 characters.
4. If the corpus does not support something the beat needs, put it in
   "unsupported" and move on. Do NOT stretch a quote to cover it. Abstaining is
   a correct answer and is used to send the researcher back out.
5. Claim types: statistic, causal, quotation, chronology, attribution,
   definition. A statistic must state a number and its quote must contain one.
   Only call something causal if the document states a cause; if the document
   says "associated with", the claim says associated with.

   TYPE IT "quotation" ONLY IF THE CLAIM REPRODUCES THE QUOTED WORDING. A
   quotation claim is checked by looking for the claim's own words inside the
   quote, so a claim that DESCRIBES what someone said is not a quotation - it is
   an attribution. "The pamphlet says the tortures were described with relish"
   is an attribution. "The pamphlet calls it 'the most cruell torment'" is a
   quotation, and only if those exact words are in the quote.
6. Mark contested: true when informed people would disagree.
7. EVERY NAME NEEDS A SECOND CLAIM SAYING WHO OR WHAT IT IS. This is the rule
   that decides whether the episode is followable, and it is the one most often
   skipped, because a claim about what somebody DID always feels more important
   than a claim about who they were.

   It is not. A listener has nothing to look anything up with. A name they
   cannot place is a name they drop, and they drop the sentence with it.

   So for every PERSON named anywhere in your claims, there must also be a
   claim establishing who they were - their job, their age, their rank, what
   they had done before, why they are in this story at all:

     "Arnold Paole was bothering people at night"         the event
     "Arnold Paole was a hajduk, a frontier militiaman"   WHO HE WAS

   For every PLACE, a claim saying where it is and, where the source supports
   it, what kind of place:

     "Medvegia is a village in Serbia, near the Morava"

   For every INSTITUTION, TITLE, RANK OR OFFICE - an army command, a court, a
   treaty, a job like Kameralprovisor - a claim saying what it was for.

   And for the WHOLE EPISODE, at least one claim that fixes it in time in a way
   a listener can hold: a date, a reign, a war, something else that was
   happening.

   These identity claims follow every other rule here. They need their own
   quote, the quote must contain the identity, and if the corpus does not
   support one, it goes in "unsupported" like anything else - which is a useful
   signal on its own, because a story whose people cannot be identified from the
   sources is a story this show cannot yet tell.

Return JSON only:
{
  "claims": [
    {"id":"c1","beatId":"...","text":"...","type":"...","sourceId":"...",
     "quote":"exact text from that document","contested":false}
  ],
  "unsupported": [{"beatId":"...","text":"what could not be supported",
                   "attemptedQueries":["what would have been needed"]}]
}`;

/**
 * How much of each document to show the extractor.
 *
 * Whole documents would blow the context window on a corpus of fourteen, and
 * the head of a document is where its thesis and its numbers almost always
 * live. A source whose relevant passage is on page nine is a source this stage
 * will miss, which is a real limitation and worth stating rather than hiding.
 */
export const EXTRACT_CHARS_PER_SOURCE = 6000;

/**
 * How many beats to extract claims for in one call.
 *
 * ONE CALL FOR THE WHOLE EPISODE DOES NOT FIT, which is how this was found: ten
 * beats against fourteen documents, each claim carrying a verbatim quote of
 * forty characters or more, ran past sixteen thousand output tokens twice and
 * killed the run after the corpus had already been fetched and paid for.
 *
 * Three beats is small enough that the reply always fits with room to spare,
 * and it is better work as well as safer: a model asked for claims for three
 * beats reads the corpus for three specific jobs, where one asked for ten
 * spreads itself and returns something thinner for each.
 */
export const BEATS_PER_EXTRACTION = 3;

/**
 * How many claims a beat may take from the corpus.
 *
 * THIS USED TO BE `minClaims + 2`, AND THAT WAS A CEILING ON HOW MUCH AN
 * EPISODE COULD KNOW. A health episode fetched 1.1 million characters of
 * primary sleep literature - meta-analyses, the actual ripple recordings, the
 * actual glymphatic paper - and was permitted to take thirty-five facts out of
 * it. It took twenty-nine, and then had to fill eleven and a half minutes with
 * them, which is one fact every twenty-eight seconds. What fills the other
 * twenty-seven is restatement, and a listener hears an episode trying hard to
 * be interesting because it does not have enough to say.
 *
 * The floor answers "is this beat sourced at all". It was never meant to answer
 * "how much is there to say here", and the second question is a question about
 * TIME: a four-minute beat can carry far more than a one-minute beat, whatever
 * its floor happens to be.
 *
 * One claim per twelve seconds is dense. It is not a target - the writer is
 * given these and chooses, and having more than it needs is the point, because
 * choosing the best four of twenty is a different job from stretching four to
 * fill four minutes.
 *
 * The floor still wins where it is higher, so a short beat with a heavy
 * sourcing duty is not quietly capped below it.
 */
export const SECONDS_PER_CLAIM = 12;

export const claimCeiling = (beat: { minClaims: number; seconds: [number, number] }): number =>
  Math.max(beat.minClaims + 2, Math.round(beat.seconds[1] / SECONDS_PER_CLAIM));

/**
 * Extract the claims an episode needs, a few beats at a time.
 *
 * THE CORPUS IS SENT AS A CACHED SYSTEM PREFIX, which is what stops chunking
 * from multiplying the bill. The documents are the expensive half of this
 * prompt and they are identical across every chunk, so the first call writes
 * the cache and the rest read it at a tenth of the price. Chunking without
 * this would have tripled the input cost of the most input-heavy stage in the
 * pipeline.
 *
 * Claim ids are renumbered across chunks. Each call starts counting at c1
 * because it cannot see the others, and two claims sharing an id would collide
 * silently in the ledger - the later one simply replacing the earlier.
 */
export interface ExtractionCheckpoint {
  /** Chunks a previous attempt already extracted, in order. */
  done: ClaimSet[];
  save: (done: ClaimSet[]) => void;
}

export const extractClaims = async (
  brief: Brief,
  corpus: Corpus,
  format: EpisodeFormat,
  writer: LlmClient,
  onCost?: (pence: number) => void,
  onProgress?: (message: string) => void,
  checkpoint?: ExtractionCheckpoint
): Promise<ClaimSet> => {
  // What the episode is trying to establish, which is what each passage is
  // scored for relevance against.
  const wanted = [brief.angle, ...brief.mustEstablish, ...brief.queries];

  const documents = corpus.sources
    .map(
      (s, i) =>
        `--- DOCUMENT ${i + 1} | sourceId: ${s.id} | tier: ${s.tier} | ${s.title}\n` +
        selectPassages(s.text, wanted, EXTRACT_CHARS_PER_SOURCE)
    )
    .join('\n\n');

  const system = `${EXTRACT_SYSTEM}\n\nCORPUS:\n${documents}`;

  const chunks: (typeof format.beats)[] = [];
  for (let i = 0; i < format.beats.length; i += BEATS_PER_EXTRACTION) {
    chunks.push(format.beats.slice(i, i + BEATS_PER_EXTRACTION));
  }

  // Chunks already extracted by a previous attempt. Each one is several
  // thousand tokens over a corpus that had to be searched and fetched first, so
  // throwing three away because the fourth came back in an unexpected shape is
  // exactly the waste the rest of this pipeline checkpoints to avoid.
  const done: ClaimSet[] = [...(checkpoint?.done ?? [])].slice(0, chunks.length);

  if (done.length) {
    onProgress?.(`resuming after ${done.length} chunk(s) already extracted`);
  }

  for (const [index, chunk] of chunks.entries()) {
    if (index < done.length) continue;

    onProgress?.(
      `beats ${chunk.map((b) => b.id).join(', ')} (${index + 1}/${chunks.length})`
    );

    const beats = chunk
      .map((b) => {
        // THE STORY THIS BEAT IS FOR, where there is one. Without it every beat
        // of an anthology reads as the same job, and the extractor answers them
        // all with whatever the corpus holds most of.
        const subject = storyForBeat(brief, format, format.beats.indexOf(b));
        return (
          `- ${b.id} (${b.type}, needs >= ${b.minClaims} claims, and up to ` +
          `${claimCeiling(b)}): ${subject ? `THIS BEAT TELLS: ${subject}` : b.function}`
        );
      })
      .join('\n');

    const raw = await completeJson<unknown>(
      writer,
      {
          system,
          // The corpus never changes between chunks, so the prefix stays valid
          // and every call after the first reads it rather than re-sending it.
          cacheSystem: true,
          prompt: [
            `ANGLE: ${brief.angle}`,
            `MUST ESTABLISH:\n${brief.mustEstablish.map((m) => `- ${m}`).join('\n')}`,
            format.sourceOnly
              ? `Extract claims for THESE BEATS ONLY. Each one is a SEPARATE story, and ` +
                `its claims must be about THAT story - not about the subject in general, ` +
                `and never about a story another beat is telling.`
              : `Extract claims for THESE BEATS ONLY. Ignore every other beat of the episode.`,
            `BEATS:\n${beats}`,
          ].join('\n\n'),
          temperature: 0.2,
          // Low effort: the shape of the answer is already decided and the
          // model is filling it in. Thinking is billed at output rates, so an
          // extractor reasoning at length about a JSON schema pays premium
          // rates to be less likely to finish - which is exactly how this stage
          // died, returning content blocks with no text among them.
        effort: 'low',
        // ROOM FOR WHAT THE CEILING NOW ALLOWS. Three beats at up to fifteen
        // claims each, every one carrying a verbatim quote, is a far larger
        // reply than when this number was chosen and the ceiling was six.
        // A truncated reply comes back as JSON that repairs into valid objects
        // with fields missing, which is how a claim arrived without its quote.
        maxTokens: 24000,
      },
      onCost
    );

    // ONE BAD CLAIM MUST NOT COST THE CHUNK. This parsed the whole reply and
    // threw on any failure, so a single claim missing its `quote` field - one
    // of eighteen - killed a run that had already paid for thirty-six documents
    // and one extraction call, and would have to pay for the call again.
    //
    // Claims are independent of each other. A malformed one is dropped and
    // named; the rest are kept. The floors are checked at the gate over what
    // actually survived, deterministically, so tolerating a bad claim here
    // cannot quietly produce an under-sourced beat.
    const reply = (raw ?? {}) as { claims?: unknown; unsupported?: unknown };
    const candidates = Array.isArray(reply.claims) ? reply.claims : null;

    // NOT AN ARRAY AT ALL means the reply is not a claim set, which is the
    // failure the old message was written for and is still worth naming.
    if (!candidates) {
      throw new Error(
        `the extractor returned something unusable for beats ` +
          `${chunk.map((b) => b.id).join(', ')}: no claims array
` +
          `It returned: ${JSON.stringify(raw).slice(0, 300)}`
      );
    }

    const usable: Claim[] = [];
    const malformed: string[] = [];

    for (const [index, candidate] of candidates.entries()) {
      const one = claimSchema.safeParse(candidate);
      if (one.success) {
        usable.push(one.data);
        continue;
      }
      const id = (candidate as { id?: string })?.id ?? `#${index}`;
      malformed.push(`${id} (${one.error.issues.map((i) => i.path.join('.')).join(', ')})`);
    }

    if (malformed.length) {
      onProgress?.(
        `dropped ${malformed.length} malformed claim(s): ${malformed.slice(0, 4).join('; ')}`
      );
    }

    // AN EMPTY SET IS A LEGITIMATE ANSWER and a set that was entirely malformed
    // is not. "The corpus holds nothing for these three beats" is a real and
    // useful reply - it is what `unsupported` is for, and the gate's claim
    // floors catch the consequence. Eighteen broken claims means the call did
    // not do the work, and carrying on would hand the gate three empty beats
    // and make it look like the beat sheet's fault.
    if (!usable.length && malformed.length) {
      throw new Error(
        `the extractor returned nothing usable for beats ` +
          `${chunk.map((b) => b.id).join(', ')}: all ${malformed.length} claims were ` +
          `malformed, starting with ${malformed[0]}
` +
          `It returned: ${JSON.stringify(raw).slice(0, 300)}`
      );
    }

    // The notes about what could NOT be supported, which are as much a part of
    // the answer as the claims. Absent means empty, and a malformed set of them
    // is dropped rather than thrown for, exactly like a malformed claim.
    const notes = unsupportedClaimSchema.array().safeParse(reply.unsupported ?? []);

    const result = {
      success: true as const,
      data: { claims: usable, unsupported: notes.success ? notes.data : [] },
    };

    done.push(result.data);
    // Saved after EVERY chunk. Each is thousands of tokens over a corpus that
    // had to be fetched first.
    checkpoint?.save(done);
  }

  // Renumbered against the running total across chunks, not within one. Each
  // call starts at c1 because it cannot see the others, and two claims sharing
  // an id collide silently in the ledger.
  const claims: ClaimSet['claims'] = [];
  const unsupported: ClaimSet['unsupported'] = [];

  for (const chunkResult of done) {
    for (const claim of chunkResult.claims) {
      claims.push({ ...claim, id: `c${claims.length + 1}` });
    }
    unsupported.push(...chunkResult.unsupported);
  }

  return { claims, unsupported };
};

// ---------------------------------------------------------------------------
// 4. Counter-evidence
// ---------------------------------------------------------------------------

export const COUNTER_SYSTEM = `You are looking for evidence AGAINST a claim.

Given a claim, propose search queries most likely to surface credible
disagreement, failed replications, corrections, retractions, or contrary
findings. Do not propose queries that would confirm it.

Return JSON only: {"queries": ["...", "..."]}`;

/**
 * The disconfirming searches a run made, as stored on disk.
 *
 * Exported because two things read it back: the pipeline resuming a run, and
 * the re-gate. A private copy in each is how a re-gate ends up passing an empty
 * list and reporting that twelve searches never happened.
 */
export const counterEvidenceSchema = z.array(
  z.object({
    claimId: z.string(),
    sources: z.array(z.custom<Source>()),
    queries: z.array(z.string()),
  })
);

export interface CounterEvidence {
  claimId: string;
  /** Sources found that argue against the claim. */
  sources: Source[];
  queries: string[];
}

/**
 * Actively look for disconfirmation of contested claims.
 *
 * This is the step that separates a grounded show from a confident one. The
 * self-help genre in particular is built almost entirely on findings that
 * failed to replicate or whose effect sizes collapsed, and a pipeline that only
 * ever searches for support will reproduce all of them with perfect citations.
 */
export const gatherCounterEvidence = async (
  claims: Claim[],
  search: SearchProvider,
  fetchDeps: FetchDeps,
  writer: LlmClient,
  opts: { perClaim?: number } = {},
  onCost?: (pence: number) => void
): Promise<CounterEvidence[]> => {
  const contested = claims.filter((c) => c.contested);
  const out: CounterEvidence[] = [];

  for (const claim of contested) {
    const res = await writer.complete({
      system: COUNTER_SYSTEM,
      prompt: `CLAIM: ${claim.text}`,
      temperature: 0.5,
      maxTokens: 400,
    });
    onCost?.(res.costPence);

    let queries: string[] = [];
    try {
      queries = z.object({ queries: z.array(z.string()) }).parse(extractJson(res.text)).queries;
    } catch {
      queries = [];
    }

    const found: Source[] = [];
    for (const query of queries.slice(0, opts.perClaim ?? 2)) {
      try {
        const results = await search.search(query, 5);
        for (const r of rankCandidates(results, tierForUrl).slice(0, 2)) {
          try {
            found.push(await fetchSource(r.url, fetchDeps));
          } catch {
            // A counter-source that will not fetch is not a failure of the run.
          }
        }
      } catch {
        // Same.
      }
    }

    out.push({ claimId: claim.id, sources: found, queries });
  }

  return out;
};

/** Everything the ledger stage produces, ready to be written as one artifact. */
export const buildLedger = (claimSet: ClaimSet, corpus: Corpus) => {
  const report = checkLedger(claimSet.claims, corpus.sources);
  return {
    claims: claimSet.claims,
    unsupported: claimSet.unsupported as UnsupportedClaim[],
    report,
  };
};
