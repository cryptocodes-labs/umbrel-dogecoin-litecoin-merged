#!/usr/bin/env bash
# shellcheck disable=SC2015
#   `cond && ok "…" || bad "…"` is safe here: ok() and bad() always return 0.
#
# Builds each node image and runs it the way its umbrelOS app does — read-only
# image, tmpfs /tmp, pids limit, every capability dropped but the five the
# entrypoint needs, no-new-privileges — on regtest, then checks:
#
#   * the node starts and answers RPC with the configured password;
#   * the healthcheck passes when run as the daemon's own user (gosu), which is
#     how the compose files now run it;
#   * the daemon runs as uid 1000, not root;
#   * the image really is read-only: nothing can be written outside /data.
#
# This is the proof that the hardening in the compose files does not stop a
# node from starting. Needs Docker; CI runs it.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
info()  { printf '\033[2m%s\033[0m\n' "$*"; }
ok()    { PASS=$((PASS + 1)); green "  ✓ $1"; }
bad()   { FAIL=$((FAIL + 1)); red "  ✗ $1"; if [[ $# -gt 1 ]]; then printf '      %s\n' "$2"; fi; return 0; }

command -v docker >/dev/null || { info "skipped: no docker"; exit 0; }

# name | image dir | daemon user | data var | cli var | cli
NODES=(
  "dogecoin|core|dogecoin|DOGECOIN_DATA|DOGECOIN_CLI_ARGS|dogecoin-cli"
  "litecoin|ltc-core|litecoin|LITECOIN_DATA|LITECOIN_CLI_ARGS|litecoin-cli"
  "pepecoin|pep-core|pepecoin|PEPECOIN_DATA|PEPECOIN_CLI_ARGS|pepecoin-cli"
  "soqucoin|soq-core|soqucoin|SOQUCOIN_DATA|SOQUCOIN_CLI_ARGS|soqucoin-cli"
)

cleanup() { for n in "${NODES[@]}"; do docker rm -f "hardened-${n%%|*}" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

for entry in "${NODES[@]}"; do
  IFS='|' read -r name dir user datavar clivar cli <<< "${entry}"
  info "${name}"
  img="hardened-test/${name}:ci"
  if ! docker build -q -t "${img}" "${REPO_ROOT}/images/${dir}" >/dev/null; then
    bad "${name}: the image builds"; continue
  fi
  vol="$(mktemp -d)"
  chmod 777 "${vol}"
  c="hardened-${name}"
  docker run -d --name "${c}" \
    --read-only --tmpfs /tmp:size=16m,mode=1777 --pids-limit 256 \
    --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE \
    --security-opt no-new-privileges:true \
    -v "${vol}:/data" \
    -e RPC_PASSWORD=hardened-password -e RPC_USER=umbrel -e DBCACHE=32 \
    -e EXTRA_ARGS="-regtest -listen=0 -dnsseed=0" -e "${clivar}=-regtest" \
    "${img}" >/dev/null || { bad "${name}: the container starts"; continue; }

  healthy=0
  for _ in $(seq 1 60); do
    if docker exec "${c}" gosu "${user}" /usr/local/bin/healthcheck.sh >/dev/null 2>&1; then healthy=1; break; fi
    sleep 2
  done
  [[ ${healthy} -eq 1 ]] && ok "${name}: starts read-only and the healthcheck passes as ${user}" \
    || bad "${name}: starts read-only and the healthcheck passes as ${user}" "$(docker logs "${c}" 2>&1 | tail -8)"

  # A real RPC answer, through the cli and the generated config.
  conf="/data/.${name}/${name}.conf"
  if docker exec "${c}" gosu "${user}" "${cli}" -conf="${conf}" -datadir="/data/.${name}" -regtest \
       -rpcuser=umbrel -rpcpassword=hardened-password getblockchaininfo 2>/dev/null | grep -q '"chain": *"regtest"'; then
    ok "${name}: answers RPC with the configured password"
  else
    bad "${name}: answers RPC with the configured password"
  fi

  pid_user="$(docker top "${c}" -eo user,comm 2>/dev/null | awk -v d="${name}d" '$2 == d {print $1}' | head -1)"
  [[ -n "${pid_user}" && "${pid_user}" != "root" ]] && ok "${name}: the daemon runs as ${pid_user}, not root" \
    || bad "${name}: the daemon runs as an unprivileged user" "$(docker top "${c}" -eo user,comm 2>&1 | head -5)"

  if docker exec "${c}" sh -c 'echo x > /usr/local/bin/x' >/dev/null 2>&1; then
    bad "${name}: the image is read-only"
  else
    ok "${name}: the image is read-only (nothing can be written next to the programs)"
  fi
  # Find the daemon by its command line (the slim image has no pidof) and
  # look in its environment.
  docker exec "${c}" sh -c "for p in /proc/[0-9]*; do if tr '\\0' ' ' < \$p/cmdline 2>/dev/null | grep -q '^${name}d '; then grep -q hardened-password \$p/environ && exit 0; fi; done; exit 1" 2>/dev/null \
    && bad "${name}: the daemon's environment carries the RPC password" \
    || ok "${name}: the daemon's environment does not carry the RPC password"

  docker rm -f "${c}" >/dev/null 2>&1 || true
  rm -rf "${vol}" 2>/dev/null || true
done

echo
if [[ ${FAIL} -eq 0 ]]; then green "${PASS} checks passed, 0 failed"; exit 0
else red "${PASS} passed, ${FAIL} FAILED"; exit 1; fi
