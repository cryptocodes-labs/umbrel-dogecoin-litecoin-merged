#!/usr/bin/env bash
#
# Generates soqucoin.conf from the environment and starts soqucoind as an
# unprivileged user.
#
# Security notes:
#   * The RPC password is never written to soqucoin.conf. We store a salted
#     HMAC-SHA256 (`rpcauth=`) instead, exactly like Bitcoin Core's rpcauth.py.
#   * The wallet is disabled by default — this is a validating node, not a
#     wallet, and every wallet RPC we don't expose is one we can't get wrong.
#   * soqucoind runs as uid 1000, never as root.
#   * Mining RPCs are on (enablemining=1): a merged-mining pool asks this node
#     for its aux block with createauxblock, and soqucoind serves no mining
#     RPC on mainnet without it (soqucoin doc/pool-integration.md).
#
set -euo pipefail

SOQUCOIN_DATA="${SOQUCOIN_DATA:-/data/.soqucoin}"
# The volume root. The dashboard container mounts the same path read-only and
# reads the credential files from it.
DATA_ROOT="${DATA_ROOT:-$(dirname "${SOQUCOIN_DATA}")}"
CONF="${SOQUCOIN_DATA}/soqucoin.conf"
CUSTOM_CONF="${SOQUCOIN_DATA}/soqucoin-custom.conf"
SECRET_FILE="${DATA_ROOT}/rpc-password"
USER_FILE="${DATA_ROOT}/rpc-user"

RPC_USER="${RPC_USER:-umbrel}"
RPC_PASSWORD="${RPC_PASSWORD:-}"
RPC_PORT="${RPC_PORT:-33389}"
P2P_PORT="${P2P_PORT:-33388}"
RPC_ALLOW_IP="${RPC_ALLOW_IP:-10.0.0.0/8,172.16.0.0/12,127.0.0.1}"

DBCACHE="${DBCACHE:-450}"
MAXCONNECTIONS="${MAXCONNECTIONS:-64}"
MAXUPLOADTARGET="${MAXUPLOADTARGET:-0}"
PRUNE="${PRUNE:-0}"
TXINDEX="${TXINDEX:-0}"
DISABLE_WALLET="${DISABLE_WALLET:-1}"
PAR="${PAR:-0}"
MAXMEMPOOL="${MAXMEMPOOL:-300}"
PEERBLOOMFILTERS="${PEERBLOOMFILTERS:-0}"
ENABLE_MINING="${ENABLE_MINING:-1}"

# Soqucoin Core defaults to 4 RPC threads and a queue of 16. That is enough for
# a dashboard polling every few seconds, but not once something holds a thread
# open — a getblocktemplate longpoll, which mining software uses to learn about
# new blocks instantly, occupies one thread for as long as it waits. Four
# threads then run out and every other caller gets HTTP 500 "Work queue depth
# exceeded". Raising these costs a few hundred kilobytes of stacks.
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

# This script runs as root in a directory soqucoind (uid 1000) can write to.
# A symlink planted there would make root write — or read — wherever it points:
# rpc-user -> /usr/local/bin/healthcheck.sh, then chowned to uid 1000, is root
# in the container on the next healthcheck. So every file this script writes or
# reads is replaced if it is a symlink, and nothing is chowned through one.
drop_symlink() { if [[ -L "$1" ]]; then log "WARNING: removed a symlink at $1"; rm -f "$1"; fi; }

mkdir -p "${SOQUCOIN_DATA}" "${DATA_ROOT}" \
  || die "Cannot create ${SOQUCOIN_DATA} — is the data volume mounted?"
[[ -w "${DATA_ROOT}" ]] || die "${DATA_ROOT} is not writable — is the data volume mounted?"

# ---------------------------------------------------------------------------
# RPC credentials
#
# Preference order:
#   1. RPC_PASSWORD from the environment (Umbrel derives this per-device)
#   2. a password we generated on a previous start and persisted
#   3. a freshly generated 256-bit password
# ---------------------------------------------------------------------------
for f in "${SECRET_FILE}" "${USER_FILE}" "${CONF}" "${CONF}.tmp" "${CUSTOM_CONF}"; do drop_symlink "${f}"; done

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
# soqucoin.conf — regenerated on every start. Never edit it by hand; put your
# own settings in soqucoin-custom.conf, which is appended below.
# ---------------------------------------------------------------------------
{
  echo "# Generated by the Umbrel Soqucoin Node app on container start."
  echo "# Manual edits are lost on restart — use soqucoin-custom.conf instead."
  echo "listen=1"
  echo "server=1"
  echo "printtoconsole=1"
  echo "shrinkdebugfile=1"
  echo "port=${P2P_PORT}"
  echo "rpcport=${RPC_PORT}"
  echo "rpcbind=0.0.0.0"
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
  [[ "${ENABLE_MINING}" == "1" ]] && echo "enablemining=1"
  if [[ -n "${PROXY}" ]]; then
    echo "proxy=${PROXY}"
    echo "onion=${PROXY}"
    echo "proxyrandomize=1"
  fi
  [[ -n "${ONLYNET}" ]] && echo "onlynet=${ONLYNET}"
  if [[ -f "${CUSTOM_CONF}" ]]; then
    echo ""
    echo "# ---- appended from soqucoin-custom.conf ----"
    cat "${CUSTOM_CONF}"
  fi
} > "${CONF}.tmp"
drop_symlink "${CONF}"
mv "${CONF}.tmp" "${CONF}"
chmod 600 "${CONF}"

# ---------------------------------------------------------------------------
# Ownership. Only walk the blockchain when it is actually
# owned by the wrong user — otherwise fix just the files we wrote.
# ---------------------------------------------------------------------------
if [[ "$(stat -c %u "${SOQUCOIN_DATA}" 2>/dev/null || echo 1000)" != "1000" ]]; then
  log "Fixing ownership of ${SOQUCOIN_DATA} — this runs once and may take a while…"
  # Tolerate failure: on a filesystem that refuses chown (some network mounts)
  # or when we are not root, soqucoind may still be perfectly able to read and
  # write its own data. Refusing to start would be the worse outcome.
  chown -hR 1000:1000 "${DATA_ROOT}" \
    || log "WARNING: could not change ownership of ${DATA_ROOT}; continuing anyway"
else
  chown -h 1000:1000 "${DATA_ROOT}" "${CONF}" "${USER_FILE}" 2>/dev/null || true
  if [[ -f "${SECRET_FILE}" ]]; then chown -h 1000:1000 "${SECRET_FILE}" 2>/dev/null || true; fi
fi

log "Soqucoin Core $(soqucoind --version | head -1 | sed 's/.*version //')"
log "datadir=${SOQUCOIN_DATA} rpcport=${RPC_PORT} p2p=${P2P_PORT} prune=${PRUNE} txindex=${TXINDEX} wallet=$([[ "${DISABLE_WALLET}" == "1" ]] && echo disabled || echo enabled)"

if [[ "${1:-}" == "soqucoind" ]]; then
  shift
  ARGS=(-datadir="${SOQUCOIN_DATA}" -conf="${CONF}")
  if [[ -n "${EXTRA_ARGS}" ]]; then
    read -ra _extra <<< "${EXTRA_ARGS}"
    ARGS+=("${_extra[@]}")
  fi
  # The daemon has no use for the plain-text password; keep it out of its
  # environment (readable at /proc/<pid>/environ by its own uid).
  unset RPC_PASSWORD
  exec gosu soqucoin soqucoind "${ARGS[@]}" "$@"
fi

exec gosu soqucoin "$@"
