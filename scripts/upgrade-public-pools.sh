#!/bin/bash
#
# Moves the public (3335) and rented (3339) LTC + DOGE containers to a new
# stratum image with exactly the settings, ports and data they run with now.
# Run on the Umbrel: bash ~/upgrade-public-pools.sh
#
# The image is the one CI tested and published, pinned by digest (the same as
# doge-dogecoin-solo/docker-compose.yml). Per container: the current settings
# are saved, the new container is started, and if the pool does not answer
# within 60 s the old image is started again. The rented port goes first; the
# public one is only touched when that worked.
#
# ADD_SOQ=1 bash ~/upgrade-public-pools.sh also turns Soqucoin on for both
# ports (stratum 1.10+): its node connection and the fee address are copied
# from the running DOGE+LTC+PEP+SOQ app, as deploy-public-umbrel.sh copies the
# others. Each public miner who adds an sq1p address to its username is then
# paid 99% of a Soqucoin block straight from the coinbase; the app's
# SOQ_PAYOUT_ADDRESS gets the 1%. A container that already has SOQ_* keeps its
# own. Without ADD_SOQ nothing about Soqucoin changes.
#
set -uo pipefail
APP=doge-dogecoin-solo_app_1
NEW=ghcr.io/cryptocodes-labs/umbrel-dogecoin-stratum:1.9.3@sha256:6fe2810508ecbac13abbe228872098533b9aa509afccd48f388aedd24105085e
STAMP=$(date +%Y%m%d-%H%M%S)
echo "== pulling $NEW"
sudo docker pull -q "$NEW" || { echo "pull failed; nothing changed"; exit 1; }

upgrade() {
  local c="$1" dir="$2" sport="$3" wport="$4"
  echo; echo "== $c"
  # The saved settings hold the RPC passwords: readable by their owner only.
  sudo docker inspect "$c" | (umask 077; cat > "$dir/inspect-before-upgrade-$STAMP.json") \
    || { echo "container $c not found"; return 1; }
  local old net
  old=$(sudo docker inspect "$c" --format "{{.Config.Image}}")
  net=$(sudo docker inspect "$c" --format "{{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}} {{end}}" | awk "{print \$1}")
  # The running container's environment, minus what the image itself sets.
  local envf="$dir/env-$STAMP"
  sudo sh -c "umask 077; docker inspect $c --format \"{{range .Config.Env}}{{println .}}{{end}}\" | grep -vE \"^(PATH|NODE_VERSION|YARN_VERSION|NODE_ENV)=\" | grep -v \"^\$\" > $envf"
  if [ "${ADD_SOQ:-0}" = 1 ]; then
    if sudo grep -q "^SOQ_RPC_HOST=." "$envf" && sudo grep -q "^SOQ_PAYOUT_ADDRESS=." "$envf"; then
      echo "Soqucoin: $c already has a node and a fee address; kept"
    else
      # Empty SOQ_* lines (deploy-public-umbrel.sh copies them as the app has
      # them, filled or not, and a run before SOQ was set leaves them too)
      # would shadow the ones added below: drop every SOQ_ line first.
      sudo sed -i "/^SOQ_/d" "$envf"
      sudo sh -c "umask 077; docker inspect $APP --format \"{{range .Config.Env}}{{println .}}{{end}}\" | grep -E \"^SOQ_(RPC_HOST|RPC_PORT|RPC_USER|RPC_PASSWORD|PAYOUT_ADDRESS)=\" >> $envf"
      if sudo grep -q "^SOQ_RPC_HOST=." "$envf" && sudo grep -q "^SOQ_PAYOUT_ADDRESS=." "$envf"; then
        echo "Soqucoin: node and fee address taken from $APP"
      else
        echo "ADD_SOQ=1, but $APP has no SOQ_RPC_HOST and SOQ_PAYOUT_ADDRESS: Soqucoin stays off on $c"
      fi
    fi
  fi
  echo "old image: $old  network: $net  ports: $sport (stratum) $wport (dashboard)"
  run() {
    sudo docker run -d --name "$c" --restart unless-stopped --network "$net" \
      -p "$sport:3333" -p "$wport:3000" --env-file "$envf" -v "$dir/data:/data" \
      --read-only --tmpfs /tmp:size=8m --security-opt no-new-privileges:true \
      --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID "$1" >/dev/null
  }
  sudo docker rm -f "$c" >/dev/null
  # A failed start can leave a created-but-stopped container with this name;
  # without removing it, starting the old image would fail on the name too.
  if ! run "$NEW"; then
    echo "start failed, back to $old"
    sudo docker rm -f "$c" >/dev/null 2>&1
    run "$old"
    return 1
  fi
  for i in $(seq 1 30); do
    sleep 2
    if curl -s -m 3 "http://127.0.0.1:$wport/api/status" | grep -q "\"ok\":true"; then
      echo "OK: $c runs the new image and answers (after $((i*2)) s)"
      sudo docker logs "$c" 2>&1 | grep -E "PUBLIC merged|Pepecoin|Soqucoin|stratum listening|new merged job" | tail -5
      return 0
    fi
  done
  echo "NO answer within 60 s; back to $old"
  sudo docker logs "$c" 2>&1 | tail -15
  sudo docker rm -f "$c" >/dev/null; run "$old"
  return 1
}

upgrade doge-public-rental "$HOME/doge-public-rental" 22562 22563 || { echo "rented port failed; doge-public not touched"; exit 1; }
upgrade doge-public "$HOME/doge-public" 22559 22561 || exit 1
echo; echo "== done: both ports run the new image"
