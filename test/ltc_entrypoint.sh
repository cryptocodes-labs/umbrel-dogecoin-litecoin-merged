#!/usr/bin/env bash
# shellcheck disable=SC2015
#   `cond && ok "…" || bad "…"` is safe here: ok() and bad() are defined below
#   and both always return 0, so the `||` branch can never fire off a
#   successful `ok`.
# shellcheck disable=SC2016
#   One test deliberately passes a literal, unexpanded `$(id)` to prove the
#   entrypoint rejects shell metacharacters in RPC_USER.

#
# Tests images/ltc-core/entrypoint.sh — the script that turns environment
# variables into a litecoin.conf — plus healthcheck.sh, against the real
# litecoind binary.
#
# Same reasoning as test/entrypoint.sh: a wrong config line means the node comes
# up with the wrong security posture and nobody notices. Litecoin Core 0.21 adds
# a failure mode Dogecoin Core 1.14 does not have — network-scoped settings
# outside a [test]/[regtest] section abort the start — so the layout of the
# generated file is checked explicitly and then handed to a real node on
# regtest, which is exactly the case that would trip over it.
#
# No Docker required: `litecoind` and `gosu` are stubbed on PATH so the script
# can run to completion without exec'ing anything.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="${REPO_ROOT}/images/ltc-core/entrypoint.sh"
HEALTHCHECK="${REPO_ROOT}/images/ltc-core/healthcheck.sh"
WORK="$(mktemp -d)"
LTC_VERSION="${LTC_VERSION:-0.21.5.8}"
NODE_RPC_PORT="${NODE_RPC_PORT:-24332}"

PASS=0
FAIL=0

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
info()  { printf '\033[2m%s\033[0m\n' "$*"; }
ok()    { PASS=$((PASS + 1)); green "  ✓ $1"; }
bad()   {
  FAIL=$((FAIL + 1))
  red "  ✗ $1"
  if [[ $# -gt 1 ]]; then printf '      %s\n' "$2"; fi
  return 0
}

# shellcheck disable=SC2317  # invoked via trap
cleanup() {
  if [[ -n "${PEER_DATADIR:-}" ]]; then
    "${BIN}/litecoin-cli" -regtest -rpcport="${PEER_RPC_PORT}" -rpcuser=peer -rpcpassword=peer \
      stop >/dev/null 2>&1 || true
  fi
  if [[ -n "${NODE_DATADIR:-}" && -f "${NODE_DATADIR}/litecoin.conf" ]]; then
    "${BIN}/litecoin-cli" -datadir="${NODE_DATADIR}" -conf="${NODE_DATADIR}/litecoin.conf" \
      -rpcuser=umbrel -rpcpassword=real-node-password stop >/dev/null 2>&1 || true
    sleep 2
  fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Stubs: a fake litecoind that records its argv, and a gosu that just execs.
# ---------------------------------------------------------------------------
STUB="${WORK}/stub"
mkdir -p "${STUB}"

cat > "${STUB}/litecoind" <<'EOS'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  echo "Litecoin Core version v0.21.5.8"
  exit 0
fi
printf '%s\n' "$*" > "${ARGV_LOG:-/dev/null}"
exit 0
EOS

cat > "${STUB}/gosu" <<'EOS'
#!/usr/bin/env bash
printf '%s\n' "$1" > "${GOSU_USER_LOG:-/dev/null}"
shift
exec "$@"
EOS

chmod +x "${STUB}/litecoind" "${STUB}/gosu"

# Run the real entrypoint in an isolated fake /data.
# usage: run_entrypoint <case-name> [VAR=value ...]
run_entrypoint() {
  local name="$1"; shift
  CASE_DIR="${WORK}/${name}"
  mkdir -p "${CASE_DIR}/.litecoin"
  CASE_OUT="${CASE_DIR}.log"
  CASE_ARGV="${CASE_DIR}.argv"
  CASE_USER="${CASE_DIR}.user"
  env -i \
    PATH="${STUB}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    HOME=/root \
    ARGV_LOG="${CASE_ARGV}" \
    GOSU_USER_LOG="${CASE_USER}" \
    LITECOIN_DATA="${CASE_DIR}/.litecoin" \
    DATA_ROOT="${CASE_DIR}" \
    "$@" \
    bash "${ENTRYPOINT}" litecoind > "${CASE_OUT}" 2>&1
  CASE_STATUS=$?
  CASE_CONF="${CASE_DIR}/.litecoin/litecoin.conf"
  return 0
}

conf() { cat "${CASE_CONF}" 2>/dev/null; }
has()  { grep -qxF "$1" "${CASE_CONF}" 2>/dev/null; }

# Every assertion below first insists the config exists. Without this a crashed
# entrypoint makes every "does not contain" check pass for the wrong reason.
conf_exists() {
  if [[ -f "${CASE_CONF}" ]]; then return 0; fi
  bad "$1" "no config was generated (entrypoint exited ${CASE_STATUS})"
  return 1
}

assert_conf_has() {
  conf_exists "$1" || return 0
  if has "$2"; then ok "$1"; else bad "$1" "'$2' not in generated config:$(printf '\n%s' "$(conf)")"; fi
}
assert_conf_lacks() {
  conf_exists "$1" || return 0
  if has "$2"; then bad "$1" "'$2' should not be in the config"; else ok "$1"; fi
}
# Line number of the first exact match, or empty.
line_of() { grep -nxF "$1" "${CASE_CONF}" 2>/dev/null | head -1 | cut -d: -f1; }

# ===========================================================================
info "Defaults"
# ===========================================================================
run_entrypoint default RPC_PASSWORD=super-secret-password
[[ ${CASE_STATUS} -eq 0 ]] && ok "entrypoint exits 0" || bad "entrypoint exits 0" "status ${CASE_STATUS}: $(cat "${CASE_OUT}")"

assert_conf_has  "server mode is on"                 "server=1"
assert_conf_has  "listens for inbound peers"         "listen=1"
assert_conf_has  "logs to the container log"         "printtoconsole=1"
assert_conf_has  "debug.log is shrunk on start"      "shrinkdebugfile=1"
assert_conf_has  "wallet disabled by default"        "disablewallet=1"
assert_conf_has  "RPC bound inside the container"    "rpcbind=0.0.0.0"
assert_conf_has  "P2P port"                          "port=9333"
assert_conf_has  "RPC port"                          "rpcport=9332"
assert_conf_has  "private RPC range 10/8"            "rpcallowip=10.0.0.0/8"
assert_conf_has  "private RPC range 192.168/16"      "rpcallowip=192.168.0.0/16"
assert_conf_lacks "no public rpcallowip"             "rpcallowip=0.0.0.0/0"
# Litecoin Core's defaults (4 threads, queue of 16) are exhausted by a single
# getblocktemplate longpoll, which merge mining holds open permanently. Every
# other RPC caller then gets "Work queue depth exceeded".
assert_conf_has  "RPC threads raised above the default of 4" "rpcthreads=8"
assert_conf_has  "RPC work queue raised above the default"   "rpcworkqueue=64"
assert_conf_lacks "pruning off by default"           "prune=0"
assert_conf_lacks "txindex off by default"           "txindex=1"
assert_conf_lacks "bloom filters off by default"     "peerbloomfilters=1"
assert_conf_lacks "no proxy by default"              "proxyrandomize=1"
# Mainnet is the top level of the file — there is no section to open, and an
# empty "[]" or a stray "[main]" would be a bug.
assert_conf_lacks "mainnet opens no config section"  "[main]"
assert_conf_lacks "mainnet does not select testnet"  "testnet=1"
assert_conf_lacks "mainnet does not select regtest"  "regtest=1"

if grep -q "super-secret-password" "${CASE_CONF}"; then
  bad "the plaintext password never reaches litecoin.conf"
else
  ok "the plaintext password never reaches litecoin.conf"
fi
if grep -q "^rpcauth=umbrel:[0-9a-f]\{32\}\$[0-9a-f]\{64\}$" "${CASE_CONF}"; then
  ok "config carries a well-formed salted rpcauth line"
else
  bad "config carries a well-formed salted rpcauth line" "$(grep '^rpcauth' "${CASE_CONF}")"
fi
if grep -q "super-secret-password" "${CASE_OUT}"; then
  bad "the password is never printed to the container log"
else
  ok "the password is never printed to the container log"
fi
[[ "$(stat -c %a "${CASE_CONF}")" == "600" ]] \
  && ok "litecoin.conf is mode 0600" \
  || bad "litecoin.conf is mode 0600" "got $(stat -c %a "${CASE_CONF}")"
[[ "$(cat "${CASE_USER}" 2>/dev/null)" == "litecoin" ]] \
  && ok "litecoind is started as the unprivileged user" \
  || bad "litecoind is started as the unprivileged user" "gosu user: $(cat "${CASE_USER}" 2>/dev/null)"
if grep -q -- "-datadir=" "${CASE_ARGV}" && grep -q -- "-conf=" "${CASE_ARGV}"; then
  ok "litecoind is invoked with an explicit datadir and conf"
else
  bad "litecoind is invoked with an explicit datadir and conf" "$(cat "${CASE_ARGV}")"
fi
# Umbrel supplied the password, so nothing plaintext should be left on disk.
[[ ! -f "${CASE_DIR}/rpc-password" ]] \
  && ok "no plaintext secret on disk when Umbrel supplies the password" \
  || bad "no plaintext secret on disk when Umbrel supplies the password"

# ===========================================================================
info "Generated password lifecycle"
# ===========================================================================
run_entrypoint generated
[[ ${CASE_STATUS} -eq 0 ]] && ok "starts without a supplied password" || bad "starts without a supplied password" "$(cat "${CASE_OUT}")"
SECRET="${CASE_DIR}/rpc-password"
if [[ -s "${SECRET}" ]]; then
  ok "a password is generated and persisted"
  [[ "$(stat -c %a "${SECRET}")" == "600" ]] \
    && ok "the persisted secret is mode 0600" \
    || bad "the persisted secret is mode 0600" "got $(stat -c %a "${SECRET}")"
  len=$(wc -c < "${SECRET}" | tr -d ' ')
  [[ "${len}" -eq 64 ]] \
    && ok "the generated password is 256 bits" \
    || bad "the generated password is 256 bits" "got ${len} hex chars"
  FIRST="$(cat "${SECRET}")"
  FIRST_AUTH="$(grep '^rpcauth=' "${CASE_CONF}")"

  # Restarting must reuse the same password (otherwise every wallet breaks)
  # while rotating the salt.
  CASE_DIR="${WORK}/generated"
  env -i PATH="${STUB}:/usr/bin:/bin" HOME=/root \
    ARGV_LOG=/dev/null GOSU_USER_LOG=/dev/null \
    LITECOIN_DATA="${CASE_DIR}/.litecoin" DATA_ROOT="${CASE_DIR}" \
    bash "${ENTRYPOINT}" litecoind > "${CASE_DIR}.log2" 2>&1
  RESTART_STATUS=$?
  if [[ ${RESTART_STATUS} -eq 0 ]]; then
    ok "the entrypoint runs cleanly a second time"
  else
    bad "the entrypoint runs cleanly a second time" "$(cat "${CASE_DIR}.log2")"
  fi
  SECOND="$(cat "${SECRET}")"
  SECOND_AUTH="$(grep '^rpcauth=' "${CASE_DIR}/.litecoin/litecoin.conf")"
  [[ "${FIRST}" == "${SECOND}" ]] \
    && ok "a restart reuses the persisted password" \
    || bad "a restart reuses the persisted password"
  [[ "${FIRST_AUTH}" != "${SECOND_AUTH}" ]] \
    && ok "the rpcauth salt is fresh on every start" \
    || bad "the rpcauth salt is fresh on every start"
else
  bad "a password is generated and persisted"
fi

# ===========================================================================
info "Input validation"
# ===========================================================================
# Asserting only on a non-zero exit is not enough: the entrypoint could be
# failing for a completely unrelated reason and every one of these would still
# look green. Each case must produce ITS OWN error message.
expect_fail() {
  local name="$1"; local expected="$2"; shift 2
  run_entrypoint "reject-$(echo "${name}" | tr -cd 'A-Za-z0-9')" RPC_PASSWORD=x "$@"
  if [[ ${CASE_STATUS} -eq 0 ]]; then
    bad "${name}" "entrypoint accepted it"
  elif grep -qF "${expected}" "${CASE_OUT}"; then
    ok "${name}"
  else
    bad "${name}" "rejected, but not for the expected reason. Wanted '${expected}', got: $(head -2 "${CASE_OUT}")"
  fi
}
expect_fail "rejects a non-numeric DBCACHE" \
  "DBCACHE must be a whole number"                 DBCACHE=lots
expect_fail "rejects a negative-looking PRUNE" \
  "PRUNE must be a whole number"                   PRUNE=-1
expect_fail "rejects a PRUNE below litecoind's minimum" \
  "at least 550"                                   PRUNE=100
expect_fail "rejects PRUNE together with TXINDEX" \
  "mutually exclusive"                             PRUNE=10000 TXINDEX=1
expect_fail "rejects an RPC_USER with shell characters" \
  "RPC_USER may only contain"                      'RPC_USER=umbrel$(id)'
expect_fail "rejects a non-numeric MAXCONNECTIONS" \
  "MAXCONNECTIONS must be a whole number"          MAXCONNECTIONS=many
expect_fail "rejects an unknown NETWORK" \
  "NETWORK must be main, test or regtest"          NETWORK=mainnett

# A [section] in the user's file would re-scope everything generated after it.
mkdir -p "${WORK}/customsection/.litecoin"
printf '[test]\nmaxmempool=50\n' > "${WORK}/customsection/.litecoin/litecoin-custom.conf"
run_entrypoint customsection RPC_PASSWORD=x
if [[ ${CASE_STATUS} -ne 0 ]] && grep -qF "must not contain [section] headers" "${CASE_OUT}"; then
  ok "rejects a [section] header in litecoin-custom.conf"
else
  bad "rejects a [section] header in litecoin-custom.conf" "$(head -2 "${CASE_OUT}")"
fi

# ===========================================================================
info "Optional features"
# ===========================================================================
run_entrypoint pruned RPC_PASSWORD=x PRUNE=10000
assert_conf_has "pruning is written through"   "prune=10000"

run_entrypoint indexed RPC_PASSWORD=x TXINDEX=1
assert_conf_has "txindex is written through"   "txindex=1"

run_entrypoint wallet RPC_PASSWORD=x DISABLE_WALLET=0
assert_conf_lacks "the wallet can be re-enabled" "disablewallet=1"

run_entrypoint tor RPC_PASSWORD=x TOR_ENABLED=1 TOR_PROXY_IP=10.21.21.11 TOR_PROXY_PORT=9050
assert_conf_has "Tor sets a SOCKS proxy"        "proxy=10.21.21.11:9050"
assert_conf_has "Tor sets the onion proxy"      "onion=10.21.21.11:9050"
assert_conf_has "Tor randomises credentials"    "proxyrandomize=1"
assert_conf_lacks "Tor alone does not disable clearnet" "onlynet=onion"

run_entrypoint toronly RPC_PASSWORD=x TOR_ENABLED=1 TOR_ONLY=1 TOR_PROXY_IP=10.21.21.11
assert_conf_has "Tor-only disables clearnet"    "onlynet=onion"

run_entrypoint tormisconfigured RPC_PASSWORD=x TOR_ENABLED=1
if [[ ${CASE_STATUS} -ne 0 ]] && grep -qF "TOR_PROXY_IP is empty" "${CASE_OUT}"; then
  ok "Tor without a proxy address fails loudly"
else
  bad "Tor without a proxy address fails loudly" "$(head -2 "${CASE_OUT}")"
fi

run_entrypoint extraargs RPC_PASSWORD=x EXTRA_ARGS="-reindex -par=2"
if grep -q -- "-reindex" "${CASE_ARGV}" && grep -q -- "-par=2" "${CASE_ARGV}"; then
  ok "EXTRA_ARGS reach litecoind as separate arguments"
else
  bad "EXTRA_ARGS reach litecoind as separate arguments" "$(cat "${CASE_ARGV}")"
fi

# ===========================================================================
info "Network sections (the Litecoin-specific part)"
# ===========================================================================
run_entrypoint regtest RPC_PASSWORD=x NETWORK=regtest RPC_PORT=24332 P2P_PORT=24333
assert_conf_has "regtest is selected at the top level" "regtest=1"
assert_conf_has "regtest opens its own section"        "[regtest]"
for key in "port=24333" "rpcport=24332" "rpcbind=0.0.0.0"; do
  section_line="$(line_of "[regtest]")"
  key_line="$(line_of "${key}")"
  if [[ -n "${section_line}" && -n "${key_line}" && "${key_line}" -gt "${section_line}" ]]; then
    ok "${key} sits inside the [regtest] section"
  else
    bad "${key} sits inside the [regtest] section" "section at ${section_line:-none}, key at ${key_line:-none}"
  fi
done
# rpcauth must NOT be network scoped: it belongs above the section header, or
# authentication silently applies to one chain only.
if [[ "$(grep -n '^rpcauth=' "${CASE_CONF}" | cut -d: -f1)" -lt "$(line_of "[regtest]")" ]]; then
  ok "rpcauth stays above the section header"
else
  bad "rpcauth stays above the section header" "$(conf)"
fi

run_entrypoint testnet RPC_PASSWORD=x NETWORK=test
assert_conf_has "testnet is selected at the top level" "testnet=1"
# Litecoin Core names the section [test]; a [testnet] header is only warned
# about and then ignored, which would leave the ports unset.
assert_conf_has "testnet uses the [test] header"       "[test]"
assert_conf_lacks "no [testnet] header"                "[testnet]"

# The friendlier spelling maps onto the same file.
run_entrypoint testnetalias RPC_PASSWORD=x NETWORK=testnet
assert_conf_has "NETWORK=testnet is accepted as an alias" "[test]"

# ===========================================================================
info "litecoin-custom.conf"
# ===========================================================================
# Litecoin Core keeps the FIRST occurrence of a duplicated setting, so the
# user's file has to come first to be able to override anything.
mkdir -p "${WORK}/custom/.litecoin"
printf 'maxreceivebuffer=8000\nmaxmempool=77\n' > "${WORK}/custom/.litecoin/litecoin-custom.conf"
run_entrypoint custom RPC_PASSWORD=x MAXMEMPOOL=300
assert_conf_has "litecoin-custom.conf is merged in" "maxreceivebuffer=8000"
if [[ "$(line_of "maxmempool=77")" -lt "$(line_of "maxmempool=300")" ]]; then
  ok "custom settings are written above the generated ones"
else
  bad "custom settings are written above the generated ones" "$(conf)"
fi

# ===========================================================================
info "The generated config against a real litecoind"
# ===========================================================================
# Read the pin out of the Dockerfile itself. Hard-coding it here would mean the
# test validates a copy of the value rather than the one the image is built with.
DOCKERFILE="${REPO_ROOT}/images/ltc-core/Dockerfile"
case "$(uname -m)" in
  x86_64) LTC_ARCH="x86_64-linux-gnu"; SHA_ARG="SHA256_AMD64" ;;
  aarch64|arm64) LTC_ARCH="aarch64-linux-gnu"; SHA_ARG="SHA256_ARM64" ;;
  *) red "Unsupported architecture $(uname -m)"; exit 1 ;;
esac
LTC_SHA="$(grep -oP "^ARG ${SHA_ARG}=\K[0-9a-f]{64}" "${DOCKERFILE}" || true)"
if [[ -n "${LTC_SHA}" ]]; then
  ok "found the ${SHA_ARG} pin in images/ltc-core/Dockerfile"
else
  bad "found the ${SHA_ARG} pin in images/ltc-core/Dockerfile" "no 64-hex ARG ${SHA_ARG}= line"
  exit 1
fi
DOCKER_VERSION="$(grep -oP '^ARG LITECOIN_VERSION=\K[0-9.]+' "${DOCKERFILE}" | head -1)"
if [[ "${DOCKER_VERSION}" == "${LTC_VERSION}" ]]; then
  ok "the Dockerfile builds the version this suite tests (${LTC_VERSION})"
else
  bad "the Dockerfile builds the version this suite tests" "Dockerfile ${DOCKER_VERSION}, suite ${LTC_VERSION}"
fi
TARBALL="litecoin-${LTC_VERSION}-${LTC_ARCH}.tar.gz"
CACHE="${TMPDIR:-/tmp}/${TARBALL}"
if [[ ! -f "${CACHE}" ]]; then
  curl -fsSL --retry 3 -o "${CACHE}" \
    "https://github.com/litecoin-project/litecoin/releases/download/v${LTC_VERSION}/${TARBALL}"
fi
if echo "${LTC_SHA}  ${CACHE}" | sha256sum -c - >/dev/null 2>&1; then
  ok "the real tarball matches the SHA256 pinned in the Dockerfile"
else
  bad "the real tarball matches the SHA256 pinned in the Dockerfile" \
      "Dockerfile pins ${LTC_SHA}, tarball is $(sha256sum "${CACHE}" | cut -d" " -f1)"
fi

mkdir -p "${WORK}/real" && tar -xzf "${CACHE}" -C "${WORK}/real" --strip-components=1
BIN="${WORK}/real/bin"

# Generate a config with the real entrypoint, then start a real node on it. No
# -regtest on the command line: the point is that the generated FILE puts the
# node on regtest and survives 0.21's network-section rule on its own.
NODE_DATADIR="${WORK}/realdata/.litecoin"
mkdir -p "${NODE_DATADIR}"
printf 'maxmempool=77\n' > "${NODE_DATADIR}/litecoin-custom.conf"
env -i PATH="${STUB}:/usr/bin:/bin" HOME=/root ARGV_LOG=/dev/null GOSU_USER_LOG=/dev/null \
  LITECOIN_DATA="${NODE_DATADIR}" DATA_ROOT="${WORK}/realdata" \
  NETWORK=regtest RPC_PASSWORD="real-node-password" RPC_PORT="${NODE_RPC_PORT}" \
  P2P_PORT="$((NODE_RPC_PORT + 1))" \
  RPC_ALLOW_IP="127.0.0.1" DBCACHE=64 MAXMEMPOOL=300 \
  MAXCONNECTIONS=32 \
  bash "${ENTRYPOINT}" litecoind > "${WORK}/realgen.log" 2>&1
# MAXCONNECTIONS has to stay above Litecoin Core's ten reserved outbound slots:
# below that the node computes zero inbound slots and drops the mining peer
# below with "failed to find an eviction candidate - connection dropped (full)".

"${BIN}/litecoind" -datadir="${NODE_DATADIR}" -conf="${NODE_DATADIR}/litecoin.conf" \
  -daemon > "${WORK}/realstart.log" 2>&1
started=0
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null --user "umbrel:real-node-password" \
      --data '{"jsonrpc":"1.0","id":"t","method":"getblockchaininfo","params":[]}' \
      "http://127.0.0.1:${NODE_RPC_PORT}/"; then started=1; break; fi
  sleep 1
done
[[ ${started} -eq 1 ]] \
  && ok "a real litecoind starts on the generated config and accepts the password" \
  || bad "a real litecoind starts on the generated config" \
         "$(cat "${WORK}/realstart.log"; tail -5 "${NODE_DATADIR}/regtest/debug.log" 2>/dev/null)"

rpc() {
  curl -s --user "umbrel:real-node-password" \
    --data "{\"jsonrpc\":\"1.0\",\"id\":\"t\",\"method\":\"$1\",\"params\":${2:-[]}}" \
    "http://127.0.0.1:${NODE_RPC_PORT}/"
}

chain="$(rpc getblockchaininfo | grep -o '"chain":"[a-z]*"')"
[[ "${chain}" == '"chain":"regtest"' ]] \
  && ok "the generated [regtest] section really put the node on regtest" \
  || bad "the generated [regtest] section really put the node on regtest" "${chain}"

# Proves rule 1 of the file layout: the user's value, written above ours, wins.
mempool="$(rpc getmempoolinfo)"
[[ "${mempool}" == *'"maxmempool":77000000'* ]] \
  && ok "a setting in litecoin-custom.conf overrides the generated one" \
  || bad "a setting in litecoin-custom.conf overrides the generated one" "${mempool:0:160}"

code=$(curl -s -o /dev/null -w '%{http_code}' --user "umbrel:not-the-password" \
  --data '{"jsonrpc":"1.0","id":"t","method":"getblockchaininfo","params":[]}' \
  "http://127.0.0.1:${NODE_RPC_PORT}/")
[[ "${code}" == "401" ]] \
  && ok "the generated rpcauth rejects a wrong password" \
  || bad "the generated rpcauth rejects a wrong password" "HTTP ${code}"

wallet="$(rpc getbalance)"
[[ "${wallet}" == *"Method not found"* ]] \
  && ok "the generated config really does disable the wallet" \
  || bad "the generated config really does disable the wallet" "${wallet:0:120}"

# --- merge mining --------------------------------------------------------
# getblocktemplate is refused with -9/-10 while the node has no peers or is
# still in initial block download, and BOTH conditions hold for a node that has
# just been started on an empty regtest chain. So a throwaway second node is
# attached to the P2P port from the generated [regtest] section — which also
# proves that section actually took effect — and mines a couple of blocks.
PEER_DATADIR="${WORK}/peer"
PEER_RPC_PORT="$((NODE_RPC_PORT + 2))"
mkdir -p "${PEER_DATADIR}"
"${BIN}/litecoind" -regtest -datadir="${PEER_DATADIR}" -rpcport="${PEER_RPC_PORT}" \
  -port="$((NODE_RPC_PORT + 3))" -rpcuser=peer -rpcpassword=peer \
  -connect="127.0.0.1:$((NODE_RPC_PORT + 1))" -daemon > "${WORK}/peer.log" 2>&1
peer_cli() { "${BIN}/litecoin-cli" -regtest -datadir="${PEER_DATADIR}" \
  -rpcport="${PEER_RPC_PORT}" -rpcuser=peer -rpcpassword=peer "$@"; }
for _ in $(seq 1 30); do peer_cli getblockcount >/dev/null 2>&1 && break; sleep 1; done
# Litecoin Core 0.21 loads no wallet unless one exists, so the miner's wallet
# has to be created before there is an address to mine to.
peer_cli createwallet miner >/dev/null 2>&1
MINE_ADDR="$(peer_cli getnewaddress 2>/dev/null)"
if [[ -n "${MINE_ADDR}" ]]; then
  peer_cli generatetoaddress 2 "${MINE_ADDR}" >/dev/null 2>&1
fi
height=0
for _ in $(seq 1 30); do
  height="$(rpc getblockcount | grep -o '"result":[0-9]*' | cut -d: -f2)"
  [[ "${height:-0}" -ge 2 ]] && break
  sleep 1
done
[[ "${height:-0}" -ge 2 ]] \
  && ok "a peer reaches the P2P port from the [regtest] section and relays blocks" \
  || bad "a peer reaches the P2P port from the [regtest] section and relays blocks" "height ${height:-none}"

# Merge mining calls getblocktemplate on this node. Litecoin 0.21 refuses the
# call unless BOTH rule sets are named — a caller that copies the Dogecoin side
# verbatim gets nothing but -8 errors, so both halves are pinned here.
no_rules="$(rpc getblocktemplate '[{}]')"
[[ "${no_rules}" == *"mweb"* && "${no_rules}" == *"segwit"* && "${no_rules}" == *'"code":-8'* ]] \
  && ok "getblocktemplate without rules is refused, naming mweb and segwit" \
  || bad "getblocktemplate without rules is refused, naming mweb and segwit" "${no_rules:0:200}"

with_rules="$(rpc getblocktemplate '[{"rules":["mweb","segwit"]}]')"
[[ "${with_rules}" == *'"previousblockhash"'* && "${with_rules}" == *'"coinbasevalue"'* ]] \
  && ok "getblocktemplate with rules [mweb,segwit] returns a template" \
  || bad "getblocktemplate with rules [mweb,segwit] returns a template" "${with_rules:0:200}"

# --- healthcheck ---------------------------------------------------------
# No network flag is passed: the healthcheck has to work out from the generated
# config that this node is on regtest, exactly as it does in the container.
if PATH="${BIN}:${PATH}" LITECOIN_DATA="${NODE_DATADIR}" DATA_ROOT="${WORK}/realdata" \
     RPC_PASSWORD="real-node-password" \
     bash "${HEALTHCHECK}" >/dev/null 2>&1; then
  ok "healthcheck reports healthy against a running node"
else
  bad "healthcheck reports healthy against a running node"
fi

"${BIN}/litecoin-cli" -datadir="${NODE_DATADIR}" -conf="${NODE_DATADIR}/litecoin.conf" \
  -rpcuser=umbrel -rpcpassword=real-node-password stop >/dev/null 2>&1
for _ in $(seq 1 15); do
  curl -sf -o /dev/null --max-time 2 --user "umbrel:real-node-password" \
    --data '{"jsonrpc":"1.0","id":"t","method":"getbestblockhash","params":[]}' \
    "http://127.0.0.1:${NODE_RPC_PORT}/" || break
  sleep 1
done
if PATH="${BIN}:${PATH}" LITECOIN_DATA="${NODE_DATADIR}" DATA_ROOT="${WORK}/realdata" \
     RPC_PASSWORD="real-node-password" \
     bash "${HEALTHCHECK}" >/dev/null 2>&1; then
  bad "healthcheck reports unhealthy once the node is gone"
else
  ok "healthcheck reports unhealthy once the node is gone"
fi
NODE_DATADIR=""

# ===========================================================================
info "The shared dashboard image, branded as Litecoin"
# ===========================================================================
# The Litecoin app ships no dashboard of its own: it runs images/ui with the
# coin's name, glyph and colours passed in. Two things have to hold for that to
# be safe — the words really are substituted (otherwise the app store gets a
# page titled "Dogecoin Node"), and a value from a compose file cannot escape
# into the page's script or stylesheet.
UI_SRC="${REPO_ROOT}/images/ui/src/server.js"
UI_PORT="${UI_PORT:-3013}"
if command -v node >/dev/null 2>&1; then
  COIN_NAME="Litecoin" CORE_NAME="Litecoin Core" DAEMON_NAME="litecoind" \
  COIN_GLYPH="Ł" CHAIN_SIZE_HINT="well over 100 GB" \
  DAEMON_CONTAINER="doge-litecoin-node_litecoind_1" \
  ACCENT="#9aa3ad'; } body { display:none } .x{color:'" \
  RPC_HOST=127.0.0.1 RPC_PORT=1 PORT="${UI_PORT}" \
    node "${UI_SRC}" > "${WORK}/ui.log" 2>&1 &
  UI_PID=$!
  for _ in $(seq 1 30); do
    curl -sf -o /dev/null "http://127.0.0.1:${UI_PORT}/health" && break
    sleep 1
  done
  HTML="$(curl -s "http://127.0.0.1:${UI_PORT}/")"
  kill "${UI_PID}" 2>/dev/null

  [[ "${HTML}" == *"<title>Litecoin Node</title>"* ]] \
    && ok "the dashboard renders as Litecoin" \
    || bad "the dashboard renders as Litecoin" "$(printf '%s' "${HTML}" | grep -i '<title>')"
  [[ "${HTML}" == *"Litecoin Core"* && "${HTML}" != *"Dogecoin"* ]] \
    && ok "no Dogecoin wording survives in the Litecoin page" \
    || bad "no Dogecoin wording survives in the Litecoin page"
  [[ "${HTML}" != *"__COIN_NAME__"* && "${HTML}" != *"__ACCENT__"* ]] \
    && ok "every branding placeholder was substituted" \
    || bad "every branding placeholder was substituted"
  # A colour that is not a hex literal must fall back, not reach the stylesheet.
  [[ "${HTML}" != *"body { display:none }"* && "${HTML}" == *"--gold: #c2a633;"* ]] \
    && ok "a malformed ACCENT falls back instead of injecting CSS" \
    || bad "a malformed ACCENT falls back instead of injecting CSS" \
           "$(printf '%s' "${HTML}" | grep -n 'gold:' | head -2)"
else
  bad "node is available to test the dashboard branding"
fi

# ===========================================================================
echo
if [[ ${FAIL} -eq 0 ]]; then
  green "${PASS} checks passed, 0 failed"
  exit 0
else
  red "${PASS} passed, ${FAIL} FAILED"
  exit 1
fi
