# AudioVibe Foundry

The generation pipeline behind **AudioVibe Originals**: a small number of openly
labelled AI shows that research, write, voice and publish episodes onto
AudioVibe.

Design lives in the platform repo at `Audio-Vibe/docs/AI_CONTENT_STUDIO_DESIGN.md`.
This repo is the implementation.

---

## What this is for

Not volume. Volume is the failure mode, and the internet already has an infinite
supply of plausible AI audio.

The thesis is that **almost nobody is doing grounded AI content**: every factual
claim bound to a retrieved source, counter-evidence actively sought rather than
avoided, and the listener able to see the receipts. That is expensive by hand
and cheap by machine, which is exactly the shape of a good automation target.

**The studio competes on verifiability, not on output.**

## The one architectural rule

> The Foundry never writes to the platform database. It authenticates as the
> show's own creator account and calls the ordinary public API, exactly as a
> human creator would.

Because it uses the same door, transcoding, loudness mastering, preview
generation, fingerprinting, content safety, follower fan-out, cache
invalidation, feed ranking and the seen ledger are all identical by
construction. There is no second code path to keep in sync, and a change to the
platform's upload pipeline cannot silently break the studio.

## Where an episode comes from

Nine stages, each producing a persisted, versioned artifact so that any
published second of audio can be traced back to the script, the evidence and the
model versions that made it.

| Stage | Owns |
|---|---|
| 1. Canon | The show bible as data: voice, register, taboos, recurring segments |
| 2. Signals | What to make an episode about |
| 3. Evidence | Retrieval, claim-to-source binding, verification, counter-evidence |
| 4. Format | Beat sheets: structure as data, never prose |
| 5. Script | Fills beats as spoken turns, drafts then revises against deterministic critique |
| 6. Render | Dialogue endpoint per beat, so turn-taking is modelled rather than spliced |
| 7. QA | Separate judges: factuality, persona, safety, self-similarity |
| 8. Publish | Ingest into the platform as the show's creator account |
| 9. Loop | Beat-level retention feeding learned priors back into stage 4 |

## Status

**The pipeline runs end to end.** 224 tests. What it has not yet done is publish
a real episode, which needs two things a human has to supply:

1. A real voice for the show. `personas/the-teardown.yaml` ships
   `voiceId: REPLACE_BEFORE_FIRST_PUBLISH`. Pick one, set it, and then never
   change it.
2. The show's account on AudioVibe: a creator with `is_ai = true` and
   `studio_slug = 'originals'`, plus an ingest credential minted on the platform
   side with `mintIngestToken.ts`.

See [CHANGELOG.md](CHANGELOG.md) for the decisions behind each stage.

## Running it

```bash
npm install
cp .env.example .env     # then fill it in

npm run foundry -- shows
npm run foundry -- make --show the-teardown --topic "what the episode is about"
npm run foundry -- script          # read it before anything else
npm run foundry -- publish --run <id>
```

Once an episode has passed, cut a short out of it:

```bash
npm run foundry -- short --run <id>
```

A short is **derived**, never researched independently. A standalone one would
need its own brief, search, corpus, extraction, verification and counter-evidence
pass to produce seventy-five seconds of audio - about a pound ten against twelve
pence. It inherits the parent's verified facts and spends one call deciding which
of them to tell.

It is also not a trailer. It has to be worth hearing by somebody who will never
play the long one, so it asks for the strongest self-contained moment rather than
the most representative one. And it may carry no contested claim at all:
seventy-five seconds cannot hold a steelmanned counterpoint, and cramming one in
produces a strawman, which is worse than none because it looks like fairness.

```bash
npm run foundry -- compare --a <run> --b <run>   # is it getting better?
npm run foundry -- series --show night-shift     # what a serial has established
```

## Running it on a cadence

```bash
npm run foundry -- due              # what should be made now. Costs nothing.
npm run foundry -- tick --dry-run   # the same, from the command that would act
npm run foundry -- tick             # make the next due thing, then stop
```

`schedule.yaml` says how often each show publishes. `topics/<show>.yaml` says
what it covers next, in order, taken from the top - that file is the editorial
surface of the whole studio, and it is deliberately a list a person writes.
Generating topics automatically was considered and rejected: a studio that picks
its own subjects converges on whatever the model finds most available, which is
the same handful of stories everyone else is already telling.

**What is due is computed from what was actually published**, never from a
timer's own memory. That is the difference between this and cron, and it is not
cosmetic: a show that missed last week is due NOW, where cron would silently
skip whenever the machine was off, a run failed, or a gate rejected an episode.
So the trigger is stateless and cannot drift. Point anything at `tick` - cron,
Task Scheduler, a CI timer - as often as you like. Firing twice in an hour
produces the same plan twice and the second finds the work done.

`tick` makes **one** thing and stops, so a studio three weeks behind catches up
at the rate its trigger fires rather than spending fifteen pounds in one go
before anybody sees the first result.

**It still stops at the gate.** A show can set `autoPublish: true`, and that
option exists because refusing it entirely just means somebody writes a worse
version in a shell script - but it is off per show until somebody decides
otherwise, and even then an episode the gate flagged for human review waits.

`make` researches, writes, renders and gates. **It never publishes.** Publishing
is a separate command, run by a person who has read the gate report, because the
two checks the gate defers to a human are exactly the ones automation would wave
through.

Every stage is resumable. A failed gate does not mean re-rendering: fix what it
found and `npm run foundry -- resume`.

## Drafting cheaply

```bash
FOUNDRY_TTS=openai npm run foundry -- make --show the-teardown --topic "..."
```

About fifteen pence an episode against roughly two pounds, so iterating costs
nothing. Use it while you are still finding out whether a show works, because
what you are judging at that stage is the WRITING, and that is audible through
any competent voice.

What it cannot tell you is whether the show sounds like two people. OpenAI has
no dialogue endpoint, so an exchange is rendered a turn at a time and joined -
and joined turns have a uniform prosody and a clean gap exactly where a real
person would have come in early or trailed off. That gap is the single most
reliable tell of generated audio, and no voice quality hides it.

So draft here and publish on ElevenLabs, which renders the whole exchange in one
request. Every run records which engine produced every take, so an episode
drafted cheaply and re-rendered later is traceable rather than mystery audio.

Each host holds two voice ids: `voiceId` for the real engine and `draftVoiceId`
for this one. Both live in the persona rather than one being edited back and
forth, because editing it back and forth is a thing somebody eventually forgets
to undo.

## Two kinds of show

**Factual shows** answer to documents. Nothing is said that cannot be bound to a
verbatim quote in something that was actually fetched.

**Fiction shows** answer to a series bible. There is no document that entails a
conversation nobody had, so the evidence pipeline is skipped entirely and
replaced with continuity: an episode may not contradict what earlier episodes
established. Same discipline - the prose is answerable to something outside
itself - pointed at a different ground truth. Same deterministic-then-model
shape, same different-model-family checker, and `unclear` blocks for the same
reason `partially_entailed` does.

This is a property of the **show**, set once in its persona file. There is no
command-line switch that turns fact-checking off, and there should never be one:
a show that reconstructs filings one week and invents a story the next has
destroyed the only thing the evidence pipeline was buying it.

The disclosure is identical either way. "It is obviously a story" is not a
disclosure.

## What makes it sound like people

A show is a **cast**, not a voice. Narrated prose read by one synthetic voice is
the most AI-sounding format available, because polished monologue is exactly
what text-to-speech has always produced.

But two voices are not enough on their own, and this is the part every AI
podcast gets wrong: the hosts have to **want different things**. One has read
the documents; the other has not, and presses. That gives the conversation a
reason to exist. Disfluency and interruption are the surface of that, not the
cause, and sprinkling hesitation onto agreement does not work.

Structural checks enforce it. A beat where one host holds more than 72 percent
of the words is a monologue with interruptions; a beat where only one host
speaks is not an exchange. Both are what a writer produces by default, because
both are easier.

Rendering goes through the provider's dialogue endpoint, one request per beat,
so overlap and turn-taking are modelled rather than spliced together from
separate renders.

## What makes it true

Sources exist only by being fetched, so a citation cannot be invented. Quotes
are checked for EXISTENCE in the document before any model is asked what they
mean. Contested claims get an active search for evidence against them. The
verifier sees only a claim and a quote, from a different model family than the
writer, and "supports it more weakly than stated" blocks.

## Cost

The budget ceiling is `FOUNDRY_EPISODE_BUDGET_PENCE`, checked after every costed
call. A run that would exceed it stops rather than degrading, because a cost
overrun should be visible as silence, which somebody notices, rather than as
quietly worse output, which nobody does.

## Conventions

- TypeScript, CommonJS, `tsc` build. Matches `Audio-Vibe/services/api` so the
  two repos feel the same to work in.
- Tests live beside their source in `__tests__/`. The unit suite is hermetic:
  no network, no API keys, no ffmpeg.
- `npm run typecheck && npm run lint:ci && npm test` is the gate.
- Show bibles live in `personas/` and beat sheets in `beatsheets/`, as data
  rather than code, so changing a show does not mean a deploy.
- Generated episodes go to `runs/`, which is not committed.
