#!/usr/bin/env bash
# Start the hosted studio with everything it writes on the volume.
#
# THE STUDIO WRITES INTO ITS OWN FOLDER (runs/, art/, voices.json and so on),
# which in a container is thrown away on every deploy. Each of those paths is
# moved to the volume the first time and linked from then on, so the code does
# not need to know it is hosted.
set -euo pipefail

DATA="${FOUNDRY_DATA_DIR:-/data}"
mkdir -p "$DATA"

# What the studio writes while it runs. Config the repo owns (personas,
# beatsheets, topics, schedule) stays in the image, so a deploy updates it.
for p in runs art music bibles seasons voices.json catalogue.json series.json accounts.json release.log; do
  if [ ! -e "$DATA/$p" ] && [ -e "/app/$p" ]; then
    mv "/app/$p" "$DATA/$p"           # first boot: the image's copy seeds the volume
  fi
  rm -rf "/app/$p"
  ln -s "$DATA/$p" "/app/$p"
done
mkdir -p "$DATA/runs" "$DATA/art" "$DATA/music"

# Railway says which port; locally it stays 4317.
export FOUNDRY_PORT="${PORT:-4317}"

cd /app
# Run directly (not through npx) so the stop signal reaches the studio, which
# then waits for work in progress before exiting. See server/index.ts.
exec node_modules/.bin/ts-node --transpile-only src/cli.ts studio
