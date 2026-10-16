#!/usr/bin/env bash
#
# Healthy = the RPC server answers.
#
# During the first minutes of a start pepecoind is still loading the block index
# and answers every RPC with error -28 ("Loading block index…"). That is a
# healthy, expected state — a node with a 150 GB chain can sit there for a
# while — so the warm-up errors count as success, and only a completely
# unreachable RPC endpoint counts as unhealthy.
#
# Authentication: the config carries an rpcauth HMAC rather than a plaintext
# password, so pepecoin-cli cannot read credentials out of it. We pass the same
# password the daemon was configured with when it is in the environment, and
# fall back to the daemon's own cookie file otherwise.
#
# Note: Pepecoin Core 1.1 (Dogecoin Core 1.14 underneath) has no `uptime` RPC. getbestblockhash is the cheapest
# call that proves there is a live chain tip.
set -uo pipefail

PEPECOIN_DATA="${PEPECOIN_DATA:-/data/.pepecoin}"
DATA_ROOT="${DATA_ROOT:-$(dirname "${PEPECOIN_DATA}")}"
CONF="${PEPECOIN_DATA}/pepecoin.conf"

ARGS=(-datadir="${PEPECOIN_DATA}" -conf="${CONF}" -rpcconnect=127.0.0.1)

# Extra flags for non-mainnet runs (the test suite passes -regtest here).
if [[ -n "${PEPECOIN_CLI_ARGS:-}" ]]; then
  read -ra _extra <<< "${PEPECOIN_CLI_ARGS}"
  ARGS+=("${_extra[@]}")
fi

password="${RPC_PASSWORD:-}"
if [[ -z "${password}" && -s "${DATA_ROOT}/rpc-password" ]]; then
  password="$(cat "${DATA_ROOT}/rpc-password")"
fi
if [[ -n "${password}" ]]; then
  ARGS+=(-rpcuser="${RPC_USER:-umbrel}" -rpcpassword="${password}")
fi

output="$(pepecoin-cli "${ARGS[@]}" getbestblockhash 2>&1)"
status=$?

if [[ ${status} -eq 0 ]]; then
  exit 0
fi

case "${output}" in
  *"Loading block index"*|*"Verifying blocks"*|*"Rewinding blocks"*|*"Loading wallet"*|\
  *"Activating best chain"*|*"Loading P2P addresses"*|*"warming up"*|*"Starting network threads"*)
    exit 0
    ;;
esac

echo "${output}" >&2
exit 1
