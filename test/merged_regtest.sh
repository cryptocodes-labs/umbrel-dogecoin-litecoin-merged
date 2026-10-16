#!/usr/bin/env bash
#
# Fetches the Litecoin Core and Dogecoin Core releases the images build, starts
# both in regtest, and runs the merged-mining suites against them: a real
# Dogecoin block committed into a real Litecoin parent, accepted by BOTH nodes.
#
# The binaries and their SHA256 pins come from images/ltc-core/Dockerfile and
# images/core/Dockerfile, so a version bump there is exactly what gets tested
# here — this suite cannot drift to a different node than the one that ships.
#
#   ./test/merged_regtest.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
LTC_RPC="${LTC_RPC:-24332}"
LTC_P2P="$((LTC_RPC + 1))"
LTC_PEER_RPC="$((LTC_RPC + 2))"
LTC_PEER_P2P="$((LTC_RPC + 3))"
DOGE_RPC="${DOGE_RPC:-24555}"
DOGE_P2P="$((DOGE_RPC + 1))"

cleanup() {
  for d in "${WORK}/ltc" "${WORK}/ltcpeer"; do
    "${WORK}/litecoin/bin/litecoin-cli" -regtest -datadir="${d}" stop >/dev/null 2>&1 || true
  done
  "${WORK}/dogecoin/bin/dogecoin-cli" -regtest -datadir="${WORK}/doge" stop >/dev/null 2>&1 || true
  sleep 2
  rm -rf "${WORK}"
}
trap cleanup EXIT

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
pin() { sed -n "s/^ARG $2=\([0-9a-f.]*\)$/\1/p" "$1" | head -1; }

case "$(uname -m)" in
  x86_64) ARCH="x86_64-linux-gnu"; SHA_ARG="SHA256_AMD64" ;;
  aarch64|arm64) ARCH="aarch64-linux-gnu"; SHA_ARG="SHA256_ARM64" ;;
  *) echo "Unsupported test architecture $(uname -m)"; exit 1 ;;
esac

# fetch <name> <dockerfile> <version-arg> <release-url-base>
fetch() {
  local name="$1" dockerfile="$2" version_arg="$3" base="$4"
  local version sha tarball cache
  version="$(pin "${dockerfile}" "${version_arg}")"
  sha="$(pin "${dockerfile}" "${SHA_ARG}")"
  tarball="${name}-${version}-${ARCH}.tar.gz"
  cache="${TMPDIR:-/tmp}/${tarball}"
  if [[ ! -f "${cache}" ]]; then
    curl -fsSL --retry 3 -o "${cache}" "${base}/v${version}/${tarball}"
  fi
  if [[ "$(sha256 "${cache}")" != "${sha}" ]]; then
    echo "${tarball} does not match the SHA256 pinned in ${dockerfile#"${REPO_ROOT}/"}"; exit 1
  fi
  mkdir -p "${WORK}/${name}" && tar -xzf "${cache}" -C "${WORK}/${name}" --strip-components=1
  echo "${name} ${version} (sha256 verified)"
}
fetch litecoin "${REPO_ROOT}/images/ltc-core/Dockerfile" LITECOIN_VERSION \
  https://github.com/litecoin-project/litecoin/releases/download
fetch dogecoin "${REPO_ROOT}/images/core/Dockerfile" DOGECOIN_VERSION \
  https://github.com/dogecoin/dogecoin/releases/download

LTCD="${WORK}/litecoin/bin/litecoind"
LTCC="${WORK}/litecoin/bin/litecoin-cli"
DOGED="${WORK}/dogecoin/bin/dogecoind"
DOGEC="${WORK}/dogecoin/bin/dogecoin-cli"
mkdir -p "${WORK}/ltc" "${WORK}/ltcpeer" "${WORK}/doge"

# The suites log in as test/test, the default the .js files were written for.
"${LTCD}" -regtest -datadir="${WORK}/ltc" -server=1 -listen=1 -port="${LTC_P2P}" \
  -rpcuser=test -rpcpassword=test -rpcport="${LTC_RPC}" -fallbackfee=0.0001 -daemon >/dev/null
"${DOGED}" -regtest -datadir="${WORK}/doge" -server=1 -listen=0 -port="${DOGE_P2P}" \
  -rpcuser=test -rpcpassword=test -rpcport="${DOGE_RPC}" -txindex=1 -daemon >/dev/null

ltc_cli()  { "${LTCC}" -regtest -datadir="${WORK}/ltc" -rpcport="${LTC_RPC}" -rpcuser=test -rpcpassword=test "$@"; }
doge_cli() { "${DOGEC}" -regtest -datadir="${WORK}/doge" -rpcport="${DOGE_RPC}" -rpcuser=test -rpcpassword=test "$@"; }
for _ in $(seq 1 60); do ltc_cli getblockcount >/dev/null 2>&1 && break; sleep 1; done
for _ in $(seq 1 60); do doge_cli getblockcount >/dev/null 2>&1 && break; sleep 1; done
echo "$(ltc_cli -version | head -1) / $(doge_cli -version | head -1)"

# Litecoin's getblocktemplate refuses while the node has no peers or is in
# initial block download, and both hold for an empty regtest chain. A throwaway
# peer connects and mines two blocks with a current timestamp, which clears
# both conditions — the same arrangement test/ltc_entrypoint.sh uses.
"${LTCD}" -regtest -datadir="${WORK}/ltcpeer" -server=1 -listen=0 -port="${LTC_PEER_P2P}" \
  -rpcuser=test -rpcpassword=test -rpcport="${LTC_PEER_RPC}" \
  -connect="127.0.0.1:${LTC_P2P}" -daemon >/dev/null
peer_cli() { "${LTCC}" -regtest -datadir="${WORK}/ltcpeer" -rpcport="${LTC_PEER_RPC}" -rpcuser=test -rpcpassword=test "$@"; }
for _ in $(seq 1 60); do peer_cli getblockcount >/dev/null 2>&1 && break; sleep 1; done
# Litecoin Core 0.21 loads no wallet unless one exists; the suites ask both
# nodes for addresses.
peer_cli createwallet miner >/dev/null
ltc_cli createwallet pool >/dev/null
peer_cli generatetoaddress 2 "$(peer_cli getnewaddress)" >/dev/null
for _ in $(seq 1 30); do [[ "$(ltc_cli getblockcount)" -ge 2 ]] && break; sleep 1; done
[[ "$(ltc_cli getblockcount)" -ge 2 ]] || { echo "litecoind never received the peer's blocks"; exit 1; }

status=0
for suite in merged_regtest public_aux_regtest; do
  [[ -f "${REPO_ROOT}/test/${suite}.js" ]] || continue
  echo
  echo "== ${suite}"
  node "${REPO_ROOT}/test/${suite}.js" "${LTC_RPC}" "${DOGE_RPC}" || status=1
done
exit "${status}"
