# The psychology lane

What is actually happening in somebody's mind, explained warmly and very
simply. Episodes of nine to twelve minutes, shorts under three. Current as of
2026-09-30.

If this file disagrees with the code, the code is right and this is a bug.

---

## Commands

```bash
# An episode (the default format)
npm run foundry -- make --show psyche-session --topic "ADHD overwhelm"

# A short
npm run foundry -- make --show psyche-session --format psych-short --topic "why you procrastinate on easy tasks"

# Price it, spending nothing
    ... --dry-run

# Held before audio by default
npm run foundry -- script  --run <run-id>
npm run foundry -- approve --run <run-id>
```

---

## The flow

```
EPISODE
  [free] SEARCH     six queries, one per question the episode asks
  [free] CORPUS     refused hosts dropped BEFORE any fetch; best six kept
  [paid] EXTRACT    each document read separately, only what this show uses
  [paid] FUSE       ONE understanding: the picture, the mechanism, the
                    moments, the inner voice, what helps
  [paid] WRITE      the whole episode in one call
  [free] CHECK      safety, jargon, statistics, the picture, the outro
  [paid] RENDER     OpenAI voice
  [free] GATE       again at publish

SHORT
  [free] SEARCH + one article      [paid] WRITE      [paid] RENDER
```

**Why the research is two stages.** The owner's instruction, and the reason it
is right: no single page on a psychology topic has both the mechanism and the
lived experience. A clinical page explains what the brain is doing and contains
no recognisable moment; a lived-experience piece has the exact moment and no
idea why it happens; the practical pages have strategies attached to nothing.
Hand all six to one call and you get whichever was longest, told badly. So
EXTRACT reads them one at a time and keeps each finding attached to where it
came from, and FUSE decides.

**What the writer never sees:** `variants` and the documents themselves.
Disagreements are resolved in the fusion and written to `reference.json` for a
person. A listener who is already overwhelmed does not need a paragraph on what
the literature has not settled.

**The picture** is the single most important thing the fusion decides: one
everyday image that carries the mechanism accurately, which the episode builds
early, explains the science through, and lands on at the end. The first live
run chose a kitchen funnel that clogs when you pour flour, water, rice and
marbles in at once, over "the wall of awful", and wrote down why.

---

## Measured on the first live runs

| Run | Research | Script | Length | Total so far |
|---|---:|---:|---:|---:|
| ADHD overwhelm, episode | 12p | 11p | 602s est | 23.4p, ~38p with audio |
| Why you procrastinate, short | free | 4p | 162s est | 4p, ~8p with audio |

Budgets: an episode under £1, a short under 10p.

---

## How it is written

The rules come from a sample script the owner supplied as the target. What that
script does, and what the prompt therefore requires:

- **Open on the moment**, in the second person, with an everyday comparison,
  before naming the subject.
- **Take the blame off in the first four sentences**: "you're not doing it on
  purpose", "you're not alone", then the name of the thing, then a promise of
  three things.
- **One sustained picture**, built early, carrying the science, called back in
  the last lines. Checked for.
- **At most two technical terms**, each glossed in the same breath.
- **Correct a belief** rather than listing facts.
- **Say the listener's own thoughts back to them**, in their words.
- **Advice is subtraction**, each with a worked before and after: "clean the
  kitchen" becomes "pick up one thing and throw it away".
- **One small human aside**, warm, never at the listener's expense.
- **End** with one tiny thing to do today, then the goodbye.

Shorts keep all of it and drop the jargon entirely: one idea, one comparison,
one thing to try.

---

## The checks

| Check | Blocks | What it catches |
|---|---|---|
| `psychDiagnosis` | yes | Telling the listener they have a condition. "If you have ADHD" and "people with ADHD" stay fine; "you have ADHD" does not. |
| `psychTreatment` | yes | Naming a drug, or starting, stopping or changing a medication or therapy. Pointing at a professional is fine. |
| `psychCure` | yes | "Cure", "rewire your brain", "gone forever". |
| `psychCare` | yes | Anything crisis-adjacent with no line pointing at real help. |
| `psychJargon` | yes | A tricky term with no plain gloss attached to its first use; more than one term in a short. |
| `psychStats` | yes | A percentage, a count in the thousands or "three times more likely" that the research does not contain. |
| `psychSecondPerson` | yes | It stopped saying "you" and became a lecture. |
| `psychOutro` | yes | No follow ask at the end. |
| `psychLength` | yes | A short over 180 seconds. |
| `psychPicture` | no | The episode never builds or never lands on its own picture. |
| `psychSources` | no | Fewer than two documents from a body on the curriculum's list. |

**Deliberately not checked: small numbers.** "Trust the next two minutes",
"fifty tabs open", "thirty seconds" are the host's own speech, not claims. A
figure check that flagged those would be switched off within a week.

---

## Known limitation: what the searches return

The first live run asked about "ADHD overwhelm" and came back with six coaching
and clinic blogs and nothing from the NHS, the APA or CHADD. The reason is that
a colloquial phrase for an experience is not what those bodies put in a page
title. Two things were done about it, and neither is a complete fix:

1. A clinically-phrased query, `"{topic} symptoms causes treatment"`, leads the
   list.
2. `psychSources` reports the count on every episode and asks for a human.

If a topic matters, check `reference.json` for where it came from before
approving the render.

---

## Files

| Path | What it is |
|---|---|
| `src/pipeline/psych.ts` | The lane, and `regatePsych` for publish. |
| `src/psych/curriculum.ts` | Curriculum schema; `hasCurriculum` routes the channel. |
| `src/psych/understand.ts` | EXTRACT and FUSE, and what the writer is shown. |
| `src/psych/psychScript.ts` | The host prompt and the one-call writer. |
| `src/psych/check.ts` | The safety floor and the craft checks. |
| `curricula/psyche-session.yaml` | Queries, preferred and refused hosts, sizes. |
| `personas/psyche-session.yaml` | Noor, the register, the goodbyes. |
| `beatsheets/psych-episode.yaml`, `psych-short.yaml` | The shapes. |
