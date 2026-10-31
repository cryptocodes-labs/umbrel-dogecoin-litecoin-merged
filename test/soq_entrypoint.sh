#!/usr/bin/env bash
# shellcheck disable=SC2015
#   `cond && ok "…" || bad "…"` is safe here: ok() and bad() always return 0.
# shellcheck disable=SC2016
#   One case deliberately passes a literal, unexpanded `$(id)` to prove the
#   entrypoint rejects shell metacharacters in RPC_USER.

#
# Tests images/soq-core/entrypoint.sh and healthcheck.sh: the config the
# Soqucoin Node app starts with, every security-relevant line of it, and then
# that config against a real soqucoind (the release the Dockerfile pins).
#
# The parts that matter most for this node: the wallet is off, the mining RPCs
# the pool needs are on (mainnet defaults them off), the RPC password never
# reaches the config in plain text, the RPC only answers private ranges, and
# the daemon runs as uid 1000.
#
# No Docker required: soqucoind and gosu are stubbed on PATH for the config
# cases; the last section starts the real binary on regtest.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="${REPO_ROOT}/images/soq-core/entrypoint.sh"
HEALTHCHECK="${REPO_ROOT}/images/soq-core/healthcheck.sh"
DOCKERFILE="${REPO_ROOT}/images/soq-core/Dockerfile"
WORK="$(mktemp -d)"
NODE_RPC_PORT="${NODE_RPC_PORT:-24855}"

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
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

# shellcheck disable=SC2317  # invoked via trap
cleanup() {
  if [[ -n "${NODE_DATADIR:-}" && -f "${NODE_DATADIR}/soqucoin.conf" ]]; then
    "${BIN}/soqucoin-cli" -datadir="${NODE_DATADIR}" -conf="${NODE_DATADIR}/soqucoin.conf" \
      -regtest -rpcuser=umbrel -rpcpassword=real-node-password stop >/dev/null 2>&1 || true
    sleep 2
  fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

STUB="${WORK}/stub"
mkdir -p "${STUB}"
cat > "${STUB}/soqucoind" <<'EOS'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then echo "Soqucoin Core Daemon version v2.6.1.0-5f4b417"; exit 0; fi
printf '%s\n' "$*" > "${ARGV_LOG:-/dev/null}"
env > "${ENV_LOG:-/dev/null}"
exit 0
EOS
cat > "${STUB}/gosu" <<'EOS'
#!/usr/bin/env bash
printf '%s\n' "$1" > "${GOSU_USER_LOG:-/dev/null}"
shift
exec "$@"
EOS
# The entrypoint chowns to 1000:1000, which a non-root test run cannot do; a
# stub keeps those calls from failing the run without hiding anything else.
cat > "${STUB}/chown" <<'EOS'
#!/usr/bin/env bash
exit 0
EOS
chmod +x "${STUB}/soqucoind" "${STUB}/gosu" "${STUB}/chown"

# usage: run_entrypoint <case-name> [VAR=value ...]
run_entrypoint() {
  local name="$1"; shift
  CASE_DIR="${WORK}/${name}"
  mkdir -p "${CASE_DIR}/.soqucoin"
  CASE_OUT="${CASE_DIR}.log"
  CASE_ARGV="${CASE_DIR}.argv"
  CASE_USER="${CASE_DIR}.user"
  CASE_ENV="${CASE_DIR}.env"
  env -i \
    PATH="${STUB}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    HOME=/root ARGV_LOG="${CASE_ARGV}" GOSU_USER_LOG="${CASE_USER}" ENV_LOG="${CASE_ENV}" \
    SOQUCOIN_DATA="${CASE_DIR}/.soqucoin" DATA_ROOT="${CASE_DIR}" \
    "$@" \
    bash "${ENTRYPOINT}" soqucoind > "${CASE_OUT}" 2>&1
  CASE_STATUS=$?
  CASE_CONF="${CASE_DIR}/.soqucoin/soqucoin.conf"
  return 0
}
has() { grep -qxF "$1" "${CASE_CONF}" 2>/dev/null; }
conf_exists() {
  if [[ -f "${CASE_CONF}" ]]; then return 0; fi
  bad "$1" "no config was generated (entrypoint exited ${CASE_STATUS}): $(cat "${CASE_OUT}")"
  return 1
}
assert_has()   { conf_exists "$1" || return 0; has "$2" && ok "$1" || bad "$1" "'$2' not in: $(tr '\n' '|' < "${CASE_CONF}")"; }
assert_lacks() { conf_exists "$1" || return 0; has "$2" && bad "$1" "'$2' should not be in the config" || ok "$1"; }

# ===========================================================================
info "Defaults"
# ===========================================================================
run_entrypoint default RPC_PASSWORD=super-secret-password
[[ ${CASE_STATUS} -eq 0 ]] && ok "entrypoint exits 0" || bad "entrypoint exits 0" "status ${CASE_STATUS}: $(cat "${CASE_OUT}")"
assert_has   "server mode is on"                     "server=1"
assert_has   "the wallet is disabled"                "disablewallet=1"
assert_has   "the mining RPCs the pool needs are on" "enablemining=1"
assert_has   "P2P port 33388"                        "port=33388"
assert_has   "RPC port 33389"                        "rpcport=33389"
assert_has   "private RPC range 10/8"                "rpcallowip=10.0.0.0/8"
assert_has   "private RPC range 172.16/12 (docker)"  "rpcallowip=172.16.0.0/12"
assert_has   "the container itself"                  "rpcallowip=127.0.0.1"
assert_lacks "not the LAN (the RPC is not published)" "rpcallowip=192.168.0.0/16"
assert_lacks "not the tailnet either"                "rpcallowip=100.64.0.0/10"
assert_lacks "no public rpcallowip"                  "rpcallowip=0.0.0.0/0"
assert_has   "RPC threads raised"                    "rpcthreads=8"
assert_has   "RPC work queue raised"                 "rpcworkqueue=64"
assert_lacks "no pruning by default"                 "prune=0"
assert_lacks "no txindex by default"                 "txindex=1"
assert_lacks "no bloom filters"                      "peerbloomfilters=1"
grep -q '^rpcauth=umbrel:[0-9a-f]\{32\}\$[0-9a-f]\{64\}$' "${CASE_CONF}" \
  && ok "the password is stored as an rpcauth HMAC" || bad "the password is stored as an rpcauth HMAC"
grep -q 'super-secret-password' "${CASE_CONF}" \
  && bad "the plain-text password is NOT in the config" || ok "the plain-text password is NOT in the config"
[[ ! -e "${CASE_DIR}/rpc-password" ]] \
  && ok "a supplied password is never written to disk" || bad "a supplied password is never written to disk"
[[ "$(mode "${CASE_CONF}")" == "600" ]] && ok "soqucoin.conf is mode 0600" || bad "soqucoin.conf is mode 0600" "got $(mode "${CASE_CONF}")"
[[ "$(cat "${CASE_USER}" 2>/dev/null)" == "soqucoin" ]] \
  && ok "soqucoind is started as the unprivileged soqucoin user" || bad "soqucoind is started as soqucoin" "$(cat "${CASE_USER}" 2>/dev/null)"
grep -q 'super-secret-password' "${CASE_ENV}" 2>/dev/null \
  && bad "the daemon's environment does not carry the password" || ok "the daemon's environment does not carry the password"
grep -q -- "-conf=${CASE_DIR}/.soqucoin/soqucoin.conf" "${CASE_ARGV}" 2>/dev/null \
  && ok "soqucoind is pointed at the generated config" || bad "soqucoind is pointed at the generated config" "$(cat "${CASE_ARGV}" 2>/dev/null)"

# ===========================================================================
info "Switches"
# ===========================================================================
run_entrypoint mining_off RPC_PASSWORD=x ENABLE_MINING=0
assert_lacks "ENABLE_MINING=0 leaves the mining RPCs off" "enablemining=1"
run_entrypoint wallet_on RPC_PASSWORD=x DISABLE_WALLET=0
assert_lacks "DISABLE_WALLET=0 turns the wallet on" "disablewallet=1"

# ===========================================================================
info "Generated password"
# ===========================================================================
run_entrypoint generated
SECRET="${CASE_DIR}/rpc-password"
[[ -s "${SECRET}" ]] && ok "a password is generated when none is supplied" || bad "a password is generated"
[[ "$(mode "${SECRET}")" == "600" ]] && ok "the generated secret is mode 0600" || bad "the generated secret is mode 0600" "got $(mode "${SECRET}")"
[[ "$(wc -c < "${SECRET}" | tr -d ' ')" == "64" ]] && ok "it is 256 bits of hex" || bad "it is 256 bits of hex"

# ===========================================================================
info "Input validation"
# ===========================================================================
reject() {
  local label="$1" want="$2"; shift 2
  run_entrypoint "reject_$((PASS + FAIL))" RPC_PASSWORD=x "$@"
  if [[ ${CASE_STATUS} -ne 0 ]] && grep -q "${want}" "${CASE_OUT}"; then ok "${label}"
  else bad "${label}" "status ${CASE_STATUS}: $(cat "${CASE_OUT}")"; fi
}
reject "shell metacharacters in RPC_USER are refused" "RPC_USER may only contain" 'RPC_USER=umbrel$(id)'
reject "a non-numeric RPC_PORT is refused"            "RPC_PORT must be a whole number" RPC_PORT=33389x
reject "a PRUNE below 550 is refused"                  "PRUNE must be 0"           PRUNE=100
reject "a newline in RPC_ALLOW_IP cannot add a config line" "RPC_ALLOW_IP may only contain" \
  "RPC_ALLOW_IP=10.0.0.0/8
blocknotify=touch /tmp/pwned"
reject "a newline in PROXY likewise"                   "PROXY may only contain" \
  "PROXY=127.0.0.1:9050
blocknotify=x"
reject "ONLYNET likewise"                              "ONLYNET may only contain" 'ONLYNET=onion;x'

# ===========================================================================
info "Symlinks planted by the daemon's own user"
# ===========================================================================
# soqucoind runs as uid 1000 and can write to /data. A symlink it plants there
# must not make the root-run entrypoint write, chown or read through it.
SYM="${WORK}/symlink"
mkdir -p "${SYM}/.soqucoin"
VICTIM="${WORK}/victim-file"
printf 'original\n' > "${VICTIM}"
SECRET_VICTIM="${WORK}/secret-victim"
printf 'not-for-uid-1000\n' > "${SECRET_VICTIM}"
ln -s "${VICTIM}" "${SYM}/rpc-user"
ln -s "${VICTIM}" "${SYM}/.soqucoin/soqucoin.conf.tmp"
ln -s "${SECRET_VICTIM}" "${SYM}/.soqucoin/soqucoin-custom.conf"
env -i PATH="${STUB}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" HOME=/root \
  SOQUCOIN_DATA="${SYM}/.soqucoin" DATA_ROOT="${SYM}" RPC_PASSWORD=x \
  bash "${ENTRYPOINT}" soqucoind > "${SYM}.log" 2>&1
[[ "$(cat "${VICTIM}")" == "original" ]] \
  && ok "a symlinked rpc-user or config.tmp does not overwrite its target" || bad "a symlink was written through" "$(cat "${VICTIM}")"
[[ ! -L "${SYM}/rpc-user" && -f "${SYM}/rpc-user" ]] \
  && ok "the symlink is replaced by a real file" || bad "the symlink is replaced by a real file"
grep -q 'not-for-uid-1000' "${SYM}/.soqucoin/soqucoin.conf" 2>/dev/null \
  && bad "a symlinked custom config is not read into the config" "the target's contents ended up in soqucoin.conf" \
  || ok "a symlinked custom config is not read into the config"
grep -q 'removed a symlink' "${SYM}.log" && ok "and the log says so" || bad "and the log says so" "$(cat "${SYM}.log")"

# ===========================================================================
info "The generated config against a real soqucoind"
# ===========================================================================
pin() { sed -n "s/^ARG $1=\([0-9a-f.]*\)$/\1/p" "${DOCKERFILE}" | head -1; }
case "$(uname -m)" in
  x86_64) SOQ_ARCH=linux-x64; SHA="$(pin SHA256_AMD64)" ;;
  aarch64) SOQ_ARCH=linux-arm64; SHA="$(pin SHA256_ARM64)" ;;
  *) info "skipped: no Linux release for $(uname -m)"; SOQ_ARCH="" ;;
esac
if [[ -n "${SOQ_ARCH}" ]]; then
  VERSION="$(pin SOQUCOIN_VERSION)"
  TARBALL="soqucoin-v${VERSION}-${SOQ_ARCH}.tar.gz"
  CACHE="${TMPDIR:-/tmp}/${TARBALL}"
  [[ -f "${CACHE}" ]] || curl -fsSL --retry 3 -o "${CACHE}" \
    "https://github.com/soqucoin/soqucoin/releases/download/v${VERSION}/${TARBALL}"
  if echo "${SHA}  ${CACHE}" | sha256sum -c - >/dev/null 2>&1; then
    ok "the release tarball matches the SHA256 pinned in the Dockerfile"
  else
    bad "the release tarball matches the SHA256 pinned in the Dockerfile"; exit 1
  fi
  BIN="${WORK}/real"
  mkdir -p "${BIN}" && tar -xzf "${CACHE}" -C "${BIN}"

  NODE_DATADIR="${WORK}/realdata/.soqucoin"
  mkdir -p "${NODE_DATADIR}"
  env -i PATH="${STUB}:/usr/bin:/bin" HOME=/root ARGV_LOG=/dev/null GOSU_USER_LOG=/dev/null \
    SOQUCOIN_DATA="${NODE_DATADIR}" DATA_ROOT="${WORK}/realdata" \
    RPC_PASSWORD="real-node-password" RPC_PORT="${NODE_RPC_PORT}" RPC_ALLOW_IP="127.0.0.1" \
    DBCACHE=64 MAXCONNECTIONS=8 \
    bash "${ENTRYPOINT}" soqucoind > "${WORK}/realgen.log" 2>&1
  "${BIN}/soqucoind" -datadir="${NODE_DATADIR}" -conf="${NODE_DATADIR}/soqucoin.conf" \
    -regtest -listen=0 -daemon >/dev/null 2>&1
  rpc() {
    curl -s --user "$1" --data "{\"jsonrpc\":\"1.0\",\"id\":\"t\",\"method\":\"$2\",\"params\":[]}" \
      "http://127.0.0.1:${NODE_RPC_PORT}/"
  }
  started=0
  for _ in $(seq 1 30); do
    rpc umbrel:real-node-password getblockchaininfo | grep -q '"chain"' && { started=1; break; }
    sleep 1
  done
  [[ ${started} -eq 1 ]] && ok "a real soqucoind starts on the generated config and accepts the password" \
    || bad "a real soqucoind starts on the generated config" "$(tail -5 "${NODE_DATADIR}/regtest/debug.log" 2>/dev/null)"
  code=$(curl -s -o /dev/null -w '%{http_code}' --user "umbrel:not-the-password" \
    --data '{"jsonrpc":"1.0","id":"t","method":"getblockchaininfo","params":[]}' "http://127.0.0.1:${NODE_RPC_PORT}/")
  [[ "${code}" == "401" ]] && ok "the generated rpcauth rejects a wrong password" || bad "the rpcauth rejects a wrong password" "HTTP ${code}"
  wallet="$(rpc umbrel:real-node-password getbalance)"
  [[ "${wallet}" == *"Method not found"* ]] && ok "the wallet really is disabled" || bad "the wallet really is disabled" "${wallet:0:160}"

  if PATH="${BIN}:${PATH}" SOQUCOIN_DATA="${NODE_DATADIR}" DATA_ROOT="${WORK}/realdata" \
       RPC_PASSWORD="real-node-password" SOQUCOIN_CLI_ARGS="-regtest" bash "${HEALTHCHECK}" >/dev/null 2>&1; then
    ok "healthcheck reports healthy against the running node"
  else
    bad "healthcheck reports healthy against the running node"
  fi
  "${BIN}/soqucoin-cli" -datadir="${NODE_DATADIR}" -conf="${NODE_DATADIR}/soqucoin.conf" \
    -regtest -rpcuser=umbrel -rpcpassword=real-node-password stop >/dev/null 2>&1
  for _ in $(seq 1 15); do rpc umbrel:real-node-password getbestblockhash | grep -q result || break; sleep 1; done
  if PATH="${BIN}:${PATH}" SOQUCOIN_DATA="${NODE_DATADIR}" DATA_ROOT="${WORK}/realdata" \
       RPC_PASSWORD="real-node-password" SOQUCOIN_CLI_ARGS="-regtest" bash "${HEALTHCHECK}" >/dev/null 2>&1; then
    bad "healthcheck reports unhealthy once the node is gone"
  else
    ok "healthcheck reports unhealthy once the node is gone"
  fi
  NODE_DATADIR=""
fi

echo
if [[ ${FAIL} -eq 0 ]]; then green "${PASS} checks passed, 0 failed"; exit 0
else red "${PASS} passed, ${FAIL} FAILED"; exit 1; fi
