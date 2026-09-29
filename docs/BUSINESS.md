# The business-story lane

How businesses and the people behind them were built, from the first shop to
the empire, told complete and in order by a friendly host. Episodes of 11 to 14
minutes and shorts under three. Current as of 2026-09-29.

If this file disagrees with the code, the code is right and this is a bug.

---

## Commands

```bash
# An episode (the default format)
npm run foundry -- make --show how-they-built-it --topic "how did reliance group ambani become the richest in asia"

# A short
npm run foundry -- make --show how-they-built-it --format biz-short --topic "Haldiram's"

# Price it, spending nothing
    ... --dry-run

# Held before audio by default, like every non-news run
npm run foundry -- script  --run <run-id>
npm run foundry -- approve --run <run-id>
```

The topic can be a name ("Haldiram's") or a question ("how did Haldiram become
Haldiram"); the subject is pulled out of it for searching.

---

## The flow

```
  [free] SEARCH   the casebook's 3 web queries for the subject (Brave)
  [free] SOURCE   social, Q&A and content-farm hosts refused; up to 6 pages
                  fetched and SCORED; ONE wins
  [paid] WRITE    one call writes the whole story and its title
  [free] CHECK    figures, quotations, unknowns, follow ask, length, order
  [paid] RENDER   OpenAI voice
  [free] GATE     again at publish
```

**One source, chosen without a model.** Each candidate is scored on what makes
a source right for a told life story:

| Signal | Weight | Why |
|---|---|---|
| Length (to 30,000 chars) | 5 | "a source that has the complete story" |
| Distinct years (to 25) | 3 | a life told year by year |
| Span of years (to 60) | 1 | from the first shop to now |
| Subject words present | 2 | about this, not about something near it |
| Subject mentions (to 20) | 1 | about it throughout |
| Preferred host | 0-1 | encyclopedias, business press (casebook) |

Too short for the format, or barely about the subject, is rejected outright.
Length outweighs tier on purpose: the first live short picked a 5,121-character
Wikipedia stub over an 18,178-character feature that told the whole story.

**The whole story in one call.** "It needs to be systematic, and therefore the
story part is generated at once." Parts exist in the beat sheets to give each
stage of the life a budget, not to be written separately.

---

## Measured on the first live runs

| Run | Source | Script | Est. total |
|---|---|---:|---:|
| Haldiram's, short | Wikipedia, 5k chars | 2.6p | ~6p with audio |
| Reliance, episode | Wikipedia, 62k chars, 47 years | 11.7p | ~25p with audio |

Owner's budgets: a short under 10p, an episode under 100p.

---

## How it is written

Episodes: hook (the tiny beginning against the empire, or the moment it was
all on the line) then hello, beginnings, the hard years, the rise, and where it
stands now with a proper ending of success and the follow.

Shorts: story to the turning point, the rise to today, one line and the follow.

- **In order**, the year said at each new step, signposted between parts.
- **Tricky business terms explained in a clause** in episodes ("an IPO, which is
  when a company first sells its shares to ordinary investors"); avoided in
  shorts. Everyday words need nothing.
- **Motivational because it is real**: the setbacks and numbers carry it. No
  invented scenes, feelings, dialogue or quotes.
- **Controversy mentioned briefly and fairly** where the source records it.
- **Amounts in the source's currency**; never converted.

---

## The checks

| Check | Blocks | What it catches |
|---|---|---|
| `bizFigures` | yes | A number the source does not contain. Years must match exactly; a decade ("the 1990s") needs a year inside it. |
| `bizQuote` | yes | Words in quotation marks the source never says. |
| `bizUnknown` | yes | "It is unclear..." when the source never says so. |
| `bizMeta` | yes | Talking about "the source" instead of telling. |
| `bizOutro` | yes | No follow ask at the end. |
| `bizShortLength` | yes | A short over 180 seconds. |
| `bizChronology` | no | The story jumping back in time after the hook. |
| names | no | A name the source never uses. |

Plus every audio check the other lanes run.

---

## Lanes are exclusive

`src/pipeline/lanes.ts` decides every run's lane: fiction, news (a desk),
business (a casebook), or story. A channel on two is refused; a format from
another lane (`biz-*`, `news-*`) is refused before anything is spent.

---

## Files

| Path | What it is |
|---|---|
| `src/pipeline/business.ts` | The lane, and `regateBusiness` for publish. |
| `src/business/casebook.ts` | Casebook schema; `hasCasebook` routes the channel. |
| `src/business/pickSource.ts` | Subject, search, refusal, cleaning, scoring. |
| `src/business/storyScript.ts` | The host prompt and the one-call writer. |
| `src/business/check.ts` | The lane's checks. |
| `src/qa/sourceText.ts` | Figure, quote, name and unknown checks shared with news. |
| `src/pipeline/lanes.ts` | Which lane a run is on. |
| `casebooks/how-they-built-it.yaml` | Queries, preferred and refused hosts, sizes. |
| `personas/how-they-built-it.yaml` | Zara, the register, the goodbyes. |
| `beatsheets/biz-episode.yaml`, `biz-short.yaml` | The shapes. |
