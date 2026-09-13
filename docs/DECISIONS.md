# Decisions

Decisions whose reasoning is not obvious from the code, and which somebody would
otherwise re-open and re-litigate. Each says what was decided, why, and what
would change it.

**The reversals are the valuable half.** Several of these were decided one way,
shipped, and turned out to be wrong in a way that cost real money or a real
episode. Those are recorded with what the mistake actually was, because the
reasoning that produced them was plausible and will be plausible again.

Last updated 2026-09-13.

---

## Architecture

### A myth show is on the factual lane, not the fiction one

A myth is not invented here. It was invented somewhere, by somebody, long ago,
and what survives is a text. "In the Kalevala, Väinämöinen sings his rival into
a swamp" is not a claim about the world; it is a claim about a book, and a
translation entails it exactly the way a sentencing remark entails a sentence.

On the fiction lane nothing would stop an **invented myth**. A model asked to
retell a lesser-known folk tale with no source to bind to produces something
plausible, culturally shaped and entirely made up, indistinguishable from the
real ones. For a show about other people's traditions that is not a quality
problem, it is the only thing that matters.

### Checks measure outcomes; prompts instruct intent

A style card measures sentence variance and does not tell the writer how to
produce it. The distinction decides where any new rule goes: measuring an
outcome leaves the writer free to reach it its own way, instructing a technique
does not, and a prompt full of technique produces prose that measures well and
sounds managed.

The exception is anything that constrains what may be **asserted**. That is the
job, and it is not relaxed.

### A deterministic check beats a prompt line wherever one is possible

A prompt line is a hope. Every fault found by listening had survived a
draft-critique-revise loop, because nothing in that loop was looking for it.
Where a fault can be counted, it gets counted.

### Prompts are a command, not a document

`npm run foundry -- prompts` renders every prompt from the live constants.
Rendering the assembled writer prompt for the first time found four faults that
had been sent on every beat of every episode and were invisible in any single
source file, including the instruction against repetition appearing twice.

### Shorts come from an anthology written to be cut, not from an episode

There are now two ways to get a short, and they are for different things.

**Derived** (`short`) takes a finished episode and writes new prose about one
moment in it. That is the only honest way to get a short out of a narrative
episode, because a minute from the middle of a fifteen-minute story starts in
the wrong place and ends in the wrong place. It costs a selection call, five
beats and a render, on top of an episode that already exists.

**Cut** (`shorts`) takes a source script whose ten beats were each written to be
heard alone, and turns each one into its own run. There is nothing to rewrite
and nothing to select; the beat *is* the short.

The case is entirely cost. Research is roughly half of an 87p episode, so ten
standalone shorts on one subject pay for it ten times over the same ground, at
about £5.80. One research pass fanned out into ten is about £1.50 — a source
script at £1.11, then a title and a render each.

**The long version is never published.** `sourceOnly` makes that mechanical
rather than a convention: `make` stops after the script, so nothing renders
twenty minutes of audio nobody will hear and nothing gates it as an episode it
is not trying to be. Ten mini-stories in twenty minutes is a list, which is
exactly the shape the narrative shows spent a week getting out of. Not
publishing it is the honest response, not a compromise.

**Every story is its own run**, gated and published separately, and that is not
bookkeeping. A short is what a listener actually meets; it needs a provenance
trail, a claim ledger and a gate report of its own, and each carries only the
sources it actually cites — a Sources sheet listing nine documents the audio
never mentions is worse than none, because it looks like evidence for something
it is not evidence for.

What would change it: if cut shorts turn out to under-perform derived ones on
retention badly enough to outweigh a 6x cost difference.

---

## Format and writing

### Long formats open by saying what the episode is. No cold open.

A teaser before the titles works on screen because the picture does the
orienting. Strip the picture out and forty seconds of an unexplained thing
happening to unnamed people in an unnamed place is forty seconds of a listener
guessing rather than listening, and then re-understanding it once the
orientation arrives.

**Side effect worth knowing:** `writeScript` only runs its hook competition when
the first beat is typed `cold_open`, so this switched it off. Sixteen opening
lines were being generated and judged per episode, for a beat that should not
exist. Shorts keep theirs; a short genuinely is hook-led.

### Length follows the material. There is no floor.

The under-length floor was raised to 0.85 of the minimum after an episode came
in short, and the very next episode was described as "forced to be long". That
is what a floor does once a beat has said everything its claims support: the
writer pads, and the cheapest padding is re-describing something it already
described.

A ceiling survives, because a beat half again over its slot is rambling.

### Say each thing once. The closing beat may make one callback.

Restating is saying a thing again so the listener does not miss it, which is
padding. A callback returns to something they already have so it means something
different now, which is what an ending is. Nothing mechanical separates them, so
the close gets a budget and no other beat gets one.

The budget is counted in **matched phrases, not callbacks**, because one
returned clause overlaps itself into two or three matches. Measured: 2 for a
callback, 22 for a recap.

### Explaining a word is not the same as placing it

An episode defined "hajduk" correctly and the listener still came away not
knowing what one was, because nothing was anchored to anything they already
knew. Places get put on a map they carry, dates get an anchor as well as a year,
and a war gets who fought whom over what rather than who was losing.

The test: from what has been said, could somebody sketch a rough map and a rough
timeline?

---

## Evidence

### A failing claim is repaired, not deleted

Narrow it to what its quote supports; failing that, rebind it to a source that
does support it; failing that, keep it marked unsettled with a hedge the script
must say out loud.

Deleting cost whole sections. One episode named six men and gave sentences for
two, because the claim carrying the other four said "Collins, Jones and Perkins
each got seven years" against a quote saying "three ringleaders each received
seven years". The seven years was solid.

**An unverified claim is not an unchecked one** — it has been through
extraction, the quote check, verification, narrowing and rebinding. What makes
it honest is that the permission and the obligation ship together: a beat using
one without telling the listener is rejected, and no more than a fifth of an
episode's claims may be unsettled.

### A contradicted claim is dropped outright

The hedge route is for what the record does not decide. That is the record
deciding against you, and hedging it would be a lie about a document that says
plainly otherwise.

### Narrowing must not drain the claim

Asked to remove what a quote does not support, a model will sometimes remove the
**specificity** instead of the over-reach. "Some of the men were sentenced" is
true, checkable, and worth nothing — and worse than the original failure,
because it passes.

---

## Rendering

### Judge the writing on the script, never on a drafted render

Three separate audio faults were live at once and none of them were the writing:
words dropped by the provider, prosody restarting at every beat join, and
performance tags read aloud. The draft engine will keep splicing; only the
publishing engine takes `previous_text`.

### Performance tags are stripped for any engine that would speak them

The provider declares whether it understands them, because it is the only thing
that knows. Absent means no: a provider that has not thought about it would read
them aloud, and that failure is loud and constant while stripping wrongly costs
one flat sentence.

---

## Reversals

Recorded because the reasoning that produced each was plausible.

### "Say things twice, differently"

Written because a listener cannot rewind. A model implements say-it-twice as
**say-it-wrong-then-correct-it** — "eleven years old. Not eleven months into a
criminal career. Eleven years old, full stop" — because that is the shape
restatement takes in written argument.

Softened once to "say it again with more", which was a half measure and was
rejected again. Removed entirely. An episode that repeats itself teaches a
listener that missing a sentence costs nothing, and then they stop holding on.

### "Least trailing silence wins" on a re-render

A truncation guard was added after proving the provider drops the tail of an
utterance intermittently, and it chose between takes on trailing silence.

**The rule was inverted.** A render that truncates and stops cleanly has almost
no trailing silence, so it preferred exactly the failure it existed to catch: it
picked the shortest of three takes and lost seven seconds of a beat. The
decision rule was generalised from a single sample that happened to point the
other way.

Now the choice is **speech duration** — both takes are the same text, so more
speech is more of that text, and there is nothing to weigh.

### A `counterpoint` beat in every evidence-bearing format

The duty is real: confident one-sidedness is the commonest way generated content
is false while every sentence is sourced. A dedicated beat was the wrong
instrument — it stopped the episode two thirds through to argue with itself and
then resumed.

The duty moved into the payoff: say where the accounts disagree **at the point
in the story where they disagree**. The format test now accepts either shape and
insists on one of them.

### "The render artifact means the audio exists"

Every other stage resumes from its JSON because the JSON *is* the output.
`render.json` only describes a file next to it. Deleting the media directory to
force a fresh take left a run reporting "reusing 553s of audio" and gating a
duration measured from a file that was not there.

---

## Open, and deliberately not decided

- **News: explainer or bulletin.** Decides whether it is a show or a second
  studio.
- **Health: is advice ever given.** "What the evidence says" and "what you should
  do" are different products with different exposure.
- **Serial: continuous story or anthology.** The bible design assumes continuity.
- **Single-pass script generation.** The per-beat critique loop catches something
  nearly every run; beat isolation caused the cast, context and seam problems.
  The trigger to switch: if an episode's faults are joins and continuity rather
  than sentence-level, single-pass wins.
