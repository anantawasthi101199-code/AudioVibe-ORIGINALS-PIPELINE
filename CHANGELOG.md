# Changelog

What changed, and why it was worth changing. Newest first.

This file is written for someone trying to understand a decision months later,
so entries say what was rejected as well as what was chosen. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/); versions are not
released anywhere, so they mark meaningful milestones rather than publishes.

## [Unreleased]

Building toward the first publishable episode.

### Added

- **Regenerate, as takes** (2026-10-08). "Regenerate voice" voices the same
  saved script again from scratch (every beat file and key deleted first), asked
  twice in the page and refused by the server without `confirm: true`. It never
  replaces: every finished voicing is kept in `takes/` with its render record
  and gate report, and the Sound section lists them with a player each and a
  radio button for the one that publishes. A new take waits as a draft; the
  chosen take is copied back into `media/episode.wav`, so publishing, music and
  players read the one place they always have. Takes of an earlier script are
  listen-only; once approved for a day or published the choice is fixed. Each
  regeneration adds 15p to a short's target and ceiling (£1 for an episode).

- **Scheduling: one short and one episode a day per channel, on the earliest
  free days** (2026-10-08). Approving used to fill a weekly quota from
  schedule.yaml (one episode and three shorts for most channels) with a short
  never allowed on an episode's day, so eight approved shorts went out over
  three weeks with silent days between them. Now every channel can put out at
  most one short and one episode on any day; each approval takes the earliest
  free day for its kind from tomorrow (never today), already-approved runs keep
  their days, and a full week rolls into the next. The episode goes out at the
  channel's slot hour, the short at a different, varied hour. Publishing now is
  not limited by any of this. `perWeek` in schedule.yaml now only feeds the
  "due to make" plan.

- **Approved-but-not-voiced runs are no longer "ready", targets no longer stop
  a run, and the run page is two columns** (2026-10-08).
  - The bug: a Business Decoded short approved on ElevenLabs had its GPT voice
    discarded, and the new voicing stopped at the 15p short ceiling. The gate
    report written BEFORE the render was still on disk and passed, so the run
    sat in To decide with no audio, no Approve and no Resume. A run is now only
    `ready` once its render and its final gate are complete; otherwise it is
    `needs-voice`, listed under "To finish", with a Voice it button on its page.
    It cannot be approved for a day or published until it is voiced.
  - Budgets are two numbers: a target (15p short, £1.20 episode) that is only
    journalled and shown, and a hard ceiling (50p short, £2 episode) that stops the run.
    FOUNDRY_*_TARGET_PENCE and FOUNDRY_*_BUDGET_PENCE move them.
  - Why the last attempt failed is kept on the run (`lastFailure`), not only in
    the in-memory job, so it survives a restart and shows on the page.
  - Who started each job is recorded and shown ("Working now" on the queue,
    the run page's banner), beside who has a run open.
  - The publishing page's Hold button never parked anything: it posted to
    /api/run/hold, the presence heartbeat's path, which answered first. Parking
    is now /api/run/park, and routes.test.ts fails on a duplicate path+method.
  - The run page: a single coloured Next step card (read / voice it / resume /
    publish / blocked), progress bars while working (overall, and the voice
    beat by beat with time left), a voice cost estimate per engine with a
    warning when it will not fit under the ceiling, and a right-hand column for
    cost (target and ceiling on one meter), listing, series and numbers. The
    channel page puts Make beside its Runs.

- **Named outros and each host's own voice tags** (2026-10-07). Every outro now
  says who is talking and on which channel ("This is Adrian on Business
  Decoded..."). Each host has a personality-matched tag set in voice-master.yaml
  that every writer is given (narrationTagsFor / tagGuidance) and that the
  unknown-tag strip keeps; the network-wide list stays the fallback.

- **ElevenLabs per run, and one master file for how every channel sounds**
  (2026-10-07). GPT voices were hoarse and dropped words, and could not carry a
  persona. Now:
  - The run page picks the engine at the point of spending: `GPT (default)` or
    `ElevenLabs`, stored on the run (`voiceEngine`). A run never mixes engines:
    switching deletes the other engine's beats. FOUNDRY_TTS still decides for
    the command line.
  - ElevenLabs is `eleven_v4`, not v3: v3 ignores previous_text/next_text, so
    every beat started cold. v4 has only stability and similarity; style and
    speed are no longer sent.
  - `voice-master.yaml` holds, per channel: the designed ElevenLabs voice (picked
    by ear from Voice Design auditions), the GPT voice and direction, a
    personality (added to the register, so every writer gets it), a delivery
    guide, tags it may and may never use, pronunciations, and outros. Strictly
    validated; the persona files no longer carry a voice or sign-off.
  - Outros are said WORD FOR WORD, appended as a `fixed` turn; writers are told
    not to say goodbye. Fixed turns are left out of style and self-similarity
    scoring, since a repeated chosen outro is not a tic.
  - Optional tag pass (ElevenLabs only): one Haiku call adds tags from the
    channel's list; a line whose words changed is discarded, deterministically.
  - GPT requests capped at 2,500 characters (was 6,000): long requests skipped
    words on a Mythic Archives episode.
  - Mythic Archives tells the story only. A live episode spent most of its
    opening and close on friars, libraries and collectors. The provenance canon
    is retired (until: 2026-10-07), the fusion no longer writes a "how the text
    survived" section, the beat sheets ask for a proper ending, and a free check
    flags manuscript talk. Rejected: keeping provenance "where it bites" - the
    owner heard it as filler every time.

- **A second research lane, for a story told rather than a subject assembled.**
  Formats declare `research: single | extensive`; a run overrides with
  `--research`. `myths-of-the-world` now defaults to a new `myth-story` sheet
  on the single lane, and `myth-told` is kept unchanged for a myth whose
  transmission genuinely is the story.
  On the single lane a selector picks the one to three documents that carry the
  whole story, they are read WHOLE at a hundred thousand characters each rather
  than through a six-thousand-character BM25 keyhole, and they are fused into
  one reference article the writer works from. No claim ledger, no per-fact
  verification, no counter-evidence, no grounding review. One check instead:
  `reviewReference` reads the article back against its own documents, and the
  gate fails closed if it did not run.
  The Descent of Inanna episode is why. It fetched 585,396 characters across
  fourteen documents, showed the extractor 13% of them, and drew six of its
  forty-one facts from the article that IS the story - behind a course handout,
  a general article about the underworld, and two biographies. A script
  assembled from eight documents' partial views of one myth wanders and
  contradicts itself, and a listener hears exactly that. The same keyhole lost
  the answer to the episode's own central question: the script says "The text
  does not explain guilty of what" over a source section headed "A guilty
  goddess", which sat at character 71,000 of a document the extractor saw 6,000
  of. `REFERENCE_CHARS_PER_SOURCE` is 100,000 for that reason and not as a
  round number.
  Re-run on the new lane, the same topic selected TWO documents: the ETCSL
  primary translation, which the old run failed to fetch at all, and the
  dedicated Wikipedia article. It passed over the Ereshkigal biography, the
  Dumuzid biography, Sumer, and a rare-books guide.

- **The reference decides where the sources disagree, and the episode says
  nothing about it.** Disagreements go in the reference's `variants`, which is
  written to the run and never shown to the writer. A person can audit every
  choice; a listener hears one story.
  On the old run, ONE contested claim out of forty-four produced roughly 200 of
  the 386 words in the payoff beat - fragment attribution, Akkadian
  transmission history, the dying-and-rising-god reading that fell apart - plus
  the last line of the episode. Three rules pushed it there and all three are
  off this lane. `findHedging` enforces it deterministically over the finished
  prose, and every pattern in it is a phrase from that episode.

- **A show can say goodbye.** `signoff` on the persona, and the new sheet's
  closing beat lands on it. The old sheet ended "No sign-off, no call to
  action, no naming the show, no next-time", written against episodes trailing
  off into filler, and it overshot: the Inanna episode's last sentence is an
  unresolved scholarly question followed by silence.

- **Explaining the world is no longer treated as an unsourced assertion.** The
  grounding review flagged "Sumer, in what is now southern Iraq", "cuneiform,
  wedge marks pressed into wet clay" and "Uruk, a city on the Euphrates" as
  facts no claim supported. All three are world knowledge doing the orienting
  this show's own canon says matters most, and with two revision passes a beat
  the writer learned that the safe way to explain something is to barely
  explain it. On the single lane the rule is split: events, names, numbers,
  motives and anything anybody said come from the reference; explanation of the
  world does not have to, and the reference carries a `glossary` written to be
  spoken at length rather than folded into a comma.

- **An episode costs about a quarter of what it did** (£3.55 to £0.95), from two
  changes and one deliberate refusal.
  The writer defaults to Sonnet rather than Opus. Writing is more than half an
  episode's cost and almost all of that is OUTPUT tokens - the script, which is
  the same length whichever model writes it - so the only real lever is price
  per token. Everything structural that makes this pipeline's prose good sits
  outside the model: the beat sheet, the deterministically scored style card,
  the per-beat critique loop, the hook competition. A weaker model in that
  scaffolding fails checks more often and gets rewritten more often, which costs
  calls rather than quality. `foundry compare` is there to test whether that
  reasoning survives contact with a real episode.
  Verification screens on a cheap model first and escalates. The screen can
  only ever CONFIRM a clean pass: anything it doubts, disputes or garbles is
  re-asked of the strong model, so it can never be the reason something wrong
  was published. Around four claims in five are clean, which removes most of
  the bill without touching the decision on any claim that is not.
  What was NOT done is grouping beats into one call, which is the obvious
  saving and the wrong one. The cost is output tokens and those do not shrink -
  the script is the same length either way. Grouping would save a little input
  and lose the per-beat critique and revision loop, which is one of the things
  actually keeping the prose from reading as generated.
- **Dead Reckoning** (`personas/dead-reckoning.yaml`,
  `beatsheets/reconstruction.yaml`), a third show: history mysteries
  reconstructed from surviving documents. Same evidence discipline as The
  Teardown, different spine - the Teardown's beats are the shape of an argument,
  these are the shape of a story, ending on a callback to the cold open rather
  than an outro. Its hosts are an archivist who has the documents and somebody
  who likes the popular version and wants it to be true, which makes it worth
  something when a document changes her mind.
- **Checkpoints inside a stage, a journal per run, and `make --dry-run`**
  (`src/run/store.ts`, `src/run/library.ts`). See Fixed below for what the first
  one was actually for. The journal is append-only JSONL written as the run
  goes, so `tail -f` works and a run that dies leaves a record ending where it
  died. `LIBRARY.md` is rebuilt from the run directories with every episode's
  cost, length and gate result, plus a count of which gate checks fail most -
  one failure is an episode, the same one six times is a style card asking to
  be changed.
- **A cheap drafting voice** (`src/render/openaiTts.ts`, `FOUNDRY_TTS=openai`).
  Around fifteen pence an episode against roughly two pounds, so iterating on
  the writing costs nothing - and the writing is what decides whether a show is
  any good. It has no dialogue endpoint and deliberately does not fake one:
  splicing turns while reporting the result as dialogue would hide the seam that
  is the whole reason to pay for the real engine at publish time.
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
  after every costed call. `npm run foundry -- make --show business-teardowns --topic
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
  YAML, validated by a Zod schema at load, with the first show `business-teardowns`
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

- **Night Shift's category did not exist.** It shipped as "Fiction", which is
  not one of the platform's fourteen; audio drama lives in Storytelling. The
  name is resolved to an id on the last call of the pipeline, so it would have
  run perfectly and failed after the research, the writing, the voicing and the
  gate had all been paid for. Categories are now checked at persona load - as a
  warning rather than a failure, because the local list is a copy and the live
  one is the authority.
- **A failure mid-stage threw away everything the stage had already paid for.**
  Runs were resumable between stages and worthless within one, and the expensive
  failures are all mid-stage because that is where the time is: a rate limit on
  beat eight of ten discarded twenty-one successful model calls. Beats and the
  hook competition now checkpoint individually, and synthesis skips any beat
  whose audio already exists.
- **Three silent breaks in the publish path**, in the one part of the repo that
  had never run against the real API. It sent a category NAME in a field that
  wants ids (and the API drops an id it does not recognise, so a wrong one
  publishes an episode that plays perfectly and is invisible to every genre
  rail); it omitted `content_rating`, which the API refuses rather than
  defaults; and it had no series route, so a serial's episodes could only land
  loose. All three land at the last command of a pipeline that has already spent
  money.
- **A two-host beat was rendered entirely in one voice** whenever the provider
  had no dialogue endpoint. Every turn was joined into a single request in the
  FIRST speaker's voice, so the show came out as one person reading both parts -
  silently, with no error and a perfectly valid file. Turns are now rendered
  individually and joined, and the run artifact says `turnwise` so a spliced
  take is never mistaken for a real exchange.
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
