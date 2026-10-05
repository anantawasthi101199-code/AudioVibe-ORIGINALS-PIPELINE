# Hosting the studio

Since 2026-10-05 the studio runs on Railway at **https://foundry.audiovibe.co**,
and inside the admin dashboard on its **Foundry** tab.

## Where it lives

- Railway project `audiovibe-foundry`, service `foundry`, built from this repo's
  `Dockerfile`. **Every push to `main` deploys it**, through a deploy trigger on
  `main`. If pushes stop deploying, check the trigger exists: a service created
  before Railway had GitHub access to the repo gets the repo but no trigger.
- Everything the studio writes (runs/, art/, music/, voices.json,
  catalogue.json, series.json, accounts.json, bibles/, seasons/) is on the
  volume `foundry-volume` at `/data`. `scripts/start.sh` links each into place,
  so a deploy never loses a run.
- Config the repo owns (personas, beatsheets, topics, desks, schedule) comes
  from the image, so a push updates it.

## Who can sign in

`FOUNDRY_USERS` on the Railway service, as `name:password` pairs separated by
commas. Each person signs in as themselves and the run journal records who
approved and published what. Changing any password signs everybody out.

## The page may only be framed by the admin dashboard

`FOUNDRY_FRAME_ANCESTORS` (default `https://admin.audiovibe.co`).

## One studio only

Do not run a second studio against production with its own copy of the data:
the publish-once guard reads that copy, so two studios can publish the same
episode twice. The local studio is for development against staging.
