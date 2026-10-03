# Decisions

Decisions whose reasoning is not obvious from the code, and which somebody would
otherwise re-open and re-litigate. Each says what was decided, why, and what
would change it.

**The reversals are the valuable half.** Several of these were decided one way,
shipped, and turned out to be wrong in a way that cost real money or a real
episode. Those are recorded with what the mistake actually was, because the
reasoning that produced them was plausible and will be plausible again.

Last updated 2026-09-27.

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
about £5.80. One research pass fanned out into ten is about £1.50 - a source
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
sources it actually cites - a Sources sheet listing nine documents the audio
never mentions is worse than none, because it looks like evidence for something
it is not evidence for.

What would change it: if cut shorts turn out to under-perform derived ones on
retention badly enough to outweigh a 6x cost difference.

### Claim floors are not claim ceilings

A health episode fetched 1.1 million characters of PubMed Central primary
literature and was allowed to take thirty-five facts out of it, because
extraction was told "no more than `minClaims + 2`" per beat. It took
twenty-nine, then had to fill eleven and a half minutes with them: **one fact
every twenty-eight seconds**. What filled the other twenty-seven was
restatement, and a listener heard an episode working hard to be interesting
because it did not have enough to say.

The floor answers "is this beat sourced at all". How much there is to say is a
question about TIME, so the ceiling is now one claim per twelve seconds of beat,
or the floor plus two, whichever is larger. The writer is given more than fits
and chooses. Choosing the best four of twenty is a different job from stretching
four across four minutes, and it sounds different.

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

### Never pair a fact with what it is not

"Real scientific claims, not folklore." "A large physical change, not a small
drift in a number." "In front of a scanner rather than a microscope."
**Twenty-four of ninety-one sentences** in an episode a listener otherwise
liked, one every four. They named it: "it was X, not Y, not Z - I don't like
this kind of talking, just continue with facts."

Every earlier negation check looked for a denial at the START of a clause. This
one trails, so none of them caught a single instance.

Why it is worse out loud than on a page: a reader whose eye lands on "not
folklore" can glance back at "real scientific claims" for free. A listener
cannot, so the negated half arrives as new information, is held, and is then
discarded once the sentence resolves. The only product of that work is a thing
that was never true.

**A negative FACT is a different thing and survives.** "Nobody has run that
study", "the record does not say who", "it has never been measured in a person"
are findings, and the absence is the point. A show whose whole claim is that it
says how well something is known has to be able to say that. The ban is on the
contrast, never on the word.

### A show owns the sentence its voice is spoken with

The delivery direction sent to the engine was derived from two ElevenLabs
numbers, `stability` and `style`, mapped onto three phrases each. Every show in
the studio therefore opened with the same line: *"Speak as one half of a
two-person conversation that is already underway."*

That is right for a two-hander and wrong for one person explaining their field.
A listener heard it on the health show immediately: the voice "talks like it's
talking about a mystery, not like how a doctor or an advisor speaks". The
numbers still set steadiness and colour; `direction` says who is talking, and it
is the line that decides whether a listener trusts what they hear. `speed` moved
out of provider settings for the same reason: pace is a property of a show, not
of an engine.

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

**REVERSED.** It is now dropped, unless the corpus already holds a passage that
supports it as written.

Narrowing rewrote a failing claim down to what its quote strictly supported, and
over one ten-story set it did this twenty-nine times:

| was | became |
|---|---|
| **Airavata** was a four-tusked white elephant which became Indra's mount | A four-tusked white elephant became Indra's mount |
| Shiva's throat turned blue **after consuming the poison** | Shiva's throat turned blue **and** from then onwards |
| **Kamadhenu**, one of the treasures that emerged from the churning | **Surabhi** is a cow claimed by the sages for Vedic sacrifices |

A lost name, a lost cause, and a different claim. One was a pure reword with no
information change at all, at a model call each.

The reason narrowing existed was scarcity: an episode once named six men and
gave sentences for two, because dropping the claim took the fact with it. That
scarcity is gone - the claim ceiling is fifteen a story and the corpus is three
documents a story - and dropping every failure on a real set still left 67
claims across ten stories.

**Rebinding survives**, because it mangles nothing: it looks for a passage
elsewhere in the corpus that supports the claim AS WRITTEN and changes only
which document it points at. Not for a contradicted claim, where going looking
for a friendlier source is cherry-picking with extra steps.

### A short draws on two documents at most

Not an evidence rule. A ninety-second story stitched from four documents is a
compilation: four writers' emphases, four sets of names for the same people,
four points where the register changes. A listener hears that as the thing
jumping around.

Measured on a real ten-story set, and by a listener rather than by a check: the
story built from **two** sources was the best in it, the story built from
**four** was the worst, and they named both without knowing which was which.

Each story keeps the documents that carry most of it, tie-broken by tier and
then by id so one corpus always gives one answer. Deterministic, free, and it
touches only two or three stories in a typical set.

**Long episodes are untouched**, and the case is the opposite there: assembling
what fourteen documents separately establish is the whole point of the factual
lane, and breadth is the product rather than a seam.

What it costs is facts. A story trimmed from four sources to two loses whatever
only the other two carried, and can fall below its claim floor - at which point
the gate reports it as thin, which is true.

### A told story reads few documents whole; a subject reads many in part

Two research lanes, declared per format as `research: single | extensive`.

`extensive` is the original: search wide, fetch fourteen documents, extract
claims bound to verbatim quotes, verify each against a different model family,
repair what fails, write from the ledger. Right where assembling what many
documents **separately** establish is the product, which is The Root Health.

`single` picks the one to three documents that carry the whole story, reads
them at a hundred thousand characters each rather than six thousand, and fuses
them into **one reference article** the writer works from. No claim ledger, no
per-fact verification, no counter-evidence pass, and one check at the end:
`reviewReference` reads the article back against its own documents.

**What forced it.** The Descent of Inanna episode (e008) fetched 585,396
characters across fourteen documents, showed the extractor 13% of them, and
drew its facts like this:

| claims | document |
| --- | --- |
| 9 | a university course handout |
| 8 | Ancient Mesopotamian underworld - Wikipedia |
| 7 | Inanna - Wikipedia (her whole biography) |
| 7 | Dumuzid - Wikipedia (his whole biography) |
| **6** | **Descent of Inanna into the Underworld** |
| 2 | Ereshkigal - Wikipedia |
| 1 | a chronology table |
| 1 | a second course page |

The article that **is** the story came fifth. A script assembled from eight
documents' partial views of one myth wanders, changes its emphasis and
contradicts itself, and a listener hears exactly that.

The keyhole also lost the answer to the episode's own central question. The
script says "The text does not explain guilty of what". The main article has a
section headed **"A guilty goddess"** explaining it - Inanna went down to take
her sister's throne and "failed in her thoughtless endeavor to conquer" - at
roughly character 71,000 of a 98,191-character document. `REFERENCE_CHARS_PER_SOURCE`
is 100,000 for that reason and not as a round number.

**What it costs.** No sentence-level quote binding, so a fabricated sentence in
the reference has one check rather than five. `sourceIds` are still real fetched
sources and cannot be invented, and the gate fails closed when the review did
not run - but this lane is weaker on provenance and stronger on coherence, and
that is the trade. A myth is a claim about a text; a health claim is a claim
about the world, and the second one keeps the ledger.

### Where the sources disagree, the fusion decides and the episode says nothing

The disagreements go in the reference's `variants`, which is written to the run
and **never shown to the writer**. A person can audit every choice; a listener
hears one story.

**The reversal this is.** `myth-told` says "WHERE THE VERSIONS DISAGREE, SAY SO
PLAINLY AND SAY WHO SAYS WHAT", and the writer prompt says a beat using an
unsettled claim without voicing it "is rejected". On e008, **one** contested
claim out of forty-four produced roughly 200 of the 386 words in the payoff
beat - fragment attribution, the Akkadian transmission history, the
dying-and-rising-god reading that fell apart - plus the last line of the
episode. The planner had already baked it into the spine before a word was
written.

That is a literature review in the place where the story should land. Scholarly
honesty was never the problem; the problem is that a disagreement is the most
interesting thing on the page to a writer and the least interesting thing in the
world to somebody walking home with headphones on.

Enforced rather than requested: `findHedging` is a deterministic check over the
finished prose, and every pattern in it is a phrase from that episode. A model
told three times not to hedge still hedges when the material invites it, and it
reaches for a synonym rather than for the truth - "the surviving tablets stop
agreeing with each other" is in the list because a list of the obvious verbs
walked straight past it.

**What would change it.** A myth whose transmission genuinely is the story -
where which manuscript survived, and who changed it, is more interesting than
the events. `myth-told` is kept for exactly that and is chosen with `--format`.

### Explanation is not an assertion, and a grounding check that says otherwise flattens the prose

The grounding review reads a script against its ledger and reports what no claim
supports. On e008 it reported:

- "It comes from Sumer, in what is now southern Iraq."
- "It was written down in cuneiform, wedge marks pressed into wet clay"
- "They came to Uruk, a city on the Euphrates."

All three are general world knowledge doing the one job this show's own canon
says matters most - "the world of the story has to be explained before the
story, or every event in it sounds arbitrary". The prompt has carve-outs for
inference **from the claims** and none for knowing where Iraq is.

With two revision passes a beat, a writer told that explaining is a violation
learns that the safe way to explain something is to barely explain it. That is
where "cuneiform, wedge marks pressed into wet clay" comes from: the
information is present, the clause is unimpeachable, and nobody is taught
anything. A listener wants the four sentences - what it is, how it was done,
why anybody did it that way, and why that is why we still have the story.

So on the `single` lane the rule is split. **Events, names, numbers, motives and
anything anybody said** come from the reference. **Explanation of the world**
does not have to, and the beat sheet asks for it at length.

### Only two verdicts block, and neither is about wording

`contradicted` (the document says the opposite) and `unsourced` (there is no
document). `partially_entailed` and `not_entailed` no longer block.

The distinction is what a person can catch. Every script goes in front of
somebody before a word of it is voiced, with each claim beside its quote, and
"this says a little more than its source does" is exactly the judgement a reader
makes well and a rewriting model makes badly. A fabricated quote is the
opposite: it produces a sentence that reads exactly like a true one, and no
amount of reading finds it.

`unsourced` got its own verdict for that reason. It used to be recorded as
`not_entailed`, which was fine while that blocked - and would have quietly
ridden out on the same relaxation.

### A contradicted claim is dropped outright

The hedge route is for what the record does not decide. That is the record
deciding against you, and hedging it would be a lie about a document that says
plainly otherwise.

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

### "Everything on by default, because every pass was built in response to a real fault"

Every paid pass is now **off** by default. `config/stages.ts` used to read
"everything else is on, because everything else was built in response to a fault
that reached a finished episode", which was true of each pass individually and
produced a pipeline where one episode cost 232p, of which 139p was checking and
rewriting rather than making:

| | |
| --- | --- |
| script draft | 11.7p |
| three rewrites | **87.1p** |
| reference check | **51.6p** (and it failed) |
| perform | 8.1p |
| the actual research + render | 85p |

The rewrites were also not converging. Draft one averaged 24.4 words a sentence
against a target of 13; the rewrite over-corrected to 4.1 words of variance
against a minimum of 5; six problems were still outstanding when the budget ran
out. Paying four times to arrive somewhere neither is a bill, not a control.

The owner's instruction: *"remove all the checks, i dont want to waste money on
any checks revisions or gates, we will add them one by one later. we start with
minimal cost and keep adding stuff as we go along."*

**A DETERMINISTIC CHECK IS NEVER SWITCHED OFF, because it is free.** The style
card, `critiqueBeat`, `findHedging`, speakability, self-similarity, the quote
ledger and the gate are arithmetic over text already on disk. They still run and
still report on every run; what changed is only whether a MODEL is bought to act
on them. A draft that fails its critique is now reported and kept rather than
rewritten three times.

Estimated floor for a single-story episode: **62p against 232p**.

What would change it: an episode going out. Everything here is a drafting
economy, and the gate still fails closed on the single-story lane when the
reference was never checked, precisely so that "cheap" cannot quietly become
"unchecked and published".



Recorded because the reasoning that produced each was plausible.

### "Say things twice, differently"

Written because a listener cannot rewind. A model implements say-it-twice as
**say-it-wrong-then-correct-it** - "eleven years old. Not eleven months into a
criminal career. Eleven years old, full stop" - because that is the shape
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

Now the choice is **speech duration** - both takes are the same text, so more
speech is more of that text, and there is nothing to weigh.

### A `counterpoint` beat in every evidence-bearing format

The duty is real: confident one-sidedness is the commonest way generated content
is false while every sentence is sourced. A dedicated beat was the wrong
instrument - it stopped the episode two thirds through to argue with itself and
then resumed.

The duty moved into the payoff: say where the accounts disagree **at the point
in the story where they disagree**. The format test now accepts either shape and
insists on one of them.

### "Answer the question from the opening, in the same words if you can"

The `honest` beat of the health format said exactly that, and the `close` beat
said "land it by returning to something from earlier". The reasoning was sound:
an episode that never returns to its own question has no ending.

What it produced was **eleven of twenty-five facts stated in two beats**, and a
last third that was the first two thirds in different words. The instruction did
not ask for a recap and got one anyway, because a beat told to answer a question
already answered has nothing else to work with.

Now: answer it, do not recap the route to it, and where an earlier finding must
be referred to, refer to it in three or four words and add something new. The
single callback in the close survives, because one specific thing returning is
an ending and several is a summary.

### A `people` beat: "what this looks like in a life rather than in a table"

Every popular science format has one and they are the best part of the good
ones. Here it produced two hundred and fifty words citing no source at all: an
anecdote about two students found with makeup on their faces, carrying a
specific "twenty four hours" the ledger did not support.

The format's own header had already worried about this - a model asked for a
real-life example produces a plausible, sympathetic, entirely fictional case
study, and nothing downstream catches it because it is not a claim about the
world, it is a story. The answer was to constrain the beat harder. That did not
work, and the answer now is **not to have one**. The beat is a `disagreement`
beat: who found what, who reads it differently, and what would settle it. That
is more interesting than the anecdote was, and it is checkable.

### A long request is streamed, decided by the transport

The first one-pass script call died with `fetch failed` after five minutes. Not
the model, not the prompt: Node's fetch abandons a response whose headers have
not arrived in 300 seconds, and a non-streaming request holds the socket silent
for its entire generation. The call was asking for 28,881 tokens at high effort
and the answer was still being written when the client hung up.

Streaming keeps bytes arriving so the timer never fires. The choice lives in
`nodeHttpPost` rather than in any client, because what a client asks for is an
answer and how many TCP frames it arrives in is not its business - putting it in
the transport fixed every caller at once and changed none of them. The stream is
reassembled into exactly the shape a single call returns.

Streamed above 8,000 output tokens, or at `high` effort whatever the ceiling,
since thinking tokens are spent before a single visible one.

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
- **Single-pass script generation.** BUILT AND UNDECIDED, which is different from
  where this sat before. `make --one-pass` writes the whole script in one call;
  the checks are identical, so a comparison is a comparison of the writing. The
  trigger stands: if one-pass faults are sentence-level and beat-by-beat faults
  are joins, repetition and continuity, one pass wins.
