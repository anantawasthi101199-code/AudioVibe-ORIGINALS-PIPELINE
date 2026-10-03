# Archive

Nothing in here is loaded by anything. The loaders read `personas/`,
`beatsheets/`, `topics/` and `desks/`, and this folder is deliberately not one
of them.

**It is kept rather than deleted because every file here is designed work.** A
persona is a register, a style card, a set of taboos and a cast, argued out over
a long time. Deleting one to make a directory listing shorter trades something
expensive for something free. Moving it here says the same thing a deletion
would, which is "this is not part of the working set", without throwing it away.

To bring one back, move it into the folder it came from. Nothing else is needed.

---

## What is here and why

### `personas/read-the-file.yaml` and `beatsheets/the-paperwork.yaml`

A show about reading primary documents. It has never produced a run and it is
absent from `schedule.yaml`, so nothing has ever asked for it. The beat sheet
comes with it because `read-the-file` was the only persona that listed it, and a
format no show can reach is a format that cannot be tested.

### `beatsheets/reconstruction.yaml`

A history-mystery format, referenced by no persona at all. It was written for a
third show that was never built, which `CHANGELOG.md` still records.

### `topics/read-the-file.yaml`

The queue for the show above.

### `topics/night-shift.yaml`

**This one was never read by any code path, not even before it was archived**,
and that is worth knowing rather than assuming.

`takeTopic` is only called for a show where `persona.fiction` is false. A
fiction show passes its own thesis as the topic instead, so every premise in
this file sat unused from the day it was written. Nothing failed, nothing warned,
and the file looked exactly as load-bearing as every other file in `topics/`.

It is also now superseded. `seasons/` owns what a serial does next, in order,
with the promises each episode plants and pays off, which is the job this file
was reaching for. See `docs/DRAMA.md`.

The premises in it are still good, and they are still usable:

```bash
npm run foundry -- season --show night-shift --premise "a drug count comes up short"
```

### `personas/business-teardowns.yaml`, `personas/night-shift.yaml`, their topics and season

Archived on 2026-10-03: production carries exactly seven channels, and these two
were not among them. They are still the only shows on the extensive-research and
fiction lanes, so `src/pipeline/__tests__/{episode,short,fiction}.test.ts` point
`FOUNDRY_PERSONAS_DIR` here and keep using them as fixtures.
