#!/usr/bin/env bash
# Creates the three new channels on production: account, profile, avatar, banner,
# publishing token. Run it yourself, in Git Bash, from the Foundry repo root:
#
#   bash scripts/setup-new-channels.sh
#
# It asks for the platform admin login once (not stored, not echoed). Safe to run
# again: channel-setup reuses an account it already recorded. Art must already be
# on the volume at art/<id>/{avatar,cover}.supplied.png.
set -euo pipefail

read -rp 'Platform admin email: ' ADMIN_EMAIL
read -rsp 'Platform admin password: ' ADMIN_PASSWORD
echo

for pair in spellbound:spellbound hidden-history:hiddenhistory unknown-hour:unknownhour; do
  id=${pair%%:*}
  handle=${pair##*:}
  echo "=== $id (@$handle)"

  railway ssh -s foundry "cd /app && AUDIOVIBE_ADMIN_EMAIL='$ADMIN_EMAIL' AUDIOVIBE_ADMIN_PASSWORD='$ADMIN_PASSWORD' npx ts-node -T src/cli.ts channel-setup --show $id --yes"

  token=$(cd ../Audio-Vibe/services/api && railway ssh --environment production --service @audiovibe/server \
    "cd /app && node dist/scripts/mintIngestToken.js --username $handle" | grep -oE 'eyJ[A-Za-z0-9._-]+' | tail -1)
  if [ -z "$token" ]; then
    echo "no token came back for $handle; stopping" >&2
    exit 1
  fi

  railway ssh -s foundry "cd /app && npx ts-node -T src/cli.ts channel-token --show $id --token '$token'"
done

echo 'Done. All three channels can publish once their voices are set.'
