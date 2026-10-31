#!/usr/bin/env bash
# Sourced by umbrelOS before the app starts.
#
# derive_entropy computes HMAC-SHA256(umbrel_seed, identifier), so this password
# is unique to this device, stable across restarts, reinstalls and backups, and
# never written into the repo or into soqucoin.conf.

#
# The identifier below is a fixed literal on purpose. Do NOT "tidy" it into
# "env-${app_entropy_identifier}-RPC_PASSWORD": umbrelOS sets that variable to
# "app-doge-soqucoin-node-seed", so the interpolated form would produce a
# DIFFERENT identifier, a different derived password, and every wallet pointed
# at this node would stop authenticating. The string is the contract.

export APP_SOQUCOIN_NODE_RPC_USER="umbrel"
# shellcheck disable=SC2155
# The command substitution inside export is deliberate: it means export's exit
# status is reported, not derive_entropy's, so a derive_entropy failure can
# never abort the app start under umbrelOS's `set -euo pipefail`.
export APP_SOQUCOIN_NODE_RPC_PASS="$(derive_entropy "env-app-doge-soqucoin-node-seed-RPC_PASSWORD")"
export APP_SOQUCOIN_NODE_RPC_PORT="33389"
export APP_SOQUCOIN_NODE_P2P_PORT="33388"
