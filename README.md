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
| 5. Script | Fills beats in the show's voice, written for the ear |
| 6. Render | TTS per beat, sound design, mastering handoff |
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

`make` researches, writes, renders and gates. **It never publishes.** Publishing
is a separate command, run by a person who has read the gate report, because the
two checks the gate defers to a human are exactly the ones automation would wave
through.

Every stage is resumable. A failed gate does not mean re-rendering: fix what it
found and `npm run foundry -- resume`.

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
