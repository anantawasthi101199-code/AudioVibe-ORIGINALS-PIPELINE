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

## Published runs move to R2

Once a run is published, every file in its folder is uploaded to the private
R2 bucket in `FOUNDRY_ARCHIVE_BUCKET` (under `runs/<run id>/`, with a history
entry at `index/<run id>.json`). After R2 confirms each file at its exact size,
the run's AUDIO is removed from the volume; its text and cover stay, so every
page and the history work as before, and the audio plays and downloads from R2
through one-hour private links. A sweep on start-up and every 30 minutes
catches anything a publish did not archive, and keeps `state/` (voices,
catalogue, series) current.

Settings: `FOUNDRY_ARCHIVE_ENDPOINT` (https://<account id>.r2.cloudflarestorage.com),
`FOUNDRY_ARCHIVE_BUCKET`, `FOUNDRY_ARCHIVE_ACCESS_KEY_ID`,
`FOUNDRY_ARCHIVE_SECRET_ACCESS_KEY`. Unset, archiving is off.

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
