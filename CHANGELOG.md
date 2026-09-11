# Changelog

What changed, and why it was worth changing. Newest first.

This file is written for someone trying to understand a decision months later,
so entries say what was rejected as well as what was chosen. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/); versions are not
released anywhere, so they mark meaningful milestones rather than publishes.

## [Unreleased]

Building toward the first publishable episode.

### Added

- **A publishing cadence** (`schedule.yaml`, `topics/`, `src/schedule/`,
  `foundry due`, `foundry tick`). What is due is computed from what was actually
  published rather than from a timer's own memory, which is the whole difference
  from cron: a show that missed last week is due now, where cron silently skips
  whenever the machine was off, a run failed, or a gate rejected an episode. The
  trigger is stateless and carries no state to drift. `tick` makes one thing and
  stops. Publishing still stops at the gate unless a show opts in, and even then
  anything the gate flagged for human review waits. Topic choice stays a list a
  person writes; auto-generated topics were rejected because a studio that picks
  its own subjects converges on whatever the model finds most available.
- **Cover art** (`src/art/cover.ts`). Drawn, not generated: a cover's one job is
  to be recognised at 64 pixels in a scrolling feed, which is typography rather
  than illustration; covers that vary week to week destroy the recognition they
  exist for; and drawing is deterministic, so a re-publish never quietly changes
  the artwork of something already in a listener's library. Square for a card,
  16:9 for a series shelf, because art that does not match the platform's frame
  is cropped on display.
- **Series publishing** (`src/publish/seriesRegistry.ts`, `foundry
  series-setup`, plus two ingest mounts on the platform). A serial's episodes
  now carry numbers and an order. `series.json` is committed because series
  creation has no create-or-get and losing the file forks a show into two
  shelves.
- **A short-form lane** (`src/script/shorts.ts`, `src/pipeline/short.ts`,
  `beatsheets/short-teardown.yaml`, `foundry short`). Shorts are DERIVED from an
  episode that already passed, not researched independently: a standalone short
  would need its own brief, search, corpus, extraction, verification and
  counter-evidence pass to produce seventy-five seconds of audio, which is about
  a pound ten against twelve pence. Same verified facts, same voices.
  A short is not a trailer, so the selection asks for the strongest
  SELF-CONTAINED moment rather than the most representative one, and it may
  carry no contested claim at all - seventy-five seconds cannot hold a
  steelmanned counterpoint, and cramming one in produces a strawman, which is
  worse than none because it looks like fairness. Rejected: a `--short` flag on
  `make`, which would have made shorts a length rather than a format.
- **A fiction lane** (`src/fiction/`, `src/pipeline/fiction.ts`,
  `beatsheets/serial-episode.yaml`, `personas/night-shift.yaml`). Skips the
  evidence pipeline entirely - there is no document that entails a conversation
  nobody had - and is checked against a series bible instead: an episode may not
  contradict what earlier episodes established. Same shape as verification
  (deterministic pass first and free, then a different model family), different
  ground truth. `unclear` blocks, for the same reason `partially_entailed` does.
  Facts can be marked revisable, and those are hidden from the writer: fiction
  turns on things being revealed as untrue, and enforcing every recorded fact
  would forbid the twist. The bible is written only on a pass, and only once.
  Rejected: fiction as a per-episode flag. A show that reconstructs filings one
  week and invents a story the next has destroyed the only thing the evidence
  pipeline was buying it, so it is a property of the show and there is no
  command-line switch that turns fact-checking off.
- **Prompt caching on the beat writer** (`src/models/client.ts`). The system
  prompt is the show's canon, taboos, style rules and cast, it runs well over a
  thousand tokens, and it is identical across the twelve to fifteen calls that
  write one episode. Caching is a prefix match, so responses report cached
  tokens: a cache that quietly stops hitting costs more than no cache at all
  while every run still succeeds.
- **A clerk model tier** (`clerkConfig`). A cheap model for mechanical work,
  currently just the counter-evidence search queries. The rule is deliberately
  strict: a cheap model may only do work whose output is checked by something
  that is not a model. Not the brief, not extraction, not the hook, not the
  title, not verification, not the series bible. Those are the show, and pennies
  is the wrong price for them.
- **Open loops** (`src/script/loops.ts`). A beat sheet declares which questions
  each beat opens and which it answers, validated at load. The opening beat must
  open at least one and close none; nothing may resolve before three quarters
  through. The writer is told, per beat, what to leave unanswered.
- **A hook competition** (`src/script/hooks.ts`). The opening is written sixteen
  times, filtered on measurable curiosity-gap properties, and the survivors
  judged. Every other beat gets one draft plus revisions; the first eight
  seconds get a contest.
- **Two hosts who stay two people** (`src/script/voices.ts`). Each host declares
  measurable speech habits - mean turn length, question rate, backchannel rate,
  signature phrases - and the distance between them is checked. Convergence,
  flat turn rhythm, and one host using the other's phrases all block.

- **A show is a cast, not a voice.** Two hosts with different jobs, rendered
  through the provider's dialogue endpoint as one request per beat so
  turn-taking, overlap and interruption are modelled rather than spliced.
  Narrated shows are a cast of one, so there is a single code path.
- **Failed beats are repaired, not just rejected.** A beat that fails its
  deterministic checks is handed the previous draft AND the specific failures
  and rewritten, cooler than it drafted. Bounded at two revisions.
- **Passage selection** (`src/evidence/passages.ts`). Extraction's character
  budget is now filled by BM25-shaped scoring against the brief instead of
  truncating from the front, so a filing whose relevant paragraph is on page
  nine contributes that paragraph.
- **The lexical half of the AI tell** - sentence-opener diversity, repeated
  trigrams, and common-word share as a free stand-in for perplexity.
- **Pairwise comparison** (`src/qa/compare.ts`, `foundry compare`). Answers "is
  this getting better", which the gate cannot: every gate check is a floor, and
  an episode can clear all of them and still be dull. Controls for position bias
  (both orderings, disagreement recorded as a tie), self-preference (judged by
  the verifier, a different family from the writer) and verbosity (stated in the
  prompt). A separate command, so it costs nothing on an ordinary run.
- **Optional Exa and Firecrawl** (`src/evidence/providers.ts`), opt-in by env
  var. Exa pools with Brave for neural search; Firecrawl renders JavaScript and
  falls back per URL.

- **The pipeline runs end to end** (`src/pipeline`, `src/cli.ts`). Nine stages,
  each persisting its artifact, fully resumable, with a budget ceiling checked
  after every costed call. `npm run foundry -- make --show the-teardown --topic
  "..."` researches, writes, renders and gates one episode.
- **Publishing is a separate, deliberate command.** `make` always stops at the
  gate.
- **The QA gate** (`src/qa/gate.ts`): ledger, factuality, evidence density,
  counter-evidence, style, self-similarity, duration and risk tier. Fails
  closed. Two checks defer to a human rather than pretending arithmetic settles
  them. A fiction show swaps the first four for continuity; everything from
  style down applies to both, because those are properties of the audio rather
  than of how it was sourced.
- **Publish client and provenance** (`src/publish`). Publishes through the
  ordinary creator upload API, sending the AI disclosure, the beat map and the
  evidence summary that becomes the Sources sheet.
- **Render per beat** (`src/render`) with measured durations, so beat
  timestamps are real. Hands the platform a clean 48kHz mono source and does
  not master.
- **Writer and verifier clients** (`src/models`), different model families,
  every call reporting its cost.
- **Research** (`src/evidence/research.ts`, `search.ts`): brief, gather,
  extract, counter-evidence.
- **Run store** (`src/run`): a run is a directory you can open.

- **Every claim binds to a quote span you can find in the source**
  (`src/evidence/claim.ts`). Two checks in order: deterministic (does this quote
  actually occur in the document?) then semantic (does it support the claim?).
  Plus per-type structural rules - a statistic must carry a number, a causal
  claim may not be stated when the quote only reports an association, an
  attribution may not rest on a T4 source.
- **A source can only exist by being fetched** (`src/evidence`). `fetchSource`
  is the sole producer of a `Source`, so a model can select from what is there
  and has no path to create one. Citation hallucination is not discouraged here,
  it is structurally impossible: a reference that was never fetched has nowhere
  to come from. Includes deterministic HTML-to-text extraction, content hashing
  so a document that rewrites itself under a published episode is detectable,
  and domain-based source tiering.
- **An episode is beats, not a prose brief** (`src/formats`, `beatsheets/`).
  Beat sheets are YAML with a closed set of beat types, per-beat claim floors,
  and a reviewable tension curve. The first sheet is `case-study-teardown`.
  Three things fall out of this that a prose brief cannot give: evidence density
  enforceable per beat, a writer filling one bounded job at a time, and beat
  start/end timestamps at render - which is what later lets drop-off be
  attributed to a *kind* of beat rather than to an episode.
- **A show is data, not a prompt** (`src/canon`, `personas/`). Personas are
  YAML, validated by a Zod schema at load, with the first show `the-teardown`
  shipped. Canon entries are append-only and effective-dated so a show can
  evolve without retconning what it already said - a callback to episode 3 must
  still refer to what the show thought then.
- **Style targets are numbers, not adjectives** (`styleCard`). Stage 7 has to
  score a draft for "does this sound like the show" automatically, and "warm but
  not chatty" is not a test. Includes a minimum sentence-length *spread*, not
  just a mean: uniform sentence length is the clearest tell of generated prose,
  so a draft that hits the mean with no variance fails rather than passes.
- **Repository skeleton.** TypeScript, CommonJS, `tsc` build, Jest, ESLint,
  deliberately mirroring `Audio-Vibe/services/api` so the two repos feel the
  same to work in rather than each being clever in its own way.
- `personas/` and `beatsheets/` as data directories. A show bible and a beat
  sheet are content, not code: changing how a show sounds should not be a
  deploy, and the person tuning them should not need to read TypeScript.
- `runs/` for generated episodes, git-ignored. Large, reproducible from the
  committed inputs, and a rejected take is not something history should carry.

### Fixed

- **Three silent breaks in the publish path**, in the one part of the repo that
  had never run against the real API. It sent a category NAME in a field that
  wants ids (and the API drops an id it does not recognise, so a wrong one
  publishes an episode that plays perfectly and is invisible to every genre
  rail); it omitted `content_rating`, which the API refuses rather than
  defaults; and it had no series route, so a serial's episodes could only land
  loose. All three land at the last command of a pipeline that has already spent
  money.
- **A long title ran off the edge of its cover.** It typechecked, it rendered,
  and it would have published. Found by rendering one and looking at it.

- **Two runs of the same show in one second collided.** Run ids stamp to the
  second, and `Run.create` mkdir -p'd straight into the existing directory:
  same manifest path, same artifacts, `hasArtifact` true for stages the new run
  had never done. It would have written an episode out of another episode's
  corpus and looked entirely healthy doing it. Cutting a short immediately after
  gating its parent does exactly that, so this was one command away from
  happening for real. Ids now disambiguate, keeping the chronological sort.
- **A resumed fiction run recorded its episode into the bible twice.** The bible
  is append-only and lives outside the run directory, so nothing downstream
  would ever have noticed the duplicate - it would simply have become two
  episodes that both happened.
- **A short's claim floors made it a list.** A floor on all four fact-bearing
  beats forced four separately sourced facts into seventy-five seconds, which
  is the opposite of one idea told properly. Floors now sit on the beat that
  states the thing and the beat that answers it, and claim redistribution fills
  floors before spreading - a plain round-robin looks fair and can leave both
  required beats empty while filling the two that needed nothing.

### Decided

- **An open loop at the START, never a closed one.** The research is specific: a
  loop opened at the start holds attention across the whole runtime, and one
  closed at the start lets the listener leave satisfied in the first ten
  seconds. Almost every weak opening is a closed loop - it summarises, explains
  what the episode is about, or answers its own question. Enforced on the beat
  sheet, because that is a structural failure and not a style preference.
- **Curiosity needs a SPECIFIC missing piece.** Loewenstein's information-gap
  account is precise about this: curiosity is the felt gap between what you know
  and what you want to know. "Something strange happened" opens nothing;
  "twenty-seven went in, twenty-six came out" opens a gap you cannot ignore. So
  hook scoring rewards a number, a name, a date, and punishes abstraction.
- **Loops are declared, not inferred.** You cannot reliably read "is this
  question still open" out of prose. You can check the arithmetic of which beat
  opens and closes what. Structure is checkable; intent is not.
- **Backchannels are checked as a BAND, not a maximum.** Too few reads as two
  monologues alternating; too many reads as one person being agreed with. Both
  extremes measurably reduce how natural a conversation sounds.
- **Turn-length variance is the dialogue version of sentence-length variance.**
  Real conversation puts a four-word turn next to a sixty-word one. Uniform turn
  length is two people taking it in turns to give speeches.

- **Dialogue over narration.** Polished monologue read by a synthetic voice is
  the most AI-sounding format available, because it is exactly what
  text-to-speech has always produced. What makes two hosts work is not the
  disfluencies but that they want different things: one has read the documents
  and one has not and presses. Sprinkling hesitation onto agreement does not
  work, which is why every AI podcast where two voices agree enthusiastically
  still sounds like one.
- **Not MCP, and the interfaces are why.** MCP exists so an agent can DISCOVER
  tools it was not built against. This pipeline has nine fixed stages calling
  the same things in the same order, so discovery buys nothing and costs a
  transport and a schema round-trip per call. What MCP would actually provide is
  a stable interface boundary, and `SearchProvider` and `FetchDeps` already are
  one - an MCP-backed provider drops in behind either without anything upstream
  noticing.
- **Passage scoring, not a reranker API.** Hybrid-retrieve-then-cross-encode is
  right when ranking thousands of candidates. Here the corpus is fourteen
  already-fetched documents, so the question is which PARAGRAPHS, and that is a
  lexical problem a local scorer solves for free.

- **The pipeline never publishes.** The two gate checks that defer to a human -
  has the script acknowledged the counter-evidence, is that T4 source framed as
  an anecdote - are exactly the ones automation would wave through. A studio
  that publishes without anyone reading the first episodes is the failure this
  whole design exists to avoid.
- **A rejected claim never reaches the writer.** Filtering at the point the
  script is written, rather than catching it at the gate, means a single gate
  bug cannot ship a claim the verifier already refused.
- **A thin corpus abandons the run.** Fewer than four usable sources and the run
  stops with the fetch failures recorded, because continuing produces a script
  whose every claim comes from three documents.

- **File-based run artifacts, not Postgres, for now.** The design document
  gives the Foundry its own database. That is right at volume, and wrong at
  three shows a week: what the evidence ledger needs first is to be
  *inspectable*, and a directory of JSON you can open beats a table you have to
  query. Postgres earns its place at stage 9, when the closed loop starts
  asking cross-run questions. Moving then is a migration of files that were
  always structured; starting there would be setup friction paid before any
  episode existed.
- **Check that a quote EXISTS before asking whether it supports anything.** A
  model asked to quote a source will, given the chance, produce something the
  source almost says, and a semantic verifier handed that quote often approves
  it - because the quote does support the claim, it just is not in the document.
  Existence is deterministic, free, and closes that hole entirely.
- **Source tiering guesses down, never up.** Anything unrecognised is T3, and a
  claim takes the *weakest* tier supporting it, so one forum post cannot be
  laundered into fact by sitting beside three papers. Domain is a weak signal
  for authority and a human can override it on the record.
- **The counterpoint beat is never optional.** Confident one-sidedness is the
  most common way generated content is false while every individual sentence is
  sourced, and an optional beat is one that quietly stops appearing. Enforced by
  a test over every shipped format, not by convention.
- **Formats borrow structure, never text.** Where the hook lands and how tension
  is renewed is grammar and transfers; a paraphrase inherits the other show's
  specifics, which are exactly the part that does not. No transcript is ever
  ingested.
- **The voice lives in the persona file, never in the environment.** Voice is
  what a show IS to a listener, more than its name or artwork. A value that can
  drift by deployment is a value that will, and swapping one silently is the
  audio equivalent of replacing a presenter mid-season without saying so.
- **Build toward one publishable episode before scaffolding all nine stages.**
  A complete framework that has never published anything hides its own design
  errors. If the first episode is not good enough to go out under AudioVibe's
  name, the design is wrong, and that is much cheaper to learn now.
