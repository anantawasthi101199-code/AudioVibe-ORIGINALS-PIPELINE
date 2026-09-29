# The drama lane

How a serial gets made: a season planned once, then episodes written one at a
time against it. Current as of 2026-09-29.

Written for [FLOW.md](FLOW.md)'s reader. That file covers the factual lanes, and
this one covers the only lane where a listener comes back for the *next* one
rather than for the topic.

If this file disagrees with the code, the code is right and this is a bug.

---

## The shape

```
  PREMISE (optional steer, one line)
     |
  [paid ~14p]  BREAK THE SEASON              once per season
     |   cast, world, spine, promises, N episode cards
     |   each card: opens / story / changes /
     |   cliffhanger / plants / pays off
     |
  [free] CHECK THE PLAN                      arithmetic, no model
     |   every promise planted and paid, paid AFTER planted,
     |   cliffhanger on all but the finale, hosts in the cast,
     |   cast within what an ear can carry
     |
  >>>>>>  YOU READ IT AND APPROVE  <<<<<<
     |   a bad season dies here for 14p instead of GBP 4
     |
  +--- for each episode 1..N -----------------------------+
  |                                                       |
  |  [free]  BRIEF        wired: runFiction reads the plan |
  |    this card + THE NEXT CARD + cast + story so far    |
  |    + threads the listener is still holding            |
  |                                                       |
  |  [paid]  WRITE       the existing fiction writer      |
  |  [free]  CRITIQUE    style, hooks, loops, voices      |
  |  [paid]  CONTINUITY  against the bible, not the plan  |
  |  [paid]  RENDER                                       |
  |  [free]  BIBLE UPDATE + PLAN DRIFT                    |
  +-------------------------------------------------------+
```

---

## The one decision everything else follows from

**Neither write-the-whole-thing-then-split, nor episode-by-episode-from-a-summary.**

Generating sixty minutes of continuous story and cutting it at the tense moments
fails because **a cliffhanger is not a place you stop, it is a thing you build
toward.** The minutes before it exist to make it land. Cut continuous prose and
the break falls where the scissors fell rather than where it was earned, episode
four opens mid-paragraph with no hook of its own, and fixing episode six means
regenerating all sixty minutes.

Writing each episode from a summary of the last fails the other way. By episode
five you are working from a summary of a summary, and **the drift is invisible**
because every individual step looks reasonable. Worse, with no destination there
is no foreshadowing at all: forward-only writing cannot plant.

So the season is broken first and the episodes are written against it. This is
what a writers' room calls breaking the season, and it is independently what the
research landed on. Both Dramatron and Re3 found flat sequential generation
loses the plot, and both fixed it with hierarchy rather than with a bigger call.

---

## Plan and bible are different things, on purpose

| | [`season.ts`](../src/fiction/season.ts) | [`bible.ts`](../src/fiction/bible.ts) |
|---|---|---|
| holds | **intention** | **history** |
| answers | what the season means to do | what a listener has already heard |
| when they disagree | it loses | it wins |
| enforced by | nothing, it is advisory | the continuity check, which blocks |

`bible.ts` refuses to hold plot in its own header, and it is right to: *"storing
intentions here would make the continuity check enforce an outline, and an
outline is a thing a writer should be allowed to abandon."* An episode that came
out better than its card is a good outcome. `planDrift` reports the divergence
and never blocks on it.

---

## Promises

The load-bearing idea. A promise is something the season makes the listener
wonder, written as the question they hold rather than as a plot label. Every one
is **planted in one episode and paid off in a later one**, by id.

That turns the vaguest thing about serial writing into arithmetic:

- a promise planted and never paid is a **detectable bug**, found for free,
  before any prose exists
- a promise paid in the episode that plants it is a scene, not a thread
- a promise paid before it is planted is a plan that got shuffled

No model is needed for any of it, and nothing else in the studio can see it: a
season can owe its listener four answers while every individual episode passes
every check it has.

Three to six per season. Fewer and it is a set of episodes; more and the finale
becomes a list of answers.

---

## What the writer is shown, and what it is not

Shown: this episode's card, the cast, the story so far, the threads still open,
and **the next episode's opening line.**

That last one is the whole difference between a cliffhanger aimed at and a
cliffhanger arrived at. A writer who knows where the following episode picks up
can end this one so that it is *necessary*; a writer who does not can only stop
somewhere tense.

**Withheld: every card after the next one.** A writer shown the whole season
writes towards the finale from episode two, and the planting stops being
planting and becomes announcing.

---

## Rules that come from this being heard

Most story-planning advice assumes a screen. The failures that causes are not
stylistic, they are comprehension failures, and a listener who has lost the
scene does not get it back.

- **Five carry names for a whole season**, three speakers in a scene, four at the
  absolute ceiling. Voice is the only thing distinguishing characters.
- **No two carry names that rhyme, alliterate, or share a first syllable.** Dana
  and Diana are distinct on a page and one person in the ear.
- **Nothing turns on a detail the listener has to see.** No note read silently,
  no lookalikes, nobody recognising somebody across a room without saying so.
- **Plant twice, in different ways.** A twist resting on one word in episode two
  will not land.
- **Time and place changes have to be speakable.** A card needing four locations
  produces an episode that spends its length announcing where it is.

The first two are enforced in `checkPlan`. The rest are in the planner prompt.

---

## Night Shift narrates in the first person

The show's persona carries a taboo: *"No omniscient narrator. Everything the
listener learns, they learn because somebody says it or does it."*

A first-person narrator does not break it. If Ruth tells it from somewhere
later, everything the listener learns still comes from somebody, and the show
gains the one thing a narrator is genuinely needed for in audio: moving a week
forward in a sentence. It also suits her. A woman who says less than she knows
makes a good narrator, because the gap between what she tells you and what she
knew at the time is the series.

---

## Commands

```bash
# Break a season. Writes the plan and stops.
npm run foundry -- season --show night-shift --episodes 8

# With a steer
    ... --premise "the ward loses its overnight consultant"

# Read a plan back
npm run foundry -- season --show night-shift --show-plan

# Replace one (refuses without this, so episodes are never orphaned)
    ... --force

# Then write episode one
npm run foundry -- make --show night-shift

# What the series has established, as opposed to what it planned
npm run foundry -- series --show night-shift
```

The plan is a JSON file in `seasons/`. **Editing it by hand is expected**, not a
workaround. It is the cheapest place in the studio to change your mind, and the
free checks run over whatever is in the file rather than over what a model
produced.

---

## Costs

| Stage | Cost |
|---|---:|
| Break the season, 8 episodes | **14.0p measured** |
| Check the plan | free |
| Per episode, script | ~35p estimated |
| Per episode, render at 11 min on the OpenAI voice | ~12p |
| **8-episode season, all in** | **about GBP 4** |

> On ElevenLabs the render alone is about 200p an episode and a season is nearer
> **GBP 20**. Unlike the myth shorts this is not obviously the wrong call, since
> drama is the one format where the voice acting is the product.

The ratio is the argument for the design. A plan is a tenth of one written
episode, so the approval stop costs almost nothing and saves everything.

---

## Files

| Path | What it is |
|---|---|
| `src/fiction/season.ts` | The plan: schema, free checks, the writer's brief, drift, and `locateEpisode`. No model import, so the checks are tested hermetically. |
| `src/fiction/planner.ts` | The one paid call. Season shape, cliffhanger rules, ear rules. |
| `src/fiction/bible.ts` | History. What the series has established. |
| `src/fiction/continuity.ts` | The check that blocks, against the bible. |
| `src/pipeline/fiction.ts` | The episode pipeline. |
| `beatsheets/serial-reversal.yaml` | The episode shape. Ends on a reversal. |
| `beatsheets/serial-episode.yaml` | The weaker fallback, for genuinely connective episodes. |
| `personas/night-shift.yaml` | The show. |
| `seasons/<show>-s<n>.json` | The plans themselves. |

---

## Which episode is which

The bible counts every episode a show has published; a season counts from one.
`locateEpisode` walks the seasons in order and subtracts, so overall episode six
of an eight-episode first season is season one episode six, and overall episode
nine is season two episode one.

**A gap is the end.** A show with seasons one and three planned has not planned
season two, and guessing which card episode nine wants is exactly the guess this
module exists to prevent. It returns null, and the run says so and writes from
the bible alone rather than inventing a card.

## Not built yet

- **No re-planning.** When an episode diverges from its card, later cards go
  stale and `planDrift` only reports it. Paying a model to rewrite the remaining
  cards is a later upgrade, deliberately not a v1.
- **No dramatised-true lane.** A show that invents dialogue for real people one
  week and reconstructs filings the next has spent what the evidence ledger was
  buying it. If it gets built it is a third lane with its own rules, not a flag
  on this one.
