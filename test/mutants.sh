#!/usr/bin/env bash
#
# Mutation testing: proof that the suites fail when the code is wrong.
#
# A passing test suite says nothing on its own. Two of this repo's tests were
# once VACUOUS — they passed against code that did nothing — and the way that
# was found was by breaking the code and watching them pass anyway. This script
# does that on purpose and in CI: it takes a copy of the tree, makes one
# specific, plausible mistake in it, runs the suite that is supposed to catch
# that mistake, and fails if the suite still passes.
#
# Every mutant below is a bug someone could actually write, not a random
# character swap. The comment on each says which single check is meant to die.
#
#   ./test/mutants.sh            all mutants
#   ./test/mutants.sh health     only mutants whose name contains "health"
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILTER="${1:-}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

PASS=0
FAIL=0

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

# Exact-substring replacement, and it REFUSES when the target is not there.
#
# This is the part that keeps the mutation harness itself honest. A mutant whose
# pattern has drifted out of the source would otherwise apply nothing, the suite
# would pass for the ordinary reason, and this script would report that as a
# caught mutant — a green light meaning the exact opposite of what it says.
apply_mutant() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys
path, find, repl = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path, encoding='utf-8').read()
n = src.count(find)
if n != 1:
    sys.stderr.write(f"mutant target found {n} times in {path}, expected exactly 1\n")
    sys.exit(2)
open(path, 'w', encoding='utf-8').write(src.replace(find, repl))
PY
}

mutant() {
  local name="$1" file="$2" find="$3" repl="$4" suite="$5"
  if [[ -n "${FILTER}" && "${name}" != *"${FILTER}"* ]]; then return 0; fi

  local slug tree
  slug="$(echo "${name}" | tr ' /:' '___')"
  tree="${WORK}/${slug}"
  rm -rf "${tree}"
  mkdir -p "${tree}"
  cp -R "${REPO_ROOT}/images" "${REPO_ROOT}/test" "${tree}/"

  if ! apply_mutant "${tree}/${file}" "${find}" "${repl}" 2>"${WORK}/apply.err"; then
    FAIL=$((FAIL + 1))
    red "  ✗ ${name}"
    printf '      could not apply the mutation: %s\n' "$(cat "${WORK}/apply.err")"
    return 0
  fi

  if (cd "${tree}" && node "${suite}" >"${WORK}/out.txt" 2>&1); then
    FAIL=$((FAIL + 1))
    red "  ✗ ${name}"
    printf '      %s still passed with this bug in place\n' "${suite}"
    return 0
  fi
  PASS=$((PASS + 1))
  green "  ✓ ${name}"
  # Which check actually died, so a mutant caught by the wrong check is visible
  # rather than merely counted.
  dim "      caught by: $(grep -m1 'FAIL ' "${WORK}/out.txt" | sed 's/^ *//' || echo 'the suite exited non-zero')"
}

echo
echo "Mutation testing — every line below breaks the code on purpose"
echo

# ---------------------------------------------------------------- node alarm
mutant "health: alarm without waiting out the startup grace" \
  "images/stratum/src/health.js" \
  "if (waiting >= this.startupGraceMs) {" \
  "if (waiting >= 0) {" \
  "test/health.js"

# The texts carry a duration that grows on every tick. Comparing those instead
# of the keys turns one outage into a notification every fifteen seconds.
mutant "health: notification signature built from texts, not keys" \
  "images/stratum/src/health.js" \
  "const signature = alerts.map((a) => a.key).sort().join(',');" \
  "const signature = alerts.map((a) => a.text).sort().join(',');" \
  "test/health.js"

mutant "health: threshold off by one comparison" \
  "images/stratum/src/health.js" \
  "      if (failedFor >= this.alarmAfterMs) {" \
  "      if (failedFor > this.alarmAfterMs) {" \
  "test/health.js"

mutant "health: restart while a block submission is in flight" \
  "images/stratum/src/health.js" \
  "if ((input.pending || 0) > 0) return false;" \
  "if (false) return false;" \
  "test/health.js"

mutant "health: restart-loop during a real node outage" \
  "images/stratum/src/health.js" \
  "    if (snap.templateError) return false;" \
  "    if (false) return false;" \
  "test/health.js"

mutant "health: aux alarm raised on a Dogecoin-only pool" \
  "images/stratum/src/health.js" \
  "if (snap.mergedMining && snap.auxError) {" \
  "if (snap.auxError) {" \
  "test/health.js"

# --------------------------------------------------------------- aux longpoll
mutant "longpoll: the id-collecting first call counted as a tip movement" \
  "images/stratum/src/pool.js" \
  "        if (id) {
          this.auxLongpollSignals++;" \
  "        if (true) {
          this.auxLongpollSignals++;" \
  "test/aux_longpoll.js"

# A stale id returns instantly, so this is the difference between following the
# tip and hammering the RPC threads a found block needs.
mutant "longpoll: answers never update the stored id" \
  "images/stratum/src/pool.js" \
  "        if (nextId) this.lastAuxLongpollId = nextId;" \
  "        if (false) this.lastAuxLongpollId = nextId;" \
  "test/aux_longpoll.js"

mutant "longpoll: no throttle between iterations" \
  "images/stratum/src/pool.js" \
  "      // The same belt and braces as the parent loop. A spent longpollid returns
      // instantly, and an unthrottled retry would eat exactly the RPC capacity
      // that submitauxblock needs at exactly the moment it needs it.
      const elapsed = Date.now() - startedAt;
      if (elapsed < this.config.minLongpollIntervalMs) {
        await sleep(this.config.minLongpollIntervalMs - elapsed);
      }" \
  "      const elapsed = Date.now() - startedAt;
      void elapsed;" \
  "test/aux_longpoll.js"

mutant "longpoll: every submit failure treated as a moved tip" \
  "images/stratum/src/pool.js" \
  "if (/block hash unknown/i.test(err.message)) {" \
  "if (/./i.test(err.message)) {" \
  "test/aux_longpoll.js"

mutant "longpoll: a second loop started in Dogecoin-only mode" \
  "images/stratum/src/pool.js" \
  "return !!(this.merged && this.config.auxLongpoll);" \
  "return !!this.config.auxLongpoll;" \
  "test/aux_longpoll.js"

# ------------------------------------------------------------------- the reset
mutant "reset: the reject reasons are left behind" \
  "images/stratum/src/store.js" \
  "      s.rejectReasons = {};
      for (const w of Object.values(s.workers)) {" \
  "      for (const w of Object.values(s.workers)) {" \
  "test/reset.js"

mutant "reset: never reaches the disk" \
  "images/stratum/src/store.js" \
  "    const saved = this.save(true);" \
  "    const saved = true;" \
  "test/reset.js"

mutant "reset: the connected miners keep their counters" \
  "images/stratum/src/pool.js" \
  "      for (const c of this.clients.values()) {
        c.accepted = 0;
        c.rejected = 0;
        c.rejectReasons = {};
      }" \
  "" \
  "test/reset.js"

# The luck denominator. Clearing it leaves "1 block found, 8.0e+10% luck".
mutant "reset: the cumulative work is cleared with the counters" \
  "images/stratum/src/store.js" \
  "        w.rejectReasons = {};
      }
      cleared.push('counters');" \
  "        w.rejectReasons = {};
        w.work = 0;
      }
      cleared.push('counters');" \
  "test/reset.js"

mutant "reset: a refused reset still stamps the live counters" \
  "images/stratum/src/pool.js" \
  "    if (!scope.counters && !scope.best && !scope.history) return false;" \
  "    if (false) return false;" \
  "test/reset.js"

mutant "reset: the hashrate window is cleared with the counters" \
  "images/stratum/src/pool.js" \
  "      for (const c of this.clients.values()) c.bestShareDiff = 0;" \
  "      for (const c of this.clients.values()) { c.bestShareDiff = 0; c.shareTimes = []; }" \
  "test/reset.js"

# ---------------------------------------------------- the wiring, not the parts
# Every mutant in this block is one a reviewer planted by hand and watched
# survive, because the suites tested the pieces and not the assembly.

mutant "wiring: the aux longpoll is never launched by start()" \
  "images/stratum/src/pool.js" \
  "    if (this.wantsAuxLongpoll()) this.auxLongPollLoop();" \
  "" \
  "test/pool_wiring.js"

mutant "wiring: the loop keeps re-arming after timing out" \
  "images/stratum/src/pool.js" \
  "          if (timeouts >= this.auxLongpollMaxTimeouts) {" \
  "          if (false) {" \
  "test/pool_wiring.js"

mutant "wiring: a mempool-driven return counted as a tip movement" \
  "images/stratum/src/pool.js" \
  "        const moved = !!(tip && this.lastAuxTip && tip !== this.lastAuxTip);" \
  "        const moved = !!tip;" \
  "test/pool_wiring.js"

# The headline claim of the release. Reverting /health to its 1.3.x form used to
# leave every suite green, because none of them ever had a running pool.
mutant "health: /health goes back to checking only its own web server" \
  "images/stratum/src/server.js" \
  "    const healthy = pool !== null && !startupError && report.level !== 'down';" \
  "    const healthy = pool !== null && !startupError;" \
  "test/health_live.js"

# Without the rethrow, execution falls through to the success bookkeeping that
# clears templateError and stamps a fresh lastTemplateAt — the exact hole this
# release closed, in which miners sit on stale work behind a green dashboard.
mutant "health: a template that cannot become a job still counts as work" \
  "images/stratum/src/pool.js" \
  "        err,
        'unusable'
      );
      throw err;" \
  "        err,
        'unusable'
      );" \
  "test/pool_wiring.js"

# ------------------------------------------------------------- the HTTP surface
mutant "http: the status endpoint stops carrying the alarms" \
  "images/stratum/src/server.js" \
  "      JSON.stringify(snap ? { ok: true, ...snap, ...alarm } : { ok: false, error: startupError, ...alarm })" \
  "      JSON.stringify(snap ? { ok: true, ...snap } : { ok: false, error: startupError })" \
  "test/health_http.js"

mutant "http: the reset endpoint drops its cross-site guard" \
  "images/stratum/src/server.js" \
  "function refuseCrossSite(req, reply) {
  if (sameOriginPost(req)) return false;
  reply(403, { ok: false, error: 'cross-site request refused' });
  return true;
}" \
  "function refuseCrossSite(req, reply) {
  return false;
}" \
  "test/health_http.js"

# --------------------------------------------------------- previously fixed bugs
# The ordering guard from 1.3.3. It is the heaviest bug this app has had, so it
# gets a standing mutant rather than a one-off manual check.
mutant "ordering: a late template is allowed to drag the parent back" \
  "images/stratum/src/pool.js" \
  "      askedAt < (this.currentJob.fetchedAt || 0) &&" \
  "      false &&" \
  "test/merged_ordering.js"

# The MWEB presence flag. Without it every Litecoin block this pool ever finds
# is rejected with mweb-missing, while the Dogecoin half keeps working.
mutant "mweb: the presence flag is dropped" \
  "images/stratum/src/merged.js" \
  "if (this.mweb) parts.push(Buffer.from([0x01]), Buffer.from(this.mweb, 'hex'));" \
  "if (this.mweb) parts.push(Buffer.from(this.mweb, 'hex'));" \
  "test/mweb_serialisation.js"

# The pool overview counts PEP hashrate over the workers that report a Pepecoin
# address. Reporting the Litecoin one there would count every public miner.
mutant "snapshot: a worker's Pepecoin address taken from the wrong field" \
  "images/stratum/src/pool.js" \
  "pepPayoutAddress: c.pepPayoutAddress || null," \
  "pepPayoutAddress: c.ltcPayoutAddress || null," \
  "test/pep_snapshot_unit.js"

echo
if [[ ${FAIL} -eq 0 ]]; then
  green "${PASS} mutant(s) planted, ${PASS} caught"
  exit 0
fi
red "${PASS} caught, ${FAIL} SURVIVED — a suite passes with a real bug in place"
exit 1
