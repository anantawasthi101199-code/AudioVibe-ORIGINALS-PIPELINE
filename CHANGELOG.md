# Changelog

What changed, and why it was worth changing. Newest first.

This file is written for someone trying to understand a decision months later,
so entries say what was rejected as well as what was chosen. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/); versions are not
released anywhere, so they mark meaningful milestones rather than publishes.

## [Unreleased]

Building toward the first publishable episode.

### Added

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
  them.
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

### Decided

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
