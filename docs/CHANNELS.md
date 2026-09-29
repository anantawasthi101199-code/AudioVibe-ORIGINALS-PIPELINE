# Channels, and what to run for each

The one page to open when the question is "I want to make something, what do I
type". Every show in the studio, which lane it uses, and the exact command.

Current as of 2026-09-29. If this disagrees with the code, the code is right.

---

## The six channels

| Show | What it is | Lane | Format | Length |
|---|---|---|---|---|
| `myths-of-the-world` | Myths, told properly | single-story | `myth-story` | 15 min |
| `myths-of-the-world` | The same, short | single-story, no fusion | `myth-short` | 3 min |
| `honest-health` | Health claims, weighed | extensive | `what-we-know` | 11-15 min |
| `business-teardowns` | Companies, taken apart | extensive | `case-study-teardown` | 15 min |
| `true-crime-in-full` | One case, whole | extensive | `told-story` | 15 min |
| `geopolitics-today` | Today's story on the beat | news desk | `news-short` | under 3 min |
| `night-shift` | The serial drama | fiction | `serial-reversal` | 8-12 min |

`read-the-file` was archived on 2026-09-29. It never produced a run and was
absent from the schedule. See `archive/README.md`.

---

## The four lanes

Each lane is a different answer to "where does this come from", and that is the
only thing that separates them. The script, critique, render and gate stages are
the same in all four.

```
  EXTENSIVE          many documents, claim ledger, quote binding
                     for a subject ASSEMBLED from sources
                     honest-health, business-teardowns, true-crime-in-full

  SINGLE-STORY       2-3 documents read WHOLE, fused into one article
                     for a subject that IS one story already
                     myths-of-the-world

  NEWS DESK          one article, today, from a wire sweep
                     geopolitics-today

  FICTION            no research at all; a season plan and a series bible
                     night-shift
```

---

## Commands, by what you want

### Make one episode

```bash
npm run foundry -- make --show myths-of-the-world --topic "Houyi shoots the ten suns"
npm run foundry -- make --show honest-health --topic "Do cold showers do anything"
npm run foundry -- make --show geopolitics-today                 # no topic: today's story
npm run foundry -- make --show night-shift                       # next episode of the serial
```

Add `--render-now` to skip the approval break, `--dry-run` to price it without
spending, `--music` to put a bed under the voice (off by default).

### Make a short

```bash
npm run foundry -- make --show myths-of-the-world --format myth-short --topic "..."
```

### Run a drama season

```bash
# 1. Break the season. About 14p. Writes the plan and STOPS.
npm run foundry -- season --show night-shift --episodes 8

# 2. Read it. Edit seasons/night-shift-s1.json by hand if you want to.
npm run foundry -- season --show night-shift --show-plan

# 3. Write episode one. It picks its own card from the plan.
npm run foundry -- make --show night-shift
```

Episodes are numbered from the bible, so step 3 repeated writes episode two,
then three. See [DRAMA.md](DRAMA.md).

### Let the schedule decide

```bash
npm run foundry -- due     # what it thinks should happen, costs nothing
npm run foundry -- tick    # make the next due thing, then stop
```

---

## Before you make anything

### Has it been done already

```bash
npm run foundry -- covered --show myths-of-the-world
```

`make` refuses a subject the show has already covered, names the earlier run,
and spends nothing. Pass `--again` if it really is different.

This does **not** apply to `night-shift` or `geopolitics-today`, and that is
deliberate: both reuse one topic string for every episode they make, so the
check would block their second episode forever. A serial is deduplicated by its
season plan and a news desk by its own already-reported test.

The ledger is `catalogue.json` and it is committed, because `runs/` is not, and
on a fresh clone the check would otherwise believe the studio had made nothing.

### What will it sound like

```bash
npm run foundry -- beat --list
npm run foundry -- beat --name calm-piano --style piano --key a --note "..."
npm run foundry -- make --show <id> --topic "..." --bed calm-piano
```

Styles are `piano`, `strings`, `epic`. Keys are `a` through `e`, all low,
because the bed sits under a speaking voice.

Without `--bed`, a phrase is synthesised from the topic string for **every part
separately** and thrown away, so a three-part episode builds the same phrase
three times and the show sounds different every week. A named beat is a channel
having a sound.

Recipes in `beds/*.json` are committed; the rendered `.mp3` beside each is not,
and rebuilds on demand.

---

## Roughly what things cost

| Thing | Cost |
|---|---|
| Short, single-story | **14.5p measured** |
| Episode, single-story, 15 min | **81p measured** |
| Episode, extensive, all checks off | ~90p |
| News report, under 3 min | ~20p |
| Season plan, 8 episodes | **14p measured** |
| Drama episode, 11 min | ~50p estimated |

Every paid check is off by default. Turning them all on adds about 171p to an
episode: `--reference-check`, `--script-revisions`, `--perform`, `--grounding`,
`--counter-evidence`, `--repair`, `--gaps`.

`--dry-run` computes the real figure from the live price table. When it
disagrees with this table, believe it.

---

## Starting a new channel

1. `personas/<id>.yaml` - the show. Thesis, audience, register, hosts with
   measured idiolects, style card, canon (beliefs, taboos, stylistic rules).
2. `beatsheets/<format>.yaml` - its shape, unless an existing one fits.
3. `topics/<id>.yaml` - the queue. A show with nothing queued reports as waiting
   rather than inventing a subject.
4. `schedule.yaml` - how often. A show absent from here never comes up as due.
5. `npm run foundry -- beat --name <id>-bed ...` - give it a sound.
6. For a news channel, `desks/<id>.yaml` as well. That file existing is what
   makes it one.
7. For a fiction channel, `fiction: true` on the persona and a season plan.

Then `npm run foundry -- shows` to confirm it loads and can be voiced.
