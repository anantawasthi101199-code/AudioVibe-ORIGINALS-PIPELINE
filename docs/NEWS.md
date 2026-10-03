# The news lane

News channels make one thing: a report on today's most important story on
their beat, under three minutes, from ONE article by a trusted outlet. No long
episodes. Current as of 2026-09-29.

If this file disagrees with the code, the code is right and this is a bug.

---

## Commands

```bash
# Today's top story on the channel's beat (no topic needed)
npm run foundry -- make --show global-thread

# One specific story
npm run foundry -- make --show global-thread --topic "Iran ceasefire talks"

# Stop before the audio, to read the script first
    ... --hold
npm run foundry -- script  --run <run-id>
npm run foundry -- approve --run <run-id>

# What it costs, spending nothing
    ... --dry-run

# Publish (a person, always; refused if the report has gone stale)
npm run foundry -- publish --run <run-id>
```

A news run renders straight away unless `--hold` is given, because news loses
its value by the hour and the audio is a few pence. Publishing is still a
separate command a person runs.

---

## The flow

```
  [free] WIRE      Brave News, last 24 hours, the desk's queries
  [free] SCREEN    desk outlets only; no live blogs, opinion, explainers,
                   headline pages, or off-beat stories
  [free] STORY     headlines clustered into stories; the story the most
                   desk outlets are carrying is today's top story
  [free] ARTICLE   the most preferred outlet's page that fetches, is
                   full-length (1,500+ chars) and is fresh by its OWN date.
                   One try per outlet, then the next outlet on that story.
  [paid] WRITE     one call: headline, lede, report, close, goodbye   ~3p
  [free] CHECK     figures, source named on air, follow ask, length
  [paid] RENDER    OpenAI voice                                       ~2-3p
  [free] GATE      again at publish time, which refuses a stale report
```

**No model decides what the news is.** The top story is whichever one the
most trusted outlets are independently carrying, the way a news aggregator
ranks. That is free, repeatable, and cannot be talked into a story because a
language model finds it interesting.

**One source, and only one.** Several outlets carrying a story is used as a
signal that it matters, and for nothing else. Their text is never read,
blended or quoted. The report is written from one article, and the reporter
says on air where it comes from ("according to reporting by the BBC").

Measured on the first live runs: **2.9p to 5.2p script-only**, about 5-8p with
audio.

---

## How the report is written

The rules are the broadcast conventions newsrooms teach (BBC, NPR, AP
broadcast style and the university broadcast-writing texts):

- **The lede first.** The first sentence is the newest, most important fact,
  present or present perfect tense. Somebody who leaves after it has the news.
- **Attribution before the claim.** "The ministry says 40 people were
  killed", never "40 people were killed, the ministry said". A listener cannot
  glance back to see who said it.
- **Neutral words.** "Said", never "claimed", "admitted", "slammed". No
  opinion, no prediction, no "only time will tell".
- **Both sides the article carries**, and allegations stay allegations.
- **Title before the name**, at most four names.
- **Figures as digits**, rounded only the way a newsreader rounds.
- **Days by name**, not "today", because a short is heard for days.
- **Never "the article"**. The reporter attributes to the organisation.
- **Complete.** Who, what, where, when, why it matters and what happens next,
  so far as the article says. No teasers.
- **The close** says what happens next, repeats the key development in fresh
  words for anybody who joined late, then signs off asking for the follow.

Three parts (`beatsheets/news-short.yaml`): lede 15-25s, report 60-95s, close
20-30s. The prompt also states the total word ceiling outright, because the
first live report ignored per-part budgets and came back 36 words over.

---

## The checks

All free and deterministic. **Blocking** means publish refuses; nothing ever
stops a report being MADE.

| Check | Blocks | What it catches |
|---|---|---|
| `newsFigures` | yes | A number in the script the article does not contain. Rounding within 10% is allowed for figures of 20 and over; smaller counts must match exactly. Dates and clock times are exempt. |
| `newsSource` | yes | The report never names its outlet. |
| `newsOutro` | yes | The last part never asks the listener to follow. |
| `newsLength` | yes | Audio over 180 seconds. |
| `newsStale` | yes | The article is older than the desk's `publishWithinHours` (48) at the moment somebody publishes. |
| `referenceUnsupported` | no | A capitalised name the article never uses. For a person to read. |
| `newsLoadedWords` | no | "Claimed", "slammed" and the like in the reporter's own voice. |

Plus every audio check the other lanes run: style card, repetition,
speakability, self-similarity (against OTHER channels only, because following
an ongoing story shares vocabulary by design).

A channel never reports the same article twice, or a headline 75% the same,
within seven days. A new development on an ongoing story is new news and goes
through.

---

## Making another news channel

A channel is a news channel exactly when `desks/<id>.yaml` exists. Copy both:

- `personas/global-thread.yaml` - the reporter, the register, the goodbyes
  (`signoffShort`, one picked per report)
- `desks/global-thread.yaml` - the beat, the morning queries, the trusted
  outlets in preference order, the age limits, headline words that are off-beat

Change the id, the beat, the queries and the goodbyes. Nothing else.

---

## Before the first publish

- **The voice.** The first render pins the channel's voice for ever (see
  `voices.json`). The persona says `onyx` on OpenAI. Listen to a held run's
  audio before approving the first one.
- **The account.** `geopoliticstoday` must exist on the platform with `is_ai`
  set, then `channel-setup` and `channel-token`, as for every channel.

---

## Files

| Path | What it is |
|---|---|
| `src/pipeline/news.ts` | The lane, `runNews`, and `regateNews` for publish. |
| `src/news/desk.ts` | Desk schema; `hasNewsDesk` is the routing decision. |
| `src/news/wire.ts` | Brave News, and the screen: outlets, live blogs, opinion, index pages. |
| `src/news/pick.ts` | Clustering, "already reported", and choosing the one article. |
| `src/news/newsScript.ts` | The reporter prompt and the writer. |
| `src/news/check.ts` | The figure, name, source, outro, length and staleness checks. |
| `beatsheets/news-short.yaml` | The three-part report shape. |
| `desks/global-thread.yaml` | The first desk. |
| `personas/global-thread.yaml` | The first news channel. |
