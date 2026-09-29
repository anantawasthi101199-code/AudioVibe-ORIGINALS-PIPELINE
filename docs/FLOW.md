# The flow

What actually happens between typing a topic and having an audio file, on the
single-story lane, for both an episode and a short. Current as of 2026-09-29.

A drawn version of this, with the same numbers:
**https://claude.ai/artifact/NXhiAbwvRNsJPnkYtJUnxX**

If this file disagrees with the code, the code is right and this is a bug.

The serial fiction lane is a different shape and lives in
**[DRAMA.md](DRAMA.md)**: a season broken once up front, then episodes written
against it.

---

## The two lanes

```
                        TOPIC
                          |
                    [paid] BRIEF                  angle + search queries
                          |
                    [free] CORPUS                 search + fetch 8 candidates
                          |
                    [paid] SELECT                 keep the ones that carry it
                          |
            +-------------+-------------+
            |                           |
     EPISODE (15 min)            SHORT (3 min)
            |                           |
     [paid] FUSE  ~41p            ONE ARTICLE
       2-3 docs read WHOLE        no fusion step
       into one article           saves ~41p
            |                           |
        REFERENCE                       |
       one voice, variants              |
       held back from writer            |
            |                           |
     [paid] WRITE  ~27p          [paid] WRITE  ~8p
       3 parts, one call           article straight
                                   to script
            |                           |
            +-------------+-------------+
                          |
                    [free] CRITIQUE             style, hedging, repetition
                          |                     reported, never auto-fixed
                    [paid] TITLE
                          |
                    [paid] RENDER + BED         voice, then music under it
                          |
                    [free] GATE                 measures and reports only
                          |
                       EPISODE                  held unless --render-now
```

**The lanes differ in exactly one place and it is the expensive one.** An episode
pays for a fusion step that reads its documents whole and writes a single
reference article. A short has one document, so there is nothing to fuse and the
article goes straight to the writer. That one omission is most of the difference
between 90p and 15p.

---

## Commands

```bash
# A 15-minute episode
npm run foundry -- make --show myths-of-the-world --topic "..."

# A 3-minute short
npm run foundry -- make --show myths-of-the-world --format myth-short --topic "..."

# Skip the approval break and voice it straight away
    ... --render-now

# What it would cost, spending nothing
    ... --dry-run

# Read the script of a finished run
npm run foundry -- script --run <run-id>
```

---

## What each step does

| # | Step | Cost | What happens |
|---|---|---|---|
| 1 | **Brief** | ~2p | Proposes the angle and writes the search queries. |
| 2 | **Corpus** | free | Searches and fetches. `SINGLE_STORY_CANDIDATES = 8` - a pool to choose from, not a corpus. Most of it exists so the selector has something to reject, and so a run survives the half of a myth corpus that 403s. |
| 3 | **Select** | ~1.5p | Reads each candidate's title, tier, length and first `SELECT_PREVIEW_CHARS = 1,200` characters. Keeps at most `MAX_STORY_SOURCES = 3`, or one for a short. Judges both *complete* and *long enough*. `topUpSelection` is the deterministic floor under it: `SOURCE_CHARS_PER_SECOND = 20` of target runtime. |
| 4 | **Fuse** | ~41p | **Episode only.** Reads the chosen documents at `REFERENCE_CHARS_PER_SOURCE = 100,000` each and writes one reference article: the story in order, the world, a cast tiered into carry and texture, a glossary written to be spoken, and a decided ending. |
| 5 | **Reference check** | ~50p, **OFF** | Reads the article back against its own documents with a different model family. On this lane it is the only thing checking the facts, so the gate fails closed when it has not run. `--reference-check` |
| 6 | **Write** | 8-30p | The whole thing in one call. Three parts either way. |
| 7 | **Critique** | free | Style card, repetition, banned phrases, speakability, `findHedging`. Always runs, always reports. |
| 8 | **Rewrite** | ~87p, **OFF** | Pays a model to act on what the critique found. `--script-revisions` |
| 9 | **Render + bed** | 3-15p | One TTS request per part, split on sentence endings past the engine's limit. Then a synthesised music bed mixed under each part. `--no-music` for a bare voice. |
| 10 | **Gate** | free | Measures and reports. **Never stops an episode being made** - only `publish` consults it. |

**Every paid pass is OFF by default.** Free deterministic checks always run.
Adding one back is one flag each: `--reference-check`, `--script-revisions`,
`--perform`, `--grounding`, `--counter-evidence`, `--repair`, `--gaps`. All
seven quotes at about 171p for an episode.

---

## Measured costs

| Run | Lane | Script | Total |
|---|---|---:|---:|
| e008 Inanna | extensive, checks on | 31.2p | 184.7p |
| e010 Inanna | single, revisions on | 99.3p | 232.3p |
| e011 Gilgamesh | single, everything off | 13.3p | 57.5p (no audio) |
| e013 Amaterasu | single, 3 parts + music | 27.0p | 81.4p |
| **e014 Orpheus** | **short, everything off** | **7.7p** | **14.5p** |

Roughly **100 shorts for £14.50**, or **100 episodes for £90**.

> **Shorts render on the OpenAI voice or they do not fit.** ElevenLabs is 20p
> per thousand characters, so voicing a three-minute short is 57p on its own,
> four times the whole budget. No tuning elsewhere absorbs that.

---

## Why it is built this way

Three faults in one episode drove nearly all of it. Each is in
[DECISIONS.md](DECISIONS.md) in full.

**The story article contributed 6 of 41 facts.** The old lane fetched 585,396
characters across fourteen documents and showed the extractor 13% of them, six
thousand characters each. The article that *was* the story came fifth, behind a
course handout and two biographies. A script assembled from eight documents'
partial views of one myth wanders and contradicts itself.

The same keyhole lost the episode's own central answer: the script said *"the
text does not explain guilty of what"* over a source section headed **"A guilty
goddess"**, sitting at character 71,000. `REFERENCE_CHARS_PER_SOURCE = 100,000`
is set by that number, not rounded to it.

**One contested claim ate half the ending.** Of 44 claims, one was contested,
and it produced ~200 of the 386 words in the payoff beat plus the last line of
the episode. Now the fusion *resolves* disagreements into `variants`, which is
written to the run and **never shown to the writer**. `findHedging` is the
deterministic backstop, and every pattern in it is a phrase from that episode.

**Five parts read as five separate essays.** Each beat carried its own brief, so
the writer produced five short essays butted together - "every time a new parah
is started it is not a continuation of the previous parah". Now three parts, the
world woven into the telling, and both joins scripted: part one hands over out
loud, part three picks up from the last event by name.

---

## Writing rules worth knowing

- **Names in three moves**: name, one line on who they are, back to the story.
  Never buried in an appositive.
- **No pronunciations, ever.** The speech engine already says the name; a
  respelling made it say the name and then spell it out in syllables.
- **Carry vs texture names.** The reference tags each person `carry: true/false`.
  A carry name is used repeatedly and reminded; a texture name is said once
  where it acts, or replaced by what they did.
- **Teach, do not tuck into a comma.** An explanation folded into an aside is an
  explanation nobody hears.
- **Never say the sources disagree.** That was decided before writing started.

---

## Sign-offs

`personas/<show>.yaml` carries `signoff` (long) and `signoffShort`. Both are
lists; one is picked per episode from the topic, so it is stable on a re-render
and different between episodes. **This is the only place a goodbye is defined.**

---

## Files

| Path | What it is |
|---|---|
| `src/evidence/story.ts` | Select, fuse, review. The lane's research. |
| `src/script/storyScript.ts` | The episode writer, and `findHedging`. |
| `src/script/shortScript.ts` | The short writer. One call, no fusion. |
| `src/render/bed.ts` | The music bed: styles, level, ducking. |
| `src/render/instruments.ts` | Synthesised piano, strings, drum, reverb. |
| `beatsheets/myth-story.yaml` | The 3-part episode shape. |
| `beatsheets/myth-short.yaml` | The 3-part short shape. |
| `src/config/stages.ts` | Which paid passes run. All off by default. |
