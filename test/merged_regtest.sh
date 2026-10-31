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
DOGE_PEER_RPC="$((DOGE_RPC + 2))"
PEP_RPC="${PEP_RPC:-24655}"
PEP_P2P="$((PEP_RPC + 1))"
PEP_PEER_RPC="$((PEP_RPC + 2))"
SOQ_RPC="${SOQ_RPC:-24755}"
SOQ_P2P="$((SOQ_RPC + 1))"

cleanup() {
  for d in "${WORK}/ltc" "${WORK}/ltcpeer"; do
    "${WORK}/litecoin/bin/litecoin-cli" -regtest -datadir="${d}" stop >/dev/null 2>&1 || true
  done
  for d in "${WORK}/doge" "${WORK}/dogepeer"; do
    "${WORK}/dogecoin/bin/dogecoin-cli" -regtest -datadir="${d}" stop >/dev/null 2>&1 || true
  done
  "${WORK}/pepecoin/bin/pepecoin-cli" -regtest -datadir="${WORK}/pep" -rpcport="${PEP_RPC}" \
    -rpcuser=test -rpcpassword=test stop >/dev/null 2>&1 || true
  "${WORK}/pepecoin/bin/pepecoin-cli" -regtest -datadir="${WORK}/peppeer" -rpcport="${PEP_PEER_RPC}" \
    -rpcuser=peer -rpcpassword=peer stop >/dev/null 2>&1 || true
  "${WORK}/soqucoin/soqucoin-cli" -regtest -datadir="${WORK}/soq" -rpcport="${SOQ_RPC}" \
    -rpcuser=test -rpcpassword=test stop >/dev/null 2>&1 || true
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
fetch pepecoin "${REPO_ROOT}/images/pep-core/Dockerfile" PEPECOIN_VERSION \
  https://github.com/pepecoinppc/pepecoin/releases/download

# Soqucoin names its release files differently (soqucoin-v2.6.1-linux-x64.tar.gz,
# both binaries at the root), so it gets its own fetch, pinned the same way.
SOQ_DOCKERFILE="${REPO_ROOT}/images/soq-core/Dockerfile"
SOQ_VERSION="$(pin "${SOQ_DOCKERFILE}" SOQUCOIN_VERSION)"
SOQ_SHA="$(pin "${SOQ_DOCKERFILE}" "${SHA_ARG}")"
case "${ARCH}" in x86_64-linux-gnu) SOQ_ARCH=linux-x64 ;; *) SOQ_ARCH=linux-arm64 ;; esac
SOQ_TARBALL="soqucoin-v${SOQ_VERSION}-${SOQ_ARCH}.tar.gz"
SOQ_CACHE="${TMPDIR:-/tmp}/${SOQ_TARBALL}"
if [[ ! -f "${SOQ_CACHE}" ]]; then
  curl -fsSL --retry 3 -o "${SOQ_CACHE}" \
    "https://github.com/soqucoin/soqucoin/releases/download/v${SOQ_VERSION}/${SOQ_TARBALL}"
fi
if [[ "$(sha256 "${SOQ_CACHE}")" != "${SOQ_SHA}" ]]; then
  echo "${SOQ_TARBALL} does not match the SHA256 pinned in images/soq-core/Dockerfile"; exit 1
fi
mkdir -p "${WORK}/soqucoin" && tar -xzf "${SOQ_CACHE}" -C "${WORK}/soqucoin"
echo "soqucoin ${SOQ_VERSION} (sha256 verified)"

LTCD="${WORK}/litecoin/bin/litecoind"
LTCC="${WORK}/litecoin/bin/litecoin-cli"
DOGED="${WORK}/dogecoin/bin/dogecoind"
DOGEC="${WORK}/dogecoin/bin/dogecoin-cli"
mkdir -p "${WORK}/ltc" "${WORK}/ltcpeer" "${WORK}/doge" "${WORK}/dogepeer" "${WORK}/pep" "${WORK}/peppeer"

# The suites log in as test/test, the default the .js files were written for.
"${LTCD}" -regtest -datadir="${WORK}/ltc" -server=1 -listen=1 -port="${LTC_P2P}" \
  -rpcuser=test -rpcpassword=test -rpcport="${LTC_RPC}" -fallbackfee=0.0001 -daemon >/dev/null
"${DOGED}" -regtest -datadir="${WORK}/doge" -server=1 -listen=1 -port="${DOGE_P2P}" \
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
# One coinbase past Litecoin's 100-block maturity, so the public suite can put
# a real transaction in the mempool and exercise a non-trivial merkle path.
ltc_cli generatetoaddress 101 "$(ltc_cli getnewaddress)" >/dev/null

# Dogecoin regtest (src/chainparams.cpp, v1.14.9): auxpow becomes valid at
# height 20 and coinbases mature after 60 blocks. 80 clears both.
doge_cli generate 80 >/dev/null
# dogecoind 1.14.9 refuses getblocktemplate without peers even on regtest
# (createauxblock is exempt), and the public suite builds its own Dogecoin
# block from a template — so it gets a peer too.
"${DOGED}" -regtest -datadir="${WORK}/dogepeer" -server=1 -listen=0 -disablewallet=1 \
  -rpcuser=test -rpcpassword=test -rpcport="${DOGE_PEER_RPC}" \
  -connect="127.0.0.1:${DOGE_P2P}" -daemon >/dev/null
for _ in $(seq 1 60); do [[ "$(doge_cli getconnectioncount 2>/dev/null)" == "1" ]] && break; sleep 1; done

# Pepecoin regtest shares Dogecoin regtest's default ports AND its network
# magic (src/chainparams.cpp, 1.1.0), so it gets its own ports and its peer is
# pointed at it explicitly: two daemons that speak the same magic must only
# ever meet their own kind. Same auxpow height (20) and coinbase maturity (60)
# as Dogecoin's regtest, and the same getblocktemplate peer requirement — the
# public mode builds Pepecoin blocks from a template, so it needs the peer.
"${WORK}/pepecoin/bin/pepecoind" -regtest -datadir="${WORK}/pep" -server=1 -listen=1 -dnsseed=0 \
  -bind=127.0.0.1 -port="${PEP_P2P}" -rpcuser=test -rpcpassword=test -rpcport="${PEP_RPC}" -txindex=1 -daemon >/dev/null
pep_cli() { "${WORK}/pepecoin/bin/pepecoin-cli" -regtest -datadir="${WORK}/pep" -rpcport="${PEP_RPC}" -rpcuser=test -rpcpassword=test "$@"; }
for _ in $(seq 1 60); do pep_cli getblockcount >/dev/null 2>&1 && break; sleep 1; done
echo "$(pep_cli -version | head -1)"
pep_cli generate 80 >/dev/null
"${WORK}/pepecoin/bin/pepecoind" -regtest -datadir="${WORK}/peppeer" -server=1 -listen=0 -dnsseed=0 -disablewallet=1 \
  -rpcuser=peer -rpcpassword=peer -rpcport="${PEP_PEER_RPC}" -connect="127.0.0.1:${PEP_P2P}" -daemon >/dev/null
for _ in $(seq 1 60); do [[ "$(pep_cli getconnectioncount 2>/dev/null)" == "1" ]] && break; sleep 1; done

# Soqucoin regtest: its own ports (its network magic is Dogecoin regtest's),
# no peer and no wallet. Regtest mines on demand, so createauxblock answers
# without a peer or a recent tip; the suite itself mines the first 25 blocks,
# past the auxpow start height of 20, to an sq1p address it makes up.
mkdir -p "${WORK}/soq"
"${WORK}/soqucoin/soqucoind" -regtest -datadir="${WORK}/soq" -server=1 -listen=1 -dnsseed=0 \
  -bind=127.0.0.1 -port="${SOQ_P2P}" -rpcuser=test -rpcpassword=test -rpcport="${SOQ_RPC}" \
  -txindex=1 -disablewallet=1 -daemon >/dev/null
soq_cli() { "${WORK}/soqucoin/soqucoin-cli" -regtest -datadir="${WORK}/soq" -rpcport="${SOQ_RPC}" -rpcuser=test -rpcpassword=test "$@"; }
for _ in $(seq 1 60); do soq_cli getblockcount >/dev/null 2>&1 && break; sleep 1; done
echo "$(soq_cli -version | head -1)"

echo "litecoin height $(ltc_cli getblockcount), dogecoin height $(doge_cli getblockcount), dogecoin peers $(doge_cli getconnectioncount), pepecoin height $(pep_cli getblockcount), pepecoin peers $(pep_cli getconnectioncount)"

STRATUM_PORT="${STRATUM_PORT:-24600}"
status=0
# Proofs against the daemons first, then the real pool started against them:
# private merged mining, the public port, and both side by side.
for suite in merged_regtest public_aux_regtest merged_pool public_merged_pool public_coexist; do
  [[ -f "${REPO_ROOT}/test/${suite}.js" ]] || continue
  echo
  echo "== ${suite}"
  node "${REPO_ROOT}/test/${suite}.js" "${LTC_RPC}" "${DOGE_RPC}" "${STRATUM_PORT}" || status=1
  STRATUM_PORT=$((STRATUM_PORT + 10))
  # getblocktemplate hands back its cached template until the tip moves or 5
  # seconds have passed since it was built (src/rpc/mining.cpp, Litecoin and
  # Dogecoin alike). A suite that sends a transaction and expects the next
  # template to carry it would otherwise see the previous suite's template.
  sleep 6
done

# Two aux chains under one parent: Dogecoin and Pepecoin from the same
# Litecoin block, built by the pool's own MergedJob.
if [[ -f "${REPO_ROOT}/test/pep_merged_regtest.js" ]]; then
  echo
  echo "== pep_merged_regtest"
  node "${REPO_ROOT}/test/pep_merged_regtest.js" "${LTC_RPC}" "${DOGE_RPC}" "${PEP_RPC}" || status=1
fi
# Soqucoin as the third aux chain, through the pool. Before the Pepecoin pool
# suite, which stops pepecoind; this one stops soqucoind at its end.
if [[ -f "${REPO_ROOT}/test/soq_pool_regtest.js" ]]; then
  sleep 6
  echo
  echo "== soq_pool_regtest"
  node "${REPO_ROOT}/test/soq_pool_regtest.js" "${LTC_RPC}" "${DOGE_RPC}" "${PEP_RPC}" "${SOQ_RPC}" "$((STRATUM_PORT + 100))" || status=1
fi
# Last, because its final part stops pepecoind on purpose.
if [[ -f "${REPO_ROOT}/test/pep_pool_regtest.js" ]]; then
  sleep 6
  echo
  echo "== pep_pool_regtest"
  node "${REPO_ROOT}/test/pep_pool_regtest.js" "${LTC_RPC}" "${DOGE_RPC}" "${PEP_RPC}" "${STRATUM_PORT}" || status=1
fi
exit "${status}"
