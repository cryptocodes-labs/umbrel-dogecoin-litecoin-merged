#!/bin/bash
#
# Starts the PUBLIC DOGE+LTC port on the Umbrel as its own container, next to
# the existing doge-dogecoin-solo app (which is not touched).
#
#   stratum  : host 22559  (VPS forwards public 3335 here)
#   dashboard: host 22561  (LAN only, do not forward)
#
# Run on the Umbrel after copying images/stratum to ~/doge-public-src:
#   bash ~/deploy-public-umbrel.sh
#
set -euo pipefail

SRC=~/doge-public-src
IMG=cryptocode/doge-public:1.8.0
APP=doge-dogecoin-solo_app_1
DIR=~/doge-public

[ -f "$SRC/Dockerfile" ] || { echo "Missing $SRC/Dockerfile — copy images/stratum there first"; exit 1; }
sudo docker inspect "$APP" >/dev/null || { echo "The DOGE app ($APP) is not running"; exit 1; }

echo "== building $IMG"
sudo docker build -q -t "$IMG" "$SRC"

mkdir -p "$DIR/data"
# Node connection details and the fee addresses come from the running app, so
# nothing secret is typed or shown here. Everything else is set explicitly.
# That includes Pepecoin: set PEP_* in the app's .env and this port follows;
# leave them out and it runs Litecoin + Dogecoin exactly as before.
sudo docker inspect "$APP" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E '^(RPC_HOST|RPC_PORT|RPC_USER|RPC_PASSWORD|LTC_RPC_HOST|LTC_RPC_PORT|LTC_RPC_USER|LTC_RPC_PASSWORD|PAYOUT_ADDRESS|LTC_PAYOUT_ADDRESS|PEP_RPC_HOST|PEP_RPC_PORT|PEP_RPC_USER|PEP_RPC_PASSWORD|PEP_PAYOUT_ADDRESS)=' \
  > "$DIR/env"
cat >> "$DIR/env" <<'EOF'
MERGED_MINING=1
PUBLIC_MERGED=1
POOL_FEE_PERCENT=1
MAX_PAYOUT_VARIANTS=64
# All public traffic reaches the pool from ONE address (HAProxy on the VPS via
# Tailscale), so the per-IP cap must not be the home default of 8; HAProxy
# already limits per real client IP.
MAX_CONNECTIONS=512
MAX_CONNECTIONS_PER_IP=512
MINING_PROFILE=home
LOCK_PAYOUT_ADDRESS=0
COINBASE_TAG=/cryptocode/
AUX_LONGPOLL=1
STATS_PATH=/data/stats.json
EOF
chmod 600 "$DIR/env"
for k in RPC_PASSWORD LTC_RPC_PASSWORD PAYOUT_ADDRESS LTC_PAYOUT_ADDRESS; do
  grep -q "^$k=." "$DIR/env" || { echo "Could not read $k from $APP"; exit 1; }
done

NET=$(sudo docker inspect "$APP" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')

sudo docker rm -f doge-public >/dev/null 2>&1 || true
sudo docker run -d --name doge-public --restart unless-stopped --network "$NET" \
  -p 22559:3333 -p 22561:3000 \
  --env-file "$DIR/env" -v "$DIR/data:/data" \
  --read-only --tmpfs /tmp:size=8m --security-opt no-new-privileges:true \
  --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID \
  "$IMG" >/dev/null
echo "== container started, waiting 20s"
sleep 20
sudo docker logs doge-public 2>&1 | grep -E 'PUBLIC merged|Pepecoin|stratum listening|new merged job|error|Error|refus' | tail -8
