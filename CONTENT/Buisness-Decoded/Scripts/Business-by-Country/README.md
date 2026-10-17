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
| `business-by-country/7` | Maruti Suzuki: A Car for Every Indian | `07-maruti-suzuki.txt` | ~1,390 (~8 min) |
| `business-by-country/8` | Airtel: Phones for Hundreds of Millions | `08-airtel.txt` | ~1,150 (~7 min) |
| `business-by-country/9` | Flipkart: Two Friends Take On Amazon | `09-flipkart.txt` | ~1,120 (~7 min) |

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

- Tata: the family map (R. D. Tata as Jamsetji's cousin; Navajbai adopting Naval;
  Ratan as Naval's son); Nowroji Saklatwala as chairman 1932 to 1938; Noel Tata
  chairing the trusts since October 2024; TISCO's 1907 share issue (about 2.3 crore rupees from about 8,000 investors);
  the "eat every pound of steel" line is told as a story, not a quote; group figures
  (around 30 listed companies, over a million employees, revenue over $160bn).
- Reliance: who runs what now (Akash: Jio, Isha: retail, Anant: new energy);
  Dhirubhai's Aden years and the size of the first office are told as the
  company tells them; the 1982 bear raid; the first company past 10 lakh crore revenue.
- Amul: the Samarkha meeting (January 1946); Nehru opening the 1955 plant; farmer and
  society counts (about 3.6 million, about 18,000).
- Infosys: the 1990 buy-out offer and the Bulgaria story are given as the founders' own
  accounts; FY2025 revenue around $19bn.
- Asian Paints: the Choksey family leaving in 1997, and Dani, Choksi and Vakil
  as the families still in control; the 1970 computer; rivals named for the 1940s; revenue "over thirty
  thousand crore".

Allegations (Reliance and the licence raj, the Indian Express campaign) are attributed
and said to have been denied; keep them that way.

Written 2026-10-17, from memory, check before publishing:

- Maruti: first car handed over 14 December 1983 to Harpal Singh, price about 47,500
  rupees; Maruti Ltd wound up 1977; Suzuki stake 26% then 40% (1987), 50% (1992),
  majority 2002; renamed 2007; the 2012 Manesar violence; about 2 million cars a year
  and about four in ten of new cars sold.
- Airtel: the 20,000-rupee loan in 1976; the generator import ban; Delhi licence 1994,
  launch 1995; the 2004 outsourcing deals (Ericsson, Nokia, Siemens, IBM); Zain Africa
  about $10.7bn in 2010; calls about 16 rupees a minute in 1995.
- Flipkart: October 2007, about 4 lakh rupees; the first order (Leaving Microsoft to Change
  the World) is the company's own story; cash on delivery 2010; Bezos's $2bn in 2014;
  Walmart about 77% for about $16bn, May 2018.

## Who's who and tags

Every script opens its beginnings with a short spoken map of the people (family
generations for Tata, Reliance and Asian Paints; the key people for Amul and
Infosys). Tags go beyond the old short list; anything on the channel's `never`
list in `voice-master.yaml` is avoided, since it is removed at render.

## Pronunciation

The harder Indian names are in the `business-decoded` `pronounce` list in
`voice-master.yaml`. The scripts keep the real spelling.
