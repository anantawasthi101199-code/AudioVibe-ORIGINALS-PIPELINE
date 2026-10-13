# Business by Country - hand-written scripts

Business Decoded, map `business-by-country`, Series 1: **India: From Small Shops to Global Empires**.
Format `biz-episode` (parts: `hook`, `beginnings`, `struggle`, `rise`, `ending`). Host: Adrian.

| Map item | Episode | File | Words (spoken) |
|---|---|---|---|
| `business-by-country/1` | Tata: The Man Who Dreamed of Industrialising India | `01-tata.txt` | ~1,900 (~11 min) |
| `business-by-country/2` | Reliance: How Dhirubhai Ambani Built an Industrial Empire | `02-reliance.txt` | ~1,850 (~11 min) |
| `business-by-country/3` | Amul: How India's Farmers Challenged the Dairy Trade | `03-amul.txt` | ~1,850 (~11 min) |
| `business-by-country/4` | Infosys: The Small Startup That Helped Build India's IT Industry | `04-infosys.txt` | ~1,850 (~11 min) |
| `business-by-country/5` | Asian Paints: How a Local Manufacturer Beat Bigger Rivals | `05-asian-paints.txt` | ~1,800 (~10.5 min) |

Minutes are at the studio's 2.85 words a second; voiced with tags and pauses they run longer.

## How they reach the studio

Each is attached to its map item in `maps/business-by-country.json` (`script`: the
file, a title under 45 characters, a description). On the next deploy the studio
makes a held run for each one, filled in and free until somebody approves the voice.
Pick an outro from the dropdown (none is written into the scripts), voice on
ElevenLabs, and leave the tag pass off: the tags are already written in.

## Facts: CHECK BEFORE PUBLISHING

These were written from general knowledge, not bound to a fetched source, so nothing
has checked them automatically. Most worth a look:

- Tata: TISCO's 1907 share issue (about 2.3 crore rupees from about 8,000 investors);
  the "eat every pound of steel" line is told as a story, not a quote; group figures
  (around 30 listed companies, over a million employees, revenue over $160bn).
- Reliance: Dhirubhai's Aden years and the size of the first office are told as the
  company tells them; the 1982 bear raid; the first company past 10 lakh crore revenue.
- Amul: the Samarkha meeting (January 1946); Nehru opening the 1955 plant; farmer and
  society counts (about 3.6 million, about 18,000).
- Infosys: the 1990 buy-out offer and the Bulgaria story are given as the founders' own
  accounts; FY2025 revenue around $19bn.
- Asian Paints: the 1970 computer; rivals named for the 1940s; revenue "over thirty
  thousand crore".

Allegations (Reliance and the licence raj, the Indian Express campaign) are attributed
and said to have been denied; keep them that way.

## Pronunciation

The harder Indian names are in the `business-decoded` `pronounce` list in
`voice-master.yaml`. The scripts keep the real spelling.
