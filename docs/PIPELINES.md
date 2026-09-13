# The pipeline plan

What exists, what is being asked for, and what each of those actually costs to
build. Kept in the repo rather than in a conversation because it is the thing to
re-read before starting any of it.

Last updated 2026-09-13.

> **Since this was written, most of it got built.** The health, news and serial
> shows now exist, along with the two mechanisms they needed: a per-show
> evidence policy and a voice registry. What remains open is at the bottom.

---

## Channels and voices

A **channel** is a show: a persona file, a topic queue, one or more hosts, and a
voice per host. There are seven, across three lanes.

**A channel's voice is pinned the first time it renders audio** and cannot drift
after that. A listener finds a show by its voice long before they read its name,
so changing it at episode twelve makes it a different show to everybody
following it. `voices.json` records what was used and when; a run whose persona
disagrees with it stops before any model call. Changing it on purpose is two
steps: edit the persona, then `foundry voice-retire --show <id>`.

`foundry voices` shows what each channel speaks in, and which are still
uncommitted.

Voice ids are per PROVIDER, because they have to be. A show drafted on OpenAI
and published on ElevenLabs legitimately has two, and neither id means anything
to the other engine.

## The thing to understand first

**"A new pipeline" is almost never a new pipeline.** The studio already
separates three things, and most new content is a new one of the cheapest:

| Layer | What it decides | Cost to add one |
|---|---|---|
| **Lane** | where truth comes from | weeks |
| **Format** | the shape of an episode | a day |
| **Show** | the voice, the taboos, the subject | an hour |

There are two lanes today and they are the expensive part:

**The factual lane** (`src/pipeline/episode.ts`). Brief, corpus, claims bound to
verbatim quotes, verification by a different model family, repair, script, render,
gate. Every assertion traces to a quote that provably occurs in a fetched
document. About 80p an episode, most of it research.

**The fiction lane** (`src/pipeline/fiction.ts`). No research at all, because no
document entails an invented scene. Continuity against a series bible replaces
the evidence ledger. About 40p an episode.

There is also a **derived short lane** (`src/pipeline/short.ts`) which cuts a
short out of a finished episode rather than researching its own, at about a
ninth of the cost.

So the question for each new idea is only ever: *which lane, and what is missing
from it.*

---

## What is asked for

### 1. Fiction serial, cliffhangers, Korean-drama shape

**Lane:** fiction. Already built.

This is the cheapest of the four and most of it exists. `serial-episode.yaml`
already sets `serialised: true`, the loop checker already enforces that an
episode opens a question it does not close, and `night-shift` is already a
fiction show with a continuity bible. `foundry series --show` prints what a
serial has established so far.

**What is missing:**

- It has never been run end to end. Everything above is built and untested.
- The cliffhanger is enforced as "a loop stays open", which is weaker than what
  a Korean serial actually does: the hook is usually a REVERSAL of something the
  episode spent its time establishing, not merely an unanswered question.
- Episode length. Those serials run 60 minutes because they are television.
  Audio wants 8 to 12, which changes the beat sheet rather than the lane.
- The bible grows without bound. Fifty episodes in, the continuity check is
  reading a very long document on every call. Needs a summarisation step or a
  relevance filter before it gets there, not on episode two.

**Verdict:** a beat sheet and a show, plus a first real run. Days, not weeks.

---

### 2. News and politics

**Lane:** factual. **And it is the only one of the four that needs real new
machinery.**

Four things the current lane has no concept of:

**Freshness.** Nothing in the corpus stage knows what "recent" means. A search
returns what it returns, and a claim verified against a two-year-old article
passes exactly as happily as one from this morning. News needs a recency filter
on retrieval and a staleness rule on claims.

**Cadence.** A run takes about twenty-five minutes wall clock, most of it
verification at a rate limit. That is fine weekly and impossible for anything
that wants to be same-day. Either the verification budget changes or the show
does not chase the news cycle.

**Risk.** `allowedRiskTiers` already distinguishes `named_person`, and the gate
already forces human review for claims about living people. News about serving
politicians is a step beyond that: it is where defamation exposure actually
lives, and where "every sentence is individually sourced" is least protective,
because the selection of which sourced sentences to say is the editorial act.

**Balance.** The counter-evidence pass exists and matters far more here than
anywhere else. On a myth it finds variant manuscripts. On a political story it
is the difference between an episode and a pamphlet.

**The honest recommendation:** do not build a news show that chases the cycle.
Build an **explainer** show that takes one thing already in the news and gives it
the long treatment - the documents behind it, what is actually known, what is
contested. That needs the recency filter and nothing else on this list, and it
is a better fit for a studio whose whole claim is that somebody went and read
the file.

**Verdict:** recency filter is real work. The rest is a show, IF the show is an
explainer rather than a bulletin. Decide that before writing any code.

---

### 3. Money and business

**Lane:** factual. Mostly already built.

`business-teardowns` exists as a Business & Finance show with
`case-study-teardown.yaml` and `short-teardown.yaml`. A case study is exactly
what the factual lane is for: filings, judgments, regulator notices and annual
reports are the best-sourced documents in existence.

**What is missing:**

- "Understanding economics" is a different format from a case study. A case
  study has a sequence; a concept does not. That is the same tension the myth
  show hit, and the answer was the same: find the story that carries the idea.
  One company's collapse teaches liquidity better than a segment about
  liquidity does.
- Numbers are the failure mode. A claim typed `statistic` must state a number
  and its quote must contain one, and that rule is going to reject a lot of
  perfectly good financial writing where the figure is in a table rather than a
  sentence. Worth checking against a real filing before committing.
- Tables and PDFs. Filings are PDFs, which the fetcher reads, but a number in a
  table is not a quotable sentence. This may need a real extraction change.

**Verdict:** a format and a show, plus one genuine open question about numbers
in tables. Start by running an episode on the existing teardown sheet and see
what breaks.

---

### 4. Health, fitness and psychology

**Lane:** factual, with a stricter evidence policy than any other show.

**What makes this different from every other show here,** and it is not the
subject:

**A wrong claim here can hurt somebody.** Everywhere else the cost of being
wrong is embarrassment. This is the one show where the gate's job is not
reputational.

**The source tiers matter more and are easier to get wrong.** A health claim
sourced to a news write-up of a press release about a preprint passes every
existing check: the quote occurs, the verifier agrees the quote supports the
claim, the tier is recorded. What is missing is that a news article about a
study is not evidence about the world. This needs a tier rule specific to the
show - systematic reviews and guidelines at the top, single studies well below,
news coverage of studies not usable at all.

**"Real life examples" is an invitation to invent.** A psychology episode wants
a person it happened to, and there usually is not one in the source. The
pipeline will happily produce a plausible, sympathetic, entirely fictional case
study and it will pass, because nothing checks that a person exists. This needs
a hard rule: an example is either sourced to a named case or explicitly framed
as hypothetical, out loud, in the narration.

**Simple breakdowns are the genuine strength.** Everything built in the last few
days - plain words, put the person back in the sentence, explain the unfamiliar
word on first use - is aimed exactly at this.

**Verdict:** a show and a format are easy. The evidence policy is the work, and
it should be built before the first episode rather than after the first bad one.

---

## What is shared

Worth building once, in this order:

1. **Recency filter on retrieval.** Needed by news, useful for business, harmless
   everywhere else.
2. **Per-show source tier policy.** The tiers exist; what does not exist is a
   show being able to say "a T3 source is not good enough for me". Health needs
   it, news wants it, myth does not care.
3. **Bible summarisation** for any serial that runs past about twenty episodes.
   Not urgent, and it will be urgent suddenly.
4. **Numbers in tables**, if the business lane confirms it is a real blocker.

---

## Build order

The order is not by appeal, it is by what teaches the most for the least money:

**1. Fiction serial.** Cheapest lane, mostly built, and it is the only lane that
has never run. Finding out whether the fiction pipeline works end to end is
worth more than any new show, because everything else assumes it does.

**2. Business.** Reuses the lane that has been debugged for a week. The open
question about numbers is answerable by running one episode.

**3. Health.** Build the evidence policy first, then the show. Do not run an
episode before the policy exists.

**4. News.** Last, and only after deciding it is an explainer rather than a
bulletin. If it is a bulletin, it is a different studio.

---

## Open questions for the owner

Written down because they change what gets built, and guessing at them wastes
the work:

- **News: explainer or bulletin?** This decides whether it is a show or a second
  studio.
- **Health: is advice ever given?** "Here is what the evidence says" and "here is
  what you should do" are different products with different exposure.
- **Serial: one continuous story, or an anthology with a recurring voice?** The
  bible design assumes continuity; an anthology barely needs one.
- **How many shows can actually be sustained?** Every show needs its own voice,
  its own topic queue and its own ear kept on it. Four shows at one episode a
  week is four episodes a week to listen to before publishing.
