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

**Building toward one publishable episode**, deliberately, rather than
scaffolding all nine stages first. One real episode end to end teaches more than
a complete framework that has never published anything, and if the first episode
is not good enough to publish under AudioVibe's own name then the design is
wrong and that is much cheaper to learn now.

See [CHANGELOG.md](CHANGELOG.md) for what exists today.

## Running it

```bash
npm install
cp .env.example .env     # then fill it in
npm run foundry -- --help
```

## Conventions

- TypeScript, CommonJS, `tsc` build. Matches `Audio-Vibe/services/api` so the
  two repos feel the same to work in.
- Tests live beside their source in `__tests__/`. The unit suite is hermetic:
  no network, no API keys, no ffmpeg.
- `npm run typecheck && npm run lint:ci && npm test` is the gate.
- Show bibles live in `personas/` and beat sheets in `beatsheets/`, as data
  rather than code, so changing a show does not mean a deploy.
- Generated episodes go to `runs/`, which is not committed.
