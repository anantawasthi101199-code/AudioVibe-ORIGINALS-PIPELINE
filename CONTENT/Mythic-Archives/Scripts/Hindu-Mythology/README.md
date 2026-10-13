# Hindu Mythology - hand-written scripts

Mythic Archives, map `hindu-mythology`, Series 1: **The Foundations of Hindu Mythology**.
Format `myth-story` (parts: `opening`, `story`, `close`). Narrator: Akira.

| Map item | Episode | File | Words (spoken) |
|---|---|---|---|
| `hindu-mythology/1` | Before the Beginning: How Did the Universe Begin? | `01-before-the-beginning.txt` | ~2,030 (~12 min) |
| `hindu-mythology/2` | Brahma, Vishnu and Shiva: The Three Cosmic Powers | `02-brahma-vishnu-and-shiva.txt` | ~2,010 (~12 min) |
| `hindu-mythology/3` | The Many Gods of Hindu Mythology | `03-the-many-gods.txt` | ~1,940 (~11 min) |
| `hindu-mythology/4` | The Seven Worlds Above and Below | `04-the-seven-worlds.txt` | ~2,050 (~12 min) |
| `hindu-mythology/5` | The Four Yugas: The Rise and Fall of the Ages | `05-the-four-yugas.txt` | ~2,180 (~13 min) |

## Putting one into the studio

Each of these is attached to its map item in `maps/hindu-mythology.json`
(`script`: the file, a title under 45 characters, a description), and the map
panel shows "script written" for them.

1. Studio → Mythic Archives → the map's next item → **Load into Make**.
2. Press **Blank script**. The run opens with the whole script already filled
   in, with its title and description set. Nothing has been paid for at this point.
3. Pick an outro from the dropdown. None is written into the scripts, so the
   channel's fixed outro is said word for word.
4. Voice on **ElevenLabs** and **leave the tag pass off**. The tags are already
   written in.

To change a script, edit its file here. A blank made after that picks up the
new text. The whole-script box on the run page takes the same format, if you
would rather paste one in by hand.

## Tags

The tags are written in for ElevenLabs v3/v4, e.g. `[warmly]`, `[hushed]`,
`[building tension]`, `[pause]`, `[curious]`, `[darkly]`, `[reverently]`,
`[breathes in]`. Some are beyond the channel's suggested list. Tags on the
channel's `never` list in `voice-master.yaml` are removed at render, so none
of those are used.

## Pronunciation

Sanskrit names from these five episodes were added to the `mythic-archives`
`pronounce` list in `voice-master.yaml`. The script keeps the real spelling,
and the respelling is applied only when the voice reads it.

## Sources the stories follow

Rig Veda 10.129 (Nasadiya Sukta) and 1.32 (Indra and Vritra); Vishnu Purana
books 1, 2 and 6; Bhagavata Purana (Brahma in the lotus, Dhruva, Parikshit and
the bull); Shiva Purana (the pillar of fire); Mahabharata, Vana Parva (Bhima
and Hanuman; Markandeya on the end of the Kali Yuga and Kalki).
