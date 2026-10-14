# Business Decoded Shorts - hand-written scripts

Business Decoded, map `business-shorts`, format `biz-short` (parts: `story`, `rise`, `close`). Host: Adrian. Standalone shorts, never filed in a series.

| Map item | Title | File | Words |
|---|---|---|---|
| `business-shorts/1` | Starbucks: From One Bean Shop to the World | `001-starbucks.txt` | 416 |
| `business-shorts/2` | Zara: New Clothes in Weeks, Not Months | `002-zara.txt` | 382 |
| `business-shorts/3` | Google: The Search Engine Built in a Garage | `003-google.txt` | 386 |
| `business-shorts/4` | Uber: The Taxi Company With No Taxis | `004-uber.txt` | 386 |
| `business-shorts/5` | Ferrari: The Racing Team That Sells Cars | `005-ferrari.txt` | 392 |
| `business-shorts/6` | LEGO: The Toy Company That Almost Broke | `006-lego.txt` | 383 |
| `business-shorts/7` | Rolex: The Watch Company Owned by a Charity | `007-rolex.txt` | 397 |
| `business-shorts/8` | Nestlé: From Baby Food to Food Giant | `008-nestle.txt` | 363 |
| `business-shorts/9` | Zomato: From Scanned Menus to Delivery | `009-zomato.txt` | 353 |
| `business-shorts/10` | Grab: The Taxi App Built for South-East Asia | `010-grab.txt` | 365 |
| `business-shorts/11` | KFC: The Colonel Who Started Again at 65 | `011-kfc.txt` | 398 |
| `business-shorts/12` | H&M: The Swedish Shop for Cheap Fashion | `012-h-and-m.txt` | 395 |
| `business-shorts/13` | Facebook: From a Dorm Room to Billions | `013-facebook.txt` | 374 |
| `business-shorts/14` | Stripe: Two Brothers Fix Online Payments | `014-stripe.txt` | 365 |
| `business-shorts/15` | Tesla: The Car Startup Expected to Fail | `015-tesla.txt` | 358 |
| `business-shorts/16` | Barbie: The Doll That Made Mattel | `016-barbie.txt` | 364 |
| `business-shorts/17` | Levi's: Gold Rush Trousers That Became Jeans | `017-levis.txt` | 367 |
| `business-shorts/18` | Heineken: The Brewery Bought by a 22-Year-Old | `018-heineken.txt` | 358 |
| `business-shorts/19` | Paytm: The Wallet That Rode Demonetisation | `019-paytm.txt` | 356 |
| `business-shorts/20` | Shopee: The Game Company That Built a Shop | `020-shopee.txt` | 353 |
| `business-shorts/21` | Domino's: The Pizza Chain That Sold Speed | `021-dominos.txt` | 407 |
| `business-shorts/22` | Costco: The Shop That Charges You to Enter | `022-costco.txt` | 381 |
| `business-shorts/23` | Nvidia: The Graphics Chip Maker Behind AI | `023-nvidia.txt` | 373 |
| `business-shorts/24` | Duolingo: The Owl That Made Learning a Game | `024-duolingo.txt` | 386 |
| `business-shorts/25` | Harley-Davidson: The Bike Built in a Shed | `025-harley-davidson.txt` | 366 |
| `business-shorts/26` | Hasbro: From Pencil Cases to Monopoly | `026-hasbro.txt` | 363 |
| `business-shorts/27` | Ray-Ban: The Glasses Made for Pilots | `027-ray-ban.txt` | 368 |
| `business-shorts/28` | Philips: The Bulb Factory That Lit Up Europe | `028-philips.txt` | 341 |
| `business-shorts/29` | Nykaa: The Banker Who Started Again at Fifty | `029-nykaa.txt` | 362 |
| `business-shorts/30` | Jollibee: The Bee That Beat McDonald's | `030-jollibee.txt` | 347 |

Words include the audio tags. At the studio's 2.85 words a second, 400 words is about 2 minutes 20; the channel outro is added after `close`.

## How they reach the studio

Each script is attached to its item in `maps/business-shorts.json` (`script`: file, title, description). On the next deploy the studio makes a held, unvoiced run for each one. Pick an outro, voice on ElevenLabs, leave the tag pass off (tags are written in). Written and attached with `scripts/attach-scripts.ts`; the brief is the `foundry-scripts` skill.

## Facts: CHECK BEFORE PUBLISHING

Written from well-known company history, not checked against a fetched source. Most worth a look:

- Starbucks: the about $3.8m purchase in 1987; around 40,000 cafes and 80+ countries.
- Google: the turned-down 1999 sale (Excite); the $100,000 cheque in 1998.
- Uber: the Paris 2008 origin is told as the company tells it; first full-year profit 2023.
- Ferrari: the prancing horse permission from the pilot's mother; Enzo's "one car fewer" line told as his saying.
- Rolex: about a million watches a year is an estimate (Rolex publishes no figures).
- Nestlé: the premature baby story is the company's own; the 1970s formula boycott.
- Zomato: first-day demand at the 2021 listing. Grab: the 2018 Uber deal terms (Uber took a stake).
- KFC: about $105 pension cheque; $2m sale in 1964; around 30,000 restaurants.
- Stripe: about $1.4 trillion processed in 2024. Tesla: Christmas Eve 2008 funding; Model Y best-selling car 2023.
- Barbie: about 300,000 sold in the first year. Levi's: the $68 patent fee and 20 May 1873.
- Heineken: the yeast isolated in 1886 by a pupil of Pasteur; second-biggest brewer.
- Paytm: newspaper adverts the morning after demonetisation; 2024 regulator order on its payments bank.
- Costco: the hot dog "I'll kill you" story is told as a story; membership numbers.
- Nvidia: the 2012 image contest on two gaming cards. Ray-Ban: 1936 lens, 1937 name. Philips: the tsar's palace order is told as a story.
- Nykaa: shares nearly doubled on listing day. Jollibee: founded 1975, renamed 1978, McDonald's arrived 1981.
