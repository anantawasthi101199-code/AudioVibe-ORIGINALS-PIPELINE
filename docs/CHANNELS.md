# Channels, and what to run for each

The one page to open when the question is "I want to make something, what do I
type". Every show in the studio, which lane it uses, and the exact command.

Current as of 2026-09-29. If this disagrees with the code, the code is right.

---

## The six channels

| Show | What it is | Lane | Format | Length |
|---|---|---|---|---|
| `mythic-archives` | Myths, told properly | single-story | `myth-story` | 15 min |
| `mythic-archives` | The same, short | single-story, no fusion | `myth-short` | 3 min |
| `root-health` | Health claims, weighed | extensive | `what-we-know` | 11-15 min |
| `business-teardowns` | Companies, taken apart | extensive | `case-study-teardown` | 15 min |
| `crime-files` | One case, whole | casefile | `case-in-full` | 13-17 min |
| `crime-files` | The same, short | casefile | `case-short` | 3 min |
| `global-thread` | Today's story on the beat | news desk | `news-short` | under 3 min |
| `night-shift` | The serial drama | fiction | `serial-reversal` | 8-12 min |

### What listeners see

Set from the owner's channel sheet on 2026-10-02, before launch, so every
channel starts fresh under these ids. Do not rename an id once a channel has
published: it is stamped into every episode's provenance as `persona_ref`.

| Id | Public name | Handle |
|---|---|---|
| `business-decoded` | Business Decoded | @businessdecoded |
| `eureka-tales` | Eureka Tales | @eurekatales |
| `global-thread` | The Global Thread | @globalthread |
| `root-health` | The Root Health | @roothealth |
| `crime-files` | The Crime Files | @crimefiles |
| `mythic-archives` | Mythic Archives | @mythicarchives |
| `psyche-session` | Psyche Session | @psychesession |

`read-the-file` was archived on 2026-09-29. It never produced a run and was
absent from the schedule. See `archive/README.md`.

---

## The launch seven, per the owner's channel sheet

Set up on 2026-10-03. Music: shorts get a bed where marked, long form never;
`--music` / `--no-music` overrides any run. Long episodes take
`--series "Title"`: the episode opens by naming it and publishes onto that
series' shelf, created the first time the title is used.

| Channel | Short | Long | Music on shorts | Voice |
|---|---|---|---|---|
| Business Decoded | `biz-short` | `biz-episode` + `--series` (Founder Stories, Startup School, Innovative Businesses) | yes | Arjun, echo |
| Eureka Tales | `science-short` (mystery, then the story) | `told-story` + `--series` | yes | Kabir, ash |
| The Global Thread | `news-short` (what happened, why it matters to you, what next) | none | yes, subtle (desk) | Rowan, nova |
| The Root Health | `health-short` (hook, story, myth verdict or attributed guidance) | later: `what-we-know` + `--series` | yes | Sena, sage |
| The Crime Files | none | `case-in-full` (hook, context, investigation, turning point, aftermath) + `--series "<the case>"` | n/a | Cal, ballad (ElevenLabs before publishing) |
| Mythic Archives | `myth-short` | `myth-story` + `--series` | no | Wren, onyx, slow and heavy |
| Psyche Session | `psych-short` | `psych-episode` + `--series` | no | Noor, shimmer |

```bash
npm run foundry -- make --show business-decoded --format biz-short --topic "..."
npm run foundry -- make --show business-decoded --format biz-episode --series "Founder Stories" --topic "..."
npm run foundry -- make --show crime-files --series "The Missing Hour" --topic "..."
```

A titled series takes a supplied 16:9 cover from
`art/<channel>/series-<slug>.supplied.png` (slug: the title lowercased, words
joined by hyphens); without one it is drawn.

## The four lanes

Each lane is a different answer to "where does this come from", and that is the
only thing that separates them. The script, critique, render and gate stages are
the same in all four.

```
  EXTENSIVE          many documents, claim ledger, quote binding
                     for a subject ASSEMBLED from sources
                     root-health, business-teardowns

  SINGLE-STORY       2-3 documents read WHOLE, fused into one article
                     for a subject that IS one story already
                     mythic-archives

  CASEFILE           ONE document read whole, into a dated case file
                     for something that HAPPENED, to real people
                     crime-files

  NEWS DESK          one article, today, from a wire sweep
                     global-thread

  FICTION            no research at all; a season plan and a series bible
                     night-shift
```

### Why true crime has its own lane

A case is not a myth and not a subject. It differs in two ways that change the
pipeline rather than the prompt.

**It has a calendar, not an order.** The difference between "later" and "eleven
days later" is most of what makes a case frightening, so the chronology is built
before a word of script exists and the writer never reconstructs a sequence from
prose.

**Its people are real.** Every event is marked `established`, `alleged` or
`disputed`, and the writer is shown all of it. That reverses the myth lane,
where disagreements are resolved and *hidden* from the writer because one
contested claim once ate half an episode in hedging. Here presenting a disputed
claim as settled is not a style fault, so the rule inverts: say it once,
attributed, where it belongs, and stop qualifying everything else.

The case file also carries a background for every carried name (the victim's
first), places holding only the one physical detail the reporting actually
recorded, and a list of what the record does not say. Free checks refuse a file
with no victim, a victim with no background, fewer than three dated events, or a
name that acts in the chronology and was never introduced.

**One source is a real limit.** One document carries its own errors and framing
straight through and nothing in the pipeline can see that. This lane is for
cases reported properly once and long settled, not for anything recent or
genuinely contested. Turn `--reference-check` on: it reads the case file back
against its own document with a different model family, and it is the only
evidence check this lane has.

---

## Commands, by what you want

### Make one episode

```bash
npm run foundry -- make --show mythic-archives --topic "Houyi shoots the ten suns"
npm run foundry -- make --show root-health --topic "Do cold showers do anything"
npm run foundry -- make --show global-thread                 # no topic: today's story
npm run foundry -- make --show night-shift                       # next episode of the serial

# true crime, with the one check this lane really wants
npm run foundry -- make --show crime-files --topic "..." --reference-check
```

Add `--render-now` to skip the approval break, `--dry-run` to price it without
spending, `--music` to put a bed under the voice (off by default).

### Make a short

```bash
npm run foundry -- make --show mythic-archives --format myth-short --topic "..."
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
npm run foundry -- covered --show mythic-archives
```

`make` refuses a subject the show has already covered, names the earlier run,
and spends nothing. Pass `--again` if it really is different.

This does **not** apply to `night-shift` or `global-thread`, and that is
deliberate: both reuse one topic string for every episode they make, so the
check would block their second episode forever. A serial is deduplicated by its
season plan and a news desk by its own already-reported test.

The ledger is `catalogue.json` and it is committed, because `runs/` is not, and
on a fresh clone the check would otherwise believe the studio had made nothing.

### What will it sound like

```bash
npm run foundry -- beat --list        # what exists
npm run foundry -- beat --controls    # every knob, its range, what it does

# from a description: a cheap model fills in all 24 settings (~0.3p)
npm run foundry -- beat --name ward --describe "tired, three in the morning"

# by hand, or on top of a description, or on top of an existing beat
npm run foundry -- beat --name ward --voices pad,bass --mode phrygian --brightness 900

npm run foundry -- make --show <id> --topic "..." --bed ward
```

In the studio, the **Beats** tab does the same thing with sliders and a player
for each one.

**Twenty-four controls, in five groups.** What plays (instruments, key, mode,
chords), time (tempo, bars, density, swing), shape (attack, decay, brightness,
resonance, detune, harmonics), movement (rate, depth, vibrato) and space and
character (room, echo, warmth, air, level). `beat --controls` prints all of them
with their ranges, because a copy in a document would be wrong within a week.

**A description is a starting point, not the author.** It fills the form in and
stops, so you can see all 24 values, change any of them, and only then make the
sound. Nothing needs the model: every control has a default and the form works
with the box empty.

**Every beat is normalised to -20 LUFS.** Measured across the parameter range
the raw output spanned 29 dB, so a dark sparse setting would have been inaudible
under speech while a dense bright one fought it, at the same `BED_GAIN`.
Swapping one beat for another now changes the sound and not the level.

Without `--bed`, a phrase is synthesised from the topic string for **every part
separately** and thrown away, so a three-part episode builds the same phrase
three times and the show sounds different every week. A named beat is a channel
having a sound.

Recipes in `beds/*.json` are committed and are under a kilobyte. The rendered
`.mp3` beside each is not, and rebuilds on demand, because synthesis is
deterministic.

---

## Roughly what things cost

| Thing | Cost |
|---|---|
| Short, single-story | **14.5p measured** |
| Short, true crime | **8.5p measured** |
| Episode, true crime, 15 min | **35p measured** |
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
