# Commands

Every command the Foundry has, what it actually does, and what it costs.

Everything runs the same way:

```
npm run foundry -- <command> [options]
```

A run id is `<channel>/<folder>`, for example
`honest-health/e001-20260913-a-bad-nights-sleep-makes-you`. Anywhere a command
takes `--run`, you can paste just the folder name if it is unambiguous, and
leaving `--run` off entirely means the most recent run.

**What spends money**: `make`, `short`, `shorts`, and `tick`, which calls one of
them. `compare` makes one judging call, so it costs pennies. Everything else
reads what is already on disk and is free, including `gate`, which is why
re-gating an old run after changing a check costs nothing.

Last updated 2026-09-13.

---

## Making things

### `make --show <id> --topic "..."`

Writes, renders and gates one episode. This is the main command.

| Option | What it does |
|---|---|
| `--show <id>` | Which channel. Required. `shows` lists them. |
| `--topic "..."` | What it is about. Required. Be specific; the brief is written from this. |
| `--format <id>` | Which shape. Defaults to the show's first format. |
| `--dry-run` | Prints what it would do and roughly what it would cost, and spends nothing. |

It never publishes. It stops at the gate and tells you what to read.

Roughly 90p to 135p for a factual episode, about 40p for fiction. Research is
about half of it.

A fiction show skips research entirely and checks continuity against its series
bible instead. That is decided by the show, never by a flag.

```
npm run foundry -- make --show honest-health --topic "Why a bad night's sleep makes you forget things"
npm run foundry -- make --show myths-of-the-world --format ten-stories --topic "Vampire beliefs in the Balkans"
```

### `shorts --run <id> [--only 1,4,7]`

Cuts every story out of a **source script** into its own short, each with its own
title, audio, ledger and gate report.

Only works on a `sourceOnly` format (`ten-stories`). Those write ten
self-contained stories from one research pass and are never rendered or
published whole, which is the whole point: research gets paid for once and fans
out ten ways.

`--only` cuts just those stories, numbered from 1.

Resumable. Running it again reuses the runs, titles and audio it already made
rather than rendering duplicates beside them, so an interrupted cut only pays
for what is left.

About 4p a story.

### `short --run <id> [--format <id>]`

Derives one short from a finished **episode** that passed its gate. It picks the
strongest moment and writes new prose about it, because a minute out of the
middle of a fifteen-minute story starts in the wrong place and ends in the wrong
place.

Different from `shorts`. Use this when the episode is the product and the short
is promotion; use `shorts` when the shorts are the product.

Refuses a parent that has not been verified or did not pass, because a short
inherits the parent's checking along with its authority.

About 9p.

### `tick [--dry-run]`

Makes the next thing the schedule says is due, then stops. One item, not a
queue. `--dry-run` says what it would make without making it.

### `resume [--run <id>]`

Picks a dead run up where it stopped. Everything is checkpointed at the beat and
the audio file, not at the stage, so nothing already paid for is paid for twice.

Printed automatically whenever a run fails.

---

## Reading what happened

### `status [--run <id>]`

What a run has done, what it cost, and what is left.

### `script [--run <id>]`

Prints the script as prose, for reading before you listen. This is where to
judge the writing. The render can only tell you whether the audio matches the
script.

### `journal [--run <id>]`

Minute by minute, every stage, and where the money went.

### `gate [--run <id>]`

Re-runs the gate over an existing run without remaking anything. Free. Use it
after changing a check, to see whether an old run would still pass.

### `library`

Rebuilds `LIBRARY.md` and its JSON from every run on disk.

### `compare --a <run> --b <run>`

Judges two scripts against each other on which is better to listen to. For
deciding between two takes on the same topic.

The judging is done by the verifier model, never the writer, because a model
scores its own family's output higher by as much as tens of percent. One call,
so this costs pennies rather than nothing.

---

## Shows, voices and formats

### `shows`

Every channel and the formats it can make.

### `voices`

Which voice each channel speaks in, on which provider, and when it was
committed. A voice is fixed on first use and recorded in `voices.json`, which is
committed to the repo, because a channel changing voice is a different show as
far as a listener is concerned.

### `voice-retire --show <id> [--provider <name>]`

Releases a channel's voice so a new one can be committed. Deliberately its own
command and deliberately two steps, because this is not something to do by
accident.

### `series --show <id>`

What a fiction show has established so far: the cast, what is fixed about them,
what is still open, and the story to date.

### `series-setup --show <id>`

Creates the platform series a show publishes into. Run once per show per
environment. Not idempotent, which is why it is not automatic: a publish that
quietly created a series whenever the registry looked empty would fork the show
into two shelves.

### `prompts [--show <id>] [--only <id>] [--out <file>]`

Renders every prompt sent to a model, exactly as it is sent, from the live
constants. Not a document that describes the prompts, the prompts themselves.

Reading the assembled writer prompt for the first time found four faults that
had been going out on every beat of every episode.

---

## Publishing

### `due`

What the schedule says should be made now, and what is blocked and why.

### `publish --run <id> [--yes]`

Publishes a run that passed its gate. `--yes` is required for production, and
again if the gate asked for a human.

---

## What the gate output means

A gate failure is not a broken run. The script, the audio and the evidence are
all on disk; something in it needs fixing or a rule needs changing.

**Blocking** stops a publish. **Advisory** is a measurement worth knowing that
is not worth stopping for. **Needs a human** means nothing is wrong but somebody
has to look before it goes out.

Common blocking findings and what they actually mean:

| Finding | What happened |
|---|---|
| `ledger` | A claim and its quote disagree. The claim says more than the document does, cites a source that is not in the corpus, or is typed as something it is not. |
| `evidenceDensity` | A beat cited fewer facts than its format requires. Usually the writer wrote around the claims it was handed. |
| `riskTier` | The script asserts something the show is not cleared to assert, for example a claim about a named person on a show whose `allowedRiskTiers` does not include `named_person`. |
| `style:bannedPhrases` | A phrase on the show's banned list got through. |
| `selfSimilarity` | Too much distinctive vocabulary shared with another episode, or with the parent, for a short. |
| `duration` | The audio is too far from the format's target length. |

`gate --run <id>` re-runs all of it for free after a fix.

---

## Environment

Set in `.env`. Nothing here is read at import time, so a missing key fails at
the command that needs it rather than at startup.

**Needed to make anything**

| Variable | What for |
|---|---|
| `ANTHROPIC_API_KEY` | Writing, and the clerk. |
| `OPENAI_API_KEY` | Verification, screening, and TTS when `FOUNDRY_TTS=openai`. |
| `BRAVE_SEARCH_API_KEY` | Search. |

**Needed to publish**

| Variable | What for |
|---|---|
| `AUDIOVIBE_API_URL` | Which platform environment. |
| `AUDIOVIBE_INGEST_TOKEN` | The show's upload credential. |

**Optional**

| Variable | Default and effect |
|---|---|
| `FOUNDRY_TTS` | `elevenlabs` or `openai`. |
| `ELEVENLABS_API_KEY` | Required when `FOUNDRY_TTS=elevenlabs`. |
| `FOUNDRY_TTS_MODEL` | Overrides the voice model. |
| `FOUNDRY_WRITER_MODEL` | Overrides the writing model. |
| `FOUNDRY_VERIFIER_MODEL` | Overrides the verifying model. It must be a different family from the writer. |
| `FOUNDRY_SCREENER_MODEL` | Cheap first-pass verifier; unclear claims escalate to the real one. |
| `FOUNDRY_CLERK_MODEL` | The clerk. It may only do work something other than a model checks. |
| `FOUNDRY_EPISODE_BUDGET_PENCE` | Ceiling per run, default 500. A run that would exceed it stops. |
| `FOUNDRY_RUNS_DIR` | Where runs are written. |
| `FOUNDRY_VOICES_FILE` | Where the voice registry lives. Tests point this away from the committed one. |
| `FOUNDRY_BIBLES_DIR` | Where series bibles live. |
| `EXA_API_KEY`, `FIRECRAWL_API_KEY` | Better retrieval when present, plain fetch when not. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | When they are not on PATH. |

---

## Where things live

```
personas/     one file per channel: voice, taboos, subject, formats
beatsheets/   one file per format: the shape of an episode
runs/         <channel>/e001-<date>-<slug>/, shorts as e001-s01-...
docs/         PIPELINES, DECISIONS, and this file
voices.json   which voice each channel is committed to. Committed to the repo.
```

Every run directory holds its own brief, corpus, claims, verification, repair,
script, render, qa and publish artifacts as readable JSON, plus its audio. It
answers "where did that sentence come from" without needing anything else.
