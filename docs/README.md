# Design docs and decisions

Everything here is meant to be re-read before doing the thing it describes, not
written once and forgotten. If a document in this folder disagrees with the
code, the code is right and the document is a bug.

## Contents

| Document | What it is for |
|---|---|
| [PIPELINES.md](PIPELINES.md) | The lanes that exist, the shows asked for, what each actually costs to build, and the build order. Read before starting any new kind of show. |
| [DECISIONS.md](DECISIONS.md) | Load-bearing decisions and, more usefully, the ones that were reversed. Read before re-opening an argument. |

## The pipeline ledger

A visual version of PIPELINES.md, with each stage drawn at the width of what it
costs:

**https://claude.ai/code/artifact/9033d8ea-8c58-466c-9c7d-6b2e28138dc2**

Published 2026-09-13. It shows the cost split per lane, the render-engine
decision, and the four proposed shows with what is missing from each. Private
unless shared from the page's own share menu.

It is a snapshot, and the figures in it are only as current as the day it was
published. `npm run foundry -- make --show <id> --dry-run --topic "..."`
computes the real number from the live price table and the actual beat count,
and is the thing to trust when they disagree.

## Where other things live

Some records deliberately do not live here:

- **Why a specific line of code is the way it is** belongs in a comment beside
  that line. Most of this repo's reasoning is there, and it is the only place
  that cannot go stale unnoticed.
- **What the prompts currently say** is not written down anywhere, on purpose.
  `npm run foundry -- prompts` renders them from the live constants. A copy in
  a document is wrong within a week, and a wrong copy is worse than none
  because somebody reasons about it instead of what is being sent.
- **What has been made** is `LIBRARY.md`, rebuilt from the runs by
  `npm run foundry -- library`.
- **The platform side** of the studio is documented in the Audio-Vibe repo at
  `docs/AI_CONTENT_STUDIO_DESIGN.md`.
