# Changelog

What changed, and why it was worth changing. Newest first.

This file is written for someone trying to understand a decision months later,
so entries say what was rejected as well as what was chosen. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/); versions are not
released anywhere, so they mark meaningful milestones rather than publishes.

## [Unreleased]

Building toward the first publishable episode.

### Added

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

- **File-based run artifacts, not Postgres, for now.** The design document
  gives the Foundry its own database. That is right at volume, and wrong at
  three shows a week: what the evidence ledger needs first is to be
  *inspectable*, and a directory of JSON you can open beats a table you have to
  query. Postgres earns its place at stage 9, when the closed loop starts
  asking cross-run questions. Moving then is a migration of files that were
  always structured; starting there would be setup friction paid before any
  episode existed.
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
