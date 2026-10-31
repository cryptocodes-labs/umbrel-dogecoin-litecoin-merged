#!/usr/bin/env bash
#
# Generates litecoin.conf from the environment and starts litecoind as an
# unprivileged user.
#
# Security notes:
#   * The RPC password is never written to litecoin.conf. We store a salted
#     HMAC-SHA256 (`rpcauth=`) instead, exactly like Bitcoin Core's rpcauth.py.
#   * The wallet is disabled by default — this is a validating node, not a
#     wallet, and every wallet RPC we don't expose is one we can't get wrong.
#   * litecoind runs as uid 1000, never as root.
#
set -euo pipefail

LITECOIN_DATA="${LITECOIN_DATA:-/data/.litecoin}"
# The volume root. The dashboard container mounts the same path read-only and
# reads the credential files from it.
DATA_ROOT="${DATA_ROOT:-$(dirname "${LITECOIN_DATA}")}"
CONF="${LITECOIN_DATA}/litecoin.conf"
CUSTOM_CONF="${LITECOIN_DATA}/litecoin-custom.conf"
SECRET_FILE="${DATA_ROOT}/rpc-password"
USER_FILE="${DATA_ROOT}/rpc-user"

RPC_USER="${RPC_USER:-umbrel}"
RPC_PASSWORD="${RPC_PASSWORD:-}"
RPC_PORT="${RPC_PORT:-9332}"
P2P_PORT="${P2P_PORT:-9333}"
RPC_ALLOW_IP="${RPC_ALLOW_IP:-10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.1}"

# main | test | regtest. Anything else is a typo, and a typo here would quietly
# put the node on a different chain than the one the app's ports and data
# directory are set up for.
NETWORK="${NETWORK:-main}"

DBCACHE="${DBCACHE:-450}"
MAXCONNECTIONS="${MAXCONNECTIONS:-64}"
MAXUPLOADTARGET="${MAXUPLOADTARGET:-0}"
PRUNE="${PRUNE:-0}"
TXINDEX="${TXINDEX:-0}"
DISABLE_WALLET="${DISABLE_WALLET:-1}"
PAR="${PAR:-0}"
MAXMEMPOOL="${MAXMEMPOOL:-300}"
PEERBLOOMFILTERS="${PEERBLOOMFILTERS:-0}"

# Litecoin Core defaults to 4 RPC threads and a queue of 16. That is enough for
# a dashboard polling every few seconds, but not once something holds a thread
# open — a getblocktemplate longpoll, which merge-mining software uses to learn
# about new parent blocks instantly, occupies one thread for as long as it
# waits. Four threads then run out and every other caller gets HTTP 500 "Work
# queue depth exceeded". Raising these costs a few hundred kilobytes of stacks.
RPC_THREADS="${RPC_THREADS:-8}"
RPC_WORKQUEUE="${RPC_WORKQUEUE:-64}"

TOR_ENABLED="${TOR_ENABLED:-0}"
TOR_ONLY="${TOR_ONLY:-0}"
TOR_PROXY_IP="${TOR_PROXY_IP:-}"
TOR_PROXY_PORT="${TOR_PROXY_PORT:-9050}"
PROXY="${PROXY:-}"
ONLYNET="${ONLYNET:-}"
EXTRA_ARGS="${EXTRA_ARGS:-}"

log() { printf '[entrypoint] %s\n' "$*"; }
die() { printf '[entrypoint] ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Validation — fail loudly at start rather than mysteriously at runtime.
# ---------------------------------------------------------------------------
is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }

for pair in "RPC_PORT:${RPC_PORT}" "P2P_PORT:${P2P_PORT}" "DBCACHE:${DBCACHE}" \
            "MAXCONNECTIONS:${MAXCONNECTIONS}" "MAXUPLOADTARGET:${MAXUPLOADTARGET}" \
            "PRUNE:${PRUNE}" "PAR:${PAR}" "MAXMEMPOOL:${MAXMEMPOOL}" \
            "RPC_THREADS:${RPC_THREADS}" "RPC_WORKQUEUE:${RPC_WORKQUEUE}"; do
  name="${pair%%:*}"; value="${pair#*:}"
  is_uint "${value}" || die "${name} must be a whole number, got '${value}'"
done

if [[ "${PRUNE}" != "0" && "${PRUNE}" -lt 550 ]]; then
  die "PRUNE must be 0 (disabled) or at least 550 (MiB). Got '${PRUNE}'."
fi
if [[ "${PRUNE}" != "0" && "${TXINDEX}" == "1" ]]; then
  die "PRUNE and TXINDEX are mutually exclusive — a pruned node cannot keep a full transaction index."
fi
# Values that become whole config lines. A newline in any of them would add a
# line of its own (blocknotify=…, say), so only the characters an address,
# a port, a CIDR range or a network name needs are allowed.
for pair in "RPC_ALLOW_IP:${RPC_ALLOW_IP}" "PROXY:${PROXY}" "ONLYNET:${ONLYNET}" \
            "TOR_PROXY_IP:${TOR_PROXY_IP}" "TOR_PROXY_PORT:${TOR_PROXY_PORT}"; do
  name="${pair%%:*}"; value="${pair#*:}"
  [[ "${value}" =~ ^[A-Za-z0-9.:/,_-]*$ ]] || die "${name} may only contain letters, digits and . : / , _ -"
done
if [[ "${RPC_USER}" =~ [^A-Za-z0-9_.-] ]]; then
  die "RPC_USER may only contain letters, digits, dot, dash and underscore."
fi

# Litecoin Core's own name for testnet in a config file is `test`, not
# `testnet` — a `[testnet]` header is merely warned about and then ignored, so
# accepting the friendlier spelling here and translating it is worth the four
# lines.
case "${NETWORK}" in
  main)             CONF_SECTION="";        NET_FLAG="" ;;
  test|testnet)     CONF_SECTION="test";    NET_FLAG="testnet=1" ;;
  regtest)          CONF_SECTION="regtest"; NET_FLAG="regtest=1" ;;
  *) die "NETWORK must be main, test or regtest. Got '${NETWORK}'." ;;
esac

mkdir -p "${LITECOIN_DATA}" "${DATA_ROOT}" \
  || die "Cannot create ${LITECOIN_DATA} — is the data volume mounted?"
[[ -w "${DATA_ROOT}" ]] || die "${DATA_ROOT} is not writable — is the data volume mounted?"

# This script runs as root in a directory the daemon (uid 1000) can write to.
# A symlink planted there would make root write — or read — wherever it points:
# rpc-user -> /usr/local/bin/healthcheck.sh, then chowned to uid 1000, is root
# in the container on the next healthcheck. So every file this script writes or
# reads is replaced if it is a symlink, and nothing is chowned through one.
drop_symlink() { if [[ -L "$1" ]]; then log "WARNING: removed a symlink at $1"; rm -f "$1"; fi; }
for f in "${SECRET_FILE}" "${USER_FILE}" "${CONF}" "${CONF}.tmp" "${CUSTOM_CONF}"; do drop_symlink "${f}"; done

# A section header in the user's own file would re-scope every generated line
# that follows it onto one chain — for example a stray `[test]` would leave the
# mainnet node with no rpcauth at all, listening with authentication disabled
# until it fails to start. Refuse instead of producing that config.
if [[ -f "${CUSTOM_CONF}" ]] && grep -qE '^[[:space:]]*\[' "${CUSTOM_CONF}"; then
  die "litecoin-custom.conf must not contain [section] headers — this app generates the network section itself."
fi

# ---------------------------------------------------------------------------
# RPC credentials
#
# Preference order:
#   1. RPC_PASSWORD from the environment (Umbrel derives this per-device)
#   2. a password we generated on a previous start and persisted
#   3. a freshly generated 256-bit password
# ---------------------------------------------------------------------------
generated=0
if [[ -z "${RPC_PASSWORD}" ]]; then
  if [[ -s "${SECRET_FILE}" ]]; then
    RPC_PASSWORD="$(cat "${SECRET_FILE}")"
  else
    RPC_PASSWORD="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    log "No RPC_PASSWORD supplied — generated one and stored it in ${SECRET_FILE}"
  fi
  generated=1
fi
[[ -n "${RPC_PASSWORD}" ]] || die "Could not determine an RPC password."

umask 077
if [[ "${generated}" == "1" ]]; then
  # Only persist plaintext when we own the secret. When Umbrel supplies it via
  # the environment, both containers already have it and nothing hits the disk.
  rm -f "${SECRET_FILE}"
  printf '%s' "${RPC_PASSWORD}" > "${SECRET_FILE}"
else
  rm -f "${SECRET_FILE}"
fi
rm -f "${USER_FILE}"
printf '%s' "${RPC_USER}" > "${USER_FILE}"

# rpcauth=<user>:<salt>$<HMAC-SHA256(key=salt, msg=password)>
RPC_SALT="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
RPC_HMAC="$(printf '%s' "${RPC_PASSWORD}" | openssl dgst -sha256 -hmac "${RPC_SALT}" -r | cut -d' ' -f1)"
[[ ${#RPC_HMAC} -eq 64 ]] || die "Failed to compute the rpcauth HMAC."

# ---------------------------------------------------------------------------
# Tor
# ---------------------------------------------------------------------------
if [[ "${TOR_ENABLED}" == "1" ]]; then
  [[ -n "${TOR_PROXY_IP}" ]] || die "TOR_ENABLED=1 but TOR_PROXY_IP is empty."
  PROXY="${PROXY:-${TOR_PROXY_IP}:${TOR_PROXY_PORT}}"
  log "Routing outbound connections through Tor at ${PROXY}"
  if [[ "${TOR_ONLY}" == "1" ]]; then
    ONLYNET="${ONLYNET:-onion}"
    log "Tor-only mode: clearnet peers disabled"
  fi
fi

# ---------------------------------------------------------------------------
# litecoin.conf — regenerated on every start. Never edit it by hand; put your
# own settings in litecoin-custom.conf, which is merged in below.
#
# Two layout rules come straight from how Litecoin Core parses this file:
#
#   1. When a setting appears twice, the FIRST occurrence wins. The user's file
#      is therefore written ABOVE the generated block, not appended after it —
#      appending would make every custom value that collides with one of ours
#      silently do nothing.
#   2. -port, -rpcport, -rpcbind, -bind, -addnode and -connect are network
#      scoped. On testnet or regtest, Litecoin Core 0.21 REFUSES TO START if
#      they sit at the top level ("Config setting for -rpcport only applied on
#      test network when in [test] section"), so they go last, under the
#      section header for the chain we are actually on. Dogecoin Core 1.14 has
#      no such rule, which is why its entrypoint can write one flat file.
# ---------------------------------------------------------------------------
{
  echo "# Generated by the Umbrel Litecoin Node app on container start."
  echo "# Manual edits are lost on restart — use litecoin-custom.conf instead."
  if [[ -f "${CUSTOM_CONF}" ]]; then
    echo ""
    echo "# ---- merged from litecoin-custom.conf (wins on conflicts) ----"
    cat "${CUSTOM_CONF}"
    echo "# ---- end of litecoin-custom.conf ----"
    echo ""
  fi
  # testnet=/regtest= select the chain and are rejected inside a section, so
  # they belong here at the top level.
  [[ -n "${NET_FLAG}" ]] && echo "${NET_FLAG}"
  echo "listen=1"
  echo "server=1"
  echo "printtoconsole=1"
  echo "shrinkdebugfile=1"
  echo "rpcauth=${RPC_USER}:${RPC_SALT}\$${RPC_HMAC}"
  IFS=',' read -ra _allow <<< "${RPC_ALLOW_IP}"
  for cidr in "${_allow[@]}"; do
    [[ -n "${cidr}" ]] && echo "rpcallowip=${cidr}"
  done
  echo "rpcthreads=${RPC_THREADS}"
  echo "rpcworkqueue=${RPC_WORKQUEUE}"
  echo "dbcache=${DBCACHE}"
  echo "maxconnections=${MAXCONNECTIONS}"
  echo "maxuploadtarget=${MAXUPLOADTARGET}"
  echo "maxmempool=${MAXMEMPOOL}"
  [[ "${PAR}" != "0" ]] && echo "par=${PAR}"
  [[ "${PRUNE}" != "0" ]] && echo "prune=${PRUNE}"
  [[ "${TXINDEX}" == "1" ]] && echo "txindex=1"
  [[ "${DISABLE_WALLET}" == "1" ]] && echo "disablewallet=1"
  [[ "${PEERBLOOMFILTERS}" == "1" ]] && echo "peerbloomfilters=1"
  if [[ -n "${PROXY}" ]]; then
    echo "proxy=${PROXY}"
    echo "onion=${PROXY}"
    echo "proxyrandomize=1"
  fi
  [[ -n "${ONLYNET}" ]] && echo "onlynet=${ONLYNET}"

  # Network-scoped settings. On mainnet there is no section to open — the top
  # level IS mainnet.
  echo ""
  [[ -n "${CONF_SECTION}" ]] && echo "[${CONF_SECTION}]"
  echo "port=${P2P_PORT}"
  echo "rpcport=${RPC_PORT}"
  echo "rpcbind=0.0.0.0"
} > "${CONF}.tmp"
drop_symlink "${CONF}"
mv "${CONF}.tmp" "${CONF}"
chmod 600 "${CONF}"

# ---------------------------------------------------------------------------
# Ownership. Only walk the (potentially 100 GB) blockchain when it is actually
# owned by the wrong user — otherwise fix just the files we wrote.
# ---------------------------------------------------------------------------
if [[ "$(stat -c %u "${LITECOIN_DATA}" 2>/dev/null || echo 1000)" != "1000" ]]; then
  log "Fixing ownership of ${LITECOIN_DATA} — this runs once and may take a while…"
  # Tolerate failure: on a filesystem that refuses chown (some network mounts)
  # or when we are not root, litecoind may still be perfectly able to read and
  # write its own data. Refusing to start would be the worse outcome.
  chown -hR 1000:1000 "${DATA_ROOT}" \
    || log "WARNING: could not change ownership of ${DATA_ROOT}; continuing anyway"
else
  chown -h 1000:1000 "${DATA_ROOT}" "${CONF}" "${USER_FILE}" 2>/dev/null || true
  if [[ -f "${SECRET_FILE}" ]]; then chown -h 1000:1000 "${SECRET_FILE}" 2>/dev/null || true; fi
fi

log "Litecoin Core $(litecoind --version | head -1 | sed 's/.*version //')"
log "datadir=${LITECOIN_DATA} network=${NETWORK} rpcport=${RPC_PORT} p2p=${P2P_PORT} prune=${PRUNE} txindex=${TXINDEX} wallet=$([[ "${DISABLE_WALLET}" == "1" ]] && echo disabled || echo enabled)"

if [[ "${1:-}" == "litecoind" ]]; then
  shift
  ARGS=(-datadir="${LITECOIN_DATA}" -conf="${CONF}")
  if [[ -n "${EXTRA_ARGS}" ]]; then
    read -ra _extra <<< "${EXTRA_ARGS}"
    ARGS+=("${_extra[@]}")
  fi
  # The daemon has no use for the plain-text password; keep it out of its
  # environment (readable at /proc/<pid>/environ by its own uid).
  unset RPC_PASSWORD
  exec gosu litecoin litecoind "${ARGS[@]}" "$@"
fi

exec gosu litecoin "$@"
