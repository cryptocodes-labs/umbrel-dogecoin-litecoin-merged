'use strict';
//
// Entry point: starts the solo pool and serves the dashboard + Umbrel widgets.
//
// Zero dependencies, same as the node's dashboard app. Everything the browser
// needs is served from this process.
//

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { Pool } = require('./pool');
const { singleAddressLookup } = require('./rpc');
const { Store } = require('./store');
const { PushService } = require('./push');
const { HealthMonitor } = require('./health');
const { Settings, VALID_PROFILES } = require('./settings');

const PORT = Number(process.env.PORT || 3000);
const STRATUM_PORT = Number(process.env.STRATUM_PORT || 3333);

// A second, optional stratum port, always at the rented profile's numbers,
// running AT THE SAME TIME as the primary one — see pool.js's onConnection.
// Unset by default, which is exactly today's single-port behaviour: nothing
// about an install that never sets this changes.
//
// The point of it: MINING_PROFILE switches the ONE port between two regimes,
// so a home ASIC and a rented order can never both be connected and correct
// at once — whichever one the port isn't currently set for gets the wrong
// difficulty and either floods the flood limit or starves at a difficulty it
// can't reach. Two ports sidesteps the choice: point home miners at
// STRATUM_PORT as always, point a rented order at this one, and neither
// setup ever has to know the other exists.
let RENTED_STRATUM_PORT = null;
{
  const raw = process.env.RENTED_STRATUM_PORT;
  if (raw !== undefined && raw.trim() !== '') {
    const v = Number(raw);
    if (!Number.isInteger(v) || v <= 0 || v > 65535) {
      console.error(`[config] RENTED_STRATUM_PORT="${raw}" is not a valid port; the rented-capacity port stays off`);
    } else if (v === STRATUM_PORT || v === PORT) {
      console.error(`[config] RENTED_STRATUM_PORT (${v}) clashes with an existing port; the rented-capacity port stays off`);
    } else {
      RENTED_STRATUM_PORT = v;
    }
  }
}

// Two very different machines point at this pool, and one set of numbers cannot
// serve both.
//
// A home miner does tens of megahashes. A rented order does tens of GIGAhashes
// — three to four orders of magnitude more — and every limit that protects the
// app from a stranger becomes the thing that refuses the hashpower you paid for.
// At the home defaults a 100 GH/s order starts by submitting roughly 750 shares
// a second, trips the flood limit, and is disconnected before vardiff has had a
// chance to raise its difficulty. The order shows as failing and the money is
// spent either way.
//
// So the profile is one setting rather than a dozen. Anything set explicitly in
// the environment still wins over the profile — see num() below.
const PROFILES = {
  home: {},
  rented: {
    // Start where a rented order belongs: one share every few seconds, not
    // hundreds a second. Vardiff still tunes from here.
    START_DIFFICULTY: 1048576,
    // A brief dip in delivered hashrate must not drop it back into the flood.
    MIN_DIFFICULTY: 65536,
    // The home ceiling silently pins a large order at four times the intended
    // share rate.
    MAX_DIFFICULTY: 268435456,
    // Headroom for the first seconds, before vardiff has settled.
    MAX_MESSAGES_PER_10S: 1000,
    // An order arrives as many connections from a handful of the provider's own
    // addresses, so the per-IP cap is what would lock it out.
    MAX_CONNECTIONS: 256,
    MAX_CONNECTIONS_PER_IP: 256,
    // Their aggregator applies a difficulty change slowly, and work handed out
    // before it lands must still be accepted.
    DIFFICULTY_GRACE_SECONDS: 120,
    // A connection at high difficulty is legitimately quiet for minutes.
    SOCKET_TIMEOUT_SECONDS: 1800,
    PING_INTERVAL_SECONDS: 300,
    // With the payout locked there is no reason to build coinbase variants.
    MAX_PAYOUT_VARIANTS: 1,
  },
};

const PROFILE_NAME = (process.env.MINING_PROFILE || 'home').trim().toLowerCase();
const PROFILE = PROFILES[PROFILE_NAME] || {};
if (!PROFILES[PROFILE_NAME]) {
  console.error(`[config] unknown MINING_PROFILE "${PROFILE_NAME}"; using the home profile`);
}

function num(name, fallback) {
  const raw = process.env[name];
  // An explicit value always beats the profile, which always beats the default.
  if (raw === undefined || raw === '') {
    return Object.prototype.hasOwnProperty.call(PROFILE, name) ? PROFILE[name] : fallback;
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    console.error(`[config] ${name}="${raw}" is not a number; using ${fallback}`);
    return fallback;
  }
  return v;
}

// Whether MINING_PROFILE came from the environment. An operator who set it
// explicitly meant to fix it, so the dashboard's profile toggle (see
// applyMiningProfile() below) refuses to touch anything in that case rather
// than silently overriding a deliberate .env choice.
const profileLockedByEnv =
  typeof process.env.MINING_PROFILE === 'string' && process.env.MINING_PROFILE.trim() !== '';

// The same resolution num() does — explicit env wins, then the named
// profile, then the fallback — but parametrised on a profile NAME instead of
// closed over the one PROFILE picked at startup. That is what lets the
// profile be switched again later, from applyMiningProfile(), without
// restarting the process: config's initial values are themselves computed
// from this (see the Object.assign right after config is built below), so
// there is exactly one place that knows what each profile means.
function resolveProfileField(envKey, profileName, fallback, toMs) {
  const raw = process.env[envKey];
  let v;
  if (raw !== undefined && raw !== '') {
    v = Number(raw);
    if (!Number.isFinite(v)) v = fallback;
  } else {
    const p = PROFILES[profileName] || {};
    v = Object.prototype.hasOwnProperty.call(p, envKey) ? p[envKey] : fallback;
  }
  return toMs ? v * 1000 : v;
}

function computeProfileFields(profileName) {
  return {
    startDifficulty: resolveProfileField('START_DIFFICULTY', profileName, 2048),
    minDifficulty: resolveProfileField('MIN_DIFFICULTY', profileName, 64),
    maxDifficulty: resolveProfileField('MAX_DIFFICULTY', profileName, 4194304),
    maxMessagesPer10s: resolveProfileField('MAX_MESSAGES_PER_10S', profileName, 300),
    maxConnections: resolveProfileField('MAX_CONNECTIONS', profileName, 64),
    maxConnectionsPerIp: resolveProfileField('MAX_CONNECTIONS_PER_IP', profileName, 8),
    maxPayoutVariants: resolveProfileField('MAX_PAYOUT_VARIANTS', profileName, 16),
    difficultyGraceMs: resolveProfileField('DIFFICULTY_GRACE_SECONDS', profileName, 60, true),
    socketTimeoutMs: resolveProfileField('SOCKET_TIMEOUT_SECONDS', profileName, 900, true),
    pingIntervalMs: resolveProfileField('PING_INTERVAL_SECONDS', profileName, 60, true),
  };
}

const config = {
  rpc: {
    host: process.env.RPC_HOST || '127.0.0.1',
    port: num('RPC_PORT', 22555),
    user: process.env.RPC_USER || 'umbrel',
    password: process.env.RPC_PASSWORD || '',
  },
  payoutAddress: (process.env.PAYOUT_ADDRESS || '').trim(),

  // --- merged mining ------------------------------------------------------
  // Off unless MERGED_MINING=1. With it on, miners hash LITECOIN headers that
  // carry a commitment to a Dogecoin block, and one share can win on both
  // chains — see auxpow.js. It needs a second node and a second payout
  // address, on the second chain, and refuses to start without them.
  mergedMining: process.env.MERGED_MINING === '1',
  ltcRpc: {
    host: process.env.LTC_RPC_HOST || '127.0.0.1',
    port: num('LTC_RPC_PORT', 9332),
    user: process.env.LTC_RPC_USER || 'umbrel',
    password: process.env.LTC_RPC_PASSWORD || '',
  },
  // A LITECOIN address. Validated against Litecoin's version bytes at startup:
  // a Dogecoin address here decodes perfectly well and would silently pay a
  // hash160 nobody on Litecoin can spend.
  ltcPayoutAddress: (process.env.LTC_PAYOUT_ADDRESS || '').trim(),
  // Public merged mining (PUBLIC_MERGED=1, needs MERGED_MINING=1): a port for
  // other people. Each miner is paid on both chains at the addresses in its
  // username, "<LTC address>.<DOGE address>[.worker]", and the two addresses
  // above receive POOL_FEE_PERCENT of every block instead. Meant to run as a
  // SEPARATE container beside the private one, never instead of it.
  publicMerged: process.env.PUBLIC_MERGED === '1',
  poolFeePercent: Number(process.env.POOL_FEE_PERCENT || 1),

  // Pepecoin, a further aux chain merge-mined beside Dogecoin (needs
  // MERGED_MINING=1). On only when PEP_RPC_HOST and PEP_PAYOUT_ADDRESS are both
  // set; without them nothing below exists and the pool is exactly what it was.
  // Optional by design: pepecoind being down, slow or misconfigured leaves
  // Pepecoin out of the jobs and never stops Litecoin or Dogecoin. Private
  // mode pays every Pepecoin block to PEP_PAYOUT_ADDRESS; public mode pays the
  // miners who add a Pepecoin address to their username, and takes the same
  // POOL_FEE_PERCENT for PEP_PAYOUT_ADDRESS.
  pep:
    process.env.PEP_RPC_HOST && (process.env.PEP_PAYOUT_ADDRESS || '').trim()
      ? {
          rpc: {
            host: process.env.PEP_RPC_HOST,
            port: num('PEP_RPC_PORT', 33873),
            user: process.env.PEP_RPC_USER || 'umbrel',
            password: process.env.PEP_RPC_PASSWORD || '',
          },
          payoutAddress: (process.env.PEP_PAYOUT_ADDRESS || '').trim(),
        }
      : null,
  pepPollMs: Math.max(500, num('PEP_POLL_MS', 2000)),

  // Soqucoin, a third aux chain beside Dogecoin and Pepecoin. On only when
  // SOQ_RPC_HOST and SOQ_PAYOUT_ADDRESS are both set, and only in PRIVATE
  // merged mode (with PUBLIC_MERGED=1 it is ignored and the log says so).
  // Every Soqucoin block pays SOQ_PAYOUT_ADDRESS, an sq1p… address. soqucoind
  // must run with enablemining=1, which mainnet does not default to.
  soq:
    process.env.SOQ_RPC_HOST && (process.env.SOQ_PAYOUT_ADDRESS || '').trim()
      ? {
          rpc: {
            host: process.env.SOQ_RPC_HOST,
            port: num('SOQ_RPC_PORT', 33389),
            user: process.env.SOQ_RPC_USER || 'umbrel',
            password: process.env.SOQ_RPC_PASSWORD || '',
          },
          payoutAddress: (process.env.SOQ_PAYOUT_ADDRESS || '').trim(),
        }
      : null,
  // Every second: a new Soqucoin tip is only seen by polling, and work built on
  // the old one can no longer win. createauxblock is answered from soqucoind's
  // cache until the tip moves, so the cost is one small call a second.
  soqPollMs: Math.max(500, num('SOQ_POLL_MS', 1000)),

  stratumPort: STRATUM_PORT,
  // Stratum-space difficulties (scrypt, so one share costs D * 2^16 hashes).
  // 2048 lands a 11 MH/s miner at ~12s per share and a 70 MH/s miner at ~2s,
  // from where vardiff climbs within seconds.
  startDifficulty: num('START_DIFFICULTY', 2048),
  minDifficulty: num('MIN_DIFFICULTY', 64),
  maxDifficulty: num('MAX_DIFFICULTY', 4194304),
  targetShareSeconds: num('TARGET_SHARE_SECONDS', 12),
  vardiffWindow: num('VARDIFF_WINDOW', 10),
  hashrateWindowMs: num('HASHRATE_WINDOW_SECONDS', 600) * 1000,
  // Two seconds, matching the compose default: in merged mode this poll is the
  // ONLY way a new Dogecoin tip is noticed — createauxblock has no longpoll —
  // so the interval is the average amount of doomed Dogecoin hashing per block.
  //
  // Floored at half a second. The value is settable from a hand-edited .env,
  // and 0 would turn setInterval into a ~1ms loop: an unbounded
  // getblocktemplate flood against the very node whose RPC threads everything
  // else here is careful to protect.
  pollIntervalMs: Math.max(0.5, num('POLL_INTERVAL_SECONDS', 2)) * 1000,
  jobRebuildMs: num('JOB_REBUILD_SECONDS', 30) * 1000,
  socketTimeoutMs: num('SOCKET_TIMEOUT_SECONDS', 900) * 1000,
  coinbaseTag: process.env.COINBASE_TAG || '/umbrel-doge-solo/',

  // --- limits -------------------------------------------------------------
  // Stratum is unauthenticated by design, so every unbounded resource is a
  // denial-of-service path for anyone who can reach the port.
  maxConnections: num('MAX_CONNECTIONS', 64),
  maxConnectionsPerIp: num('MAX_CONNECTIONS_PER_IP', 8),
  maxMessagesPer10s: num('MAX_MESSAGES_PER_10S', 300),
  maxPayoutVariants: num('MAX_PAYOUT_VARIANTS', 16),
  minLongpollIntervalMs: num('MIN_LONGPOLL_INTERVAL_MS', 250),
  handshakeTimeoutMs: num('HANDSHAKE_TIMEOUT_SECONDS', 30) * 1000,
  difficultyGraceMs: num('DIFFICULTY_GRACE_SECONDS', 60) * 1000,
  pingIntervalMs: num('PING_INTERVAL_SECONDS', 60) * 1000,
  lockPayoutAddress: process.env.LOCK_PAYOUT_ADDRESS === '1',
  profile: PROFILE_NAME in PROFILES ? PROFILE_NAME : 'home',

  // The dedicated rented-capacity port. Null (off) unless RENTED_STRATUM_PORT
  // parsed to a valid, non-clashing port above. rentedPortLimits is always
  // the 'rented' profile's numbers — not whatever MINING_PROFILE currently
  // selects for the primary port — because the whole point of this port is
  // to be correct for a rented order regardless of what the primary port is
  // doing. Anything set explicitly in the environment (START_DIFFICULTY and
  // the rest) still wins here too, exactly as it does for the primary port's
  // profile — see resolveProfileField.
  rentedStratumPort: RENTED_STRATUM_PORT,
  rentedPortLimits: RENTED_STRATUM_PORT ? computeProfileFields('rented') : null,

  // --- watching the nodes ---------------------------------------------------
  // On unless explicitly switched off: a second longpoll, against dogecoind's
  // getblocktemplate, used purely as a "the aux tip has moved" signal. See
  // Pool.auxLongPollLoop. Off falls back to the poll alone, which is what
  // 1.3.x did.
  auxLongpoll: process.env.AUX_LONGPOLL !== '0',
  // How long something must be wrong before the phone rings. Not a poll
  // interval — the check runs far more often than this.
  //
  // Floored at ten seconds, which is where a threshold stops describing an
  // outage and starts describing one slow template. This is the only place the
  // bound lives: HealthMonitor takes what it is given, so a floor here and a
  // floor there could not drift apart.
  alarmAfterMs: Math.max(10, num('ALARM_AFTER_SECONDS', 180)) * 1000,
  // How long the pool may take to come up at all before that is an alarm.
  // Longer than the threshold above by default and deliberately so: umbrelOS
  // starts every app at once, and a Dogecoin node loading its block index from
  // an SD card is legitimately unreachable for minutes after a reboot.
  startupGraceMs: Math.max(10, num('STARTUP_GRACE_SECONDS', 300)) * 1000,
  // How rarely a STANDING alarm is repeated. 0 disables the repeat.
  alarmRepeatMs: num('ALARM_REPEAT_HOURS', 6) * 3600 * 1000,
  // How long the pool may sit with no template arriving AND no node reporting
  // an error — the wedge — before this process exits so the container's
  // restart policy hands us a clean one. 0 disables it.
  stallRestartMs: num('STALL_RESTART_MINUTES', 15) * 60000,
};

// Re-derive the ten profile-dependent fields above from computeProfileFields()
// instead of trusting that its fallback numbers were copied correctly from
// the num() calls just above. Same values either way — this only removes the
// chance of the two ever drifting apart.
Object.assign(config, computeProfileFields(config.profile));

// A safety interlock, not a warning.
//
// The rented profile exists for one situation: the stratum port is reachable
// from the internet. On that port there is no authentication and no way to tell
// a paying customer from anyone else, and with the payout unlocked a stranger
// simply puts their own address in the username and your node's next block pays
// them. That is not a hypothetical — it was demonstrated against this app
// during review. Refusing to start is the only response that cannot be missed
// at two in the morning.
if (config.profile === 'rented' && !config.lockPayoutAddress) {
  console.error(
    '[config] MINING_PROFILE=rented is meant for a stratum port that is reachable from ' +
      'the internet, where anyone can mine to their own address unless the payout is locked. ' +
      'Set LOCK_PAYOUT_ADDRESS=1, or switch back to MINING_PROFILE=home.'
  );
  process.exit(1);
}

// The same interlock, for the same reason, for the dedicated rented port:
// RENTED_STRATUM_PORT exists to be reachable from the internet too, and an
// unlocked payout on an open port pays whoever asks — whether that port is
// the primary one running the rented profile, or this second one.
if (config.rentedStratumPort && !config.lockPayoutAddress) {
  console.error(
    '[config] RENTED_STRATUM_PORT is set, which opens a second stratum port meant to be reachable ' +
      'from the internet for a rented order. Set LOCK_PAYOUT_ADDRESS=1, or remove RENTED_STRATUM_PORT.'
  );
  process.exit(1);
}

// Public merged mode is defined on top of merged mining; on its own it would
// silently be a Dogecoin-only pool that ignores the username format it tells
// miners to use.
if (config.publicMerged && !config.mergedMining) {
  console.error('[config] PUBLIC_MERGED=1 requires MERGED_MINING=1.');
  process.exit(1);
}

// A way to read the effective configuration without starting anything. The
// profile is only useful if it actually reaches the pool, and asserting that
// from outside the process is the only test that proves it.
if (process.env.DUMP_CONFIG === '1') {
  // ltcRpc goes the same way as rpc: it carries a password. So do pep and soq.
  const { rpc, payoutAddress, ltcRpc, ltcPayoutAddress, pep, soq, ...safe } = config;
  console.log(`CONFIG ${JSON.stringify({
    ...safe,
    pep: pep ? { host: pep.rpc.host, port: pep.rpc.port } : null,
    soq: soq ? { host: soq.rpc.host, port: soq.rpc.port } : null,
  })}`);
  process.exit(0);
}

// Half an hour of minute samples before a per-worker average is used to judge
// anything. Below that it is a measure of how long the worker has been back,
// not of how it normally performs.
const MIN_SAMPLES_FOR_AVERAGE = 30;

const SYNC_REFRESH = '10s';
const STATS_REFRESH = '10s';

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const SERVICE_WORKER = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
const ICON_PNG = fs.readFileSync(path.join(__dirname, 'icon-192.png'));

let pool = null;
let startupError = null;

// STATS_PATH empty disables persistence entirely, which is what the test
// suites want: they must not write to the developer's disk.
const store = new Store(
  process.env.STATS_PATH === '' ? null : process.env.STATS_PATH || '/data/stats.json',
  (msg) => console.log(`[store] ${msg}`)
);
store.load();

// Push state lives beside the statistics but in its own file: it holds a
// private key, it is written on a different schedule, and a corrupt stats file
// must not cost the user their notification subscriptions or vice versa.
const push = new PushService(
  store.path ? path.join(path.dirname(store.path), 'push.json') : null,
  (msg) => console.log(`[push] ${msg}`)
);
push.load();

// The mining profile, editable from the dashboard without SSH or a restart —
// see settings.js for why this lives beside stats.json and push.json rather
// than in .env. Skipped entirely when MINING_PROFILE is set in the
// environment: that operator meant to fix it, and a leftover settings.json
// from before it was set must not silently un-fix it.
const settings = new Settings(
  store.path ? path.join(path.dirname(store.path), 'settings.json') : null,
  (msg) => console.log(`[settings] ${msg}`)
);
const savedProfile = settings.load();
if (!profileLockedByEnv && savedProfile && savedProfile !== config.profile) {
  if (savedProfile === 'rented' && !config.lockPayoutAddress) {
    // Same rule as the interlock below, applied to a profile that arrived
    // from disk instead of from .env. Refusing to start over this would turn
    // "someone toggled a dashboard switch on Tuesday" into "the pool has been
    // down since Tuesday" — falling back to home is the safe direction, and
    // the dashboard's /api/settings response says why.
    console.error(
      `[settings] saved mining profile is "rented" but LOCK_PAYOUT_ADDRESS is not 1 in .env; ` +
        'staying on "home" until that is set. Switch back from the dashboard once it is.'
    );
  } else {
    config.profile = savedProfile;
    Object.assign(config, computeProfileFields(savedProfile));
  }
}

// The one thing a profile switch actually has to change on a running pool:
// pool.config is a SEPARATE object from this one (Pool copies it with a
// spread at construction, `{ ...DEFAULT_LIMITS, ...config }` in pool.js), so
// mutating `config` alone would update nothing already connected. Every read
// pool.js does is `this.config.<field>`, fetched fresh each time rather than
// cached, so mutating pool.config's fields in place — never reassigning
// pool.config itself — reaches vardiff, new connections and the rate limiter
// immediately, with no restart and therefore no risk to a block submission in
// flight (see the stop_grace_period note in docker-compose.yml).
function applyMiningProfile(name) {
  if (profileLockedByEnv) {
    return {
      ok: false,
      code: 409,
      error: 'MINING_PROFILE is set in .env; remove it there to control this from the dashboard.',
    };
  }
  if (!VALID_PROFILES.has(name)) {
    return { ok: false, code: 400, error: `unknown profile "${name}"` };
  }
  if (name === 'rented' && !config.lockPayoutAddress) {
    return {
      ok: false,
      code: 409,
      error:
        'set LOCK_PAYOUT_ADDRESS=1 in .env before switching to "rented" — that profile assumes ' +
        'the stratum port is reachable from the internet, and an unlocked payout on an open port ' +
        'pays whoever asks.',
    };
  }
  const fields = computeProfileFields(name);
  Object.assign(config, fields, { profile: name });
  if (pool) Object.assign(pool.config, fields, { profile: name });
  const saved = settings.saveProfile(name);
  if (!saved && settings.path) {
    console.error(
      `[settings] profile switched to "${name}" but the change could not be saved (` +
        `${settings.lastError}); it will revert to the .env default on the next restart`
    );
  }
  return { ok: true, profile: name, persisted: saved };
}

// The thing that would have noticed the thirteen hours. It lives out here,
// beside the push service and not inside the Pool, because the case it exists
// for is the one where there is no Pool at all: with dogecoind unreachable,
// merged mode refuses to start and main() below retries forever, so anything
// living inside Pool would never run.
const health = new HealthMonitor({
  alarmAfterMs: config.alarmAfterMs,
  startupGraceMs: config.startupGraceMs,
  repeatMs: config.alarmRepeatMs,
  restartAfterMs: config.stallRestartMs,
  startedAt: Date.now(),
});

// One description of the world, shared by the watchdog, /health and
// /api/status, so the three can never disagree about whether this pool is
// mining.
function healthInput() {
  return {
    startupError,
    snapshot: snapshotOrNull(),
    // Told apart deliberately. snapshotOrNull() swallows a throw and returns
    // null, which is indistinguishable from "there is no pool" — and those two
    // need opposite answers: one means the node apps are down, the other means
    // this app is broken while the nodes are fine.
    poolExists: pool !== null,
    pending: pool ? pool.pending() : 0,
    // A clock that cannot step. The Umbrel has no real-time clock: umbrelOS
    // restores an approximate time at boot and NTP corrects it, by hours,
    // minutes later — with these apps already running. Every threshold in the
    // monitor is capped by this so a clock correction cannot manufacture or
    // erase an outage.
    uptimeMs: process.uptime() * 1000,
  };
}

// Every fifteen seconds. Far more often than the alarm threshold, so the moment
// a node comes back is noticed almost at once, and cheap enough that it does
// not matter: snapshot() walks a handful of connected miners.
const HEALTH_TICK_MS = 15000;

function healthTick() {
  const input = healthInput();
  const now = Date.now();
  let report;
  try {
    report = health.sample(now, input);
  } catch (err) {
    // The watchdog must never be the thing that takes the process down.
    console.error('[health] check failed:', err.message);
    return;
  }

  if (report.notify) {
    console.log(`[health] ${report.notify.text}`);
    // Payloadless, like the block notification: the service worker wakes,
    // fetches /api/status and describes what is actually wrong at that moment
    // rather than what was wrong when this was sent. See push.js.
    push
      .notifyAll(report.notify.kind === 'recovery' ? 'nodes recovered' : 'nodes unreachable')
      .catch((err) => console.error('[push]', err.message));
  }

  if (health.shouldRestart(now, input)) {
    // Deliberately the last resort, and deliberately narrow — see
    // HealthMonitor.shouldRestart for why this fires only on a wedge and never
    // during a node outage. Docker restarts a container that EXITS; a failing
    // healthcheck on its own restarts nothing outside Swarm, so this exit is
    // the only thing that can actually recover a stuck process.
    console.error(
      `[health] no block template for ${Math.round((input.snapshot.templateAgeMs || 0) / 60000)} ` +
        'minutes while the nodes report no error at all — exiting so the container restarts clean'
    );
    try { store.save(true); } catch { /* nothing left to try */ }
    process.exit(1);
  }
}

// Is this POST from our own page, or from some other site the user happens to
// have open?
//
// It matters because Umbrel's proxy authenticates with a cookie, which the
// browser attaches to cross-site requests as well. Without this check any page
// the user visits could register ITS push endpoint with this app and be told
// the moment a block is found, or evict the user's own phone from the list.
//
// Two independent gates, because browsers vary in what they send:
//   - Sec-Fetch-Site must be same-origin (Chrome, Firefox, Safari all send it,
//     and a page cannot forge it).
//   - Origin, when present, must match the Host header.
// A request with neither header is not a browser form post at all; requiring
// the JSON content type stops it from being a CORS "simple request".
function sameOriginPost(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  // Sec-Fetch-Site: same-origin is conclusive on its own — a page cannot forge
  // it. Checking Origin against Host as well would break any deployment whose
  // reverse proxy rewrites the Host header (nginx does by default), turning
  // notifications into a blanket 403 with nothing in the log to explain it.
  if (site !== 'same-origin') {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const host = new URL(origin).host;
        // x-forwarded-host is what a proxy that rewrites Host leaves behind.
        const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
        if (host !== req.headers.host && host !== forwarded) return false;
      } catch { return false; }
    }
  }
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}

// The one place every same-origin-only POST endpoint below turns a failed
// sameOriginPost() check into an actual 403. Pulled out once these guards
// started reading byte-for-byte identical at three call sites — which is
// exactly the condition under which a copy-pasted check quietly drifts out of
// sync at the fourth. Returns true if the request was refused (the caller's
// handler should return immediately in that case), false if it may proceed.
function refuseCrossSite(req, reply) {
  if (sameOriginPost(req)) return false;
  reply(403, { ok: false, error: 'cross-site request refused' });
  return true;
}

// Zero the share counters on request. Same guard as the notification
// endpoints, and for a sharper reason: this one DESTROYS data. Umbrel's proxy
// authenticates with a cookie the browser attaches to cross-site requests too,
// so without the same-origin check any page the user happens to have open
// could wipe their statistics with a single fetch.
async function handleResetPost(req, res) {
  const reply = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (refuseCrossSite(req, reply)) return;
  const body = await readJsonBody(req);
  if (!body) return reply(400, { ok: false, error: 'expected a small JSON object' });

  // What to clear. The default is what someone asking for a reset means:
  // shares and reject reasons, and the best share, which is the other figure a
  // day of experimenting distorts. The charts are only cleared when asked for
  // explicitly — they are the record of whether the miners were actually up,
  // and that is worth keeping across a counter reset.
  const all = body.scope === 'all';
  const scope = {
    counters: all || body.counters !== false,
    best: all || body.best !== false,
    history: all || body.history === true,
  };

  // Both halves, but only once the durable one has agreed to do anything.
  //
  // The store refuses an empty scope. Clearing the live counters first would
  // mean a request that answers 400 and changes nothing on disk had still
  // stamped `resetAt` in memory — so the dashboard would start labelling
  // untouched lifetime totals "since reset", disagreeing with /api/history,
  // until the next restart.
  const result = store.reset(scope);
  if (!result.ok) return reply(400, result);
  if (pool) pool.resetStats(scope);
  return reply(200, {
    ok: true,
    cleared: result.cleared,
    before: result.before,
    // Says out loud that a reset which could not reach the disk will not
    // survive a restart, rather than letting the user find out later.
    persisted: result.persisted,
    resetAt: store.state.resetAt,
  });
}

// Flip the mining profile from the dashboard. Same CSRF guard as the reset
// endpoint and for the same reason: this changes live behaviour (and, for
// "rented", is refused unless the payout is locked), so a page the user
// merely happens to have open must not be able to trigger it.
async function handleSettingsPost(req, res) {
  const reply = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (refuseCrossSite(req, reply)) return;
  const body = await readJsonBody(req);
  if (!body || typeof body.profile !== 'string') {
    return reply(400, { ok: false, error: 'expected { "profile": "home" | "rented" }' });
  }
  const result = applyMiningProfile(body.profile.trim().toLowerCase());
  return reply(result.ok ? 200 : result.code, result);
}

async function handlePushPost(req, res, pathname) {
  const reply = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  // Drain nothing and answer immediately if refused; there is no reason to
  // read a body we have already decided not to act on.
  if (refuseCrossSite(req, reply)) return;
  if (!push.enabled) return reply(503, { ok: false, error: 'notifications are unavailable' });

  const body = await readJsonBody(req);
  if (!body) return reply(400, { ok: false, error: 'expected a small JSON object' });

  if (pathname === '/api/push/test') {
    const result = await push.notifyAll('test');
    return reply(200, { ok: true, ...result });
  }
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : null;
  if (pathname === '/api/push/unsubscribe') {
    return reply(200, push.unsubscribe(endpoint));
  }
  const result = push.subscribe(endpoint);
  return reply(result.ok ? 200 : 400, { ...result, subscriptions: push.subscriptions.length });
}

function fmtHashrate(h) {
  if (!h) return { value: '0', unit: 'H/s' };
  const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  let i = 0;
  let v = h;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return { value: v >= 100 ? v.toFixed(0) : v.toFixed(2), unit: units[i] };
}

function snapshotOrNull() {
  try {
    return pool ? pool.snapshot() : null;
  } catch {
    return null;
  }
}

// ---- the other pool containers on this Umbrel (PEER_POOLS) ----
//
// The public LTC + DOGE ports run as their own containers beside this app
// (scripts/deploy-public-umbrel.sh), and umbrelOS only shows apps. So this app
// can read their status — the same /api/status this server answers — over
// umbrelOS's internal docker network and show it on its dashboard and widgets.
//
//   PEER_POOLS="3335=doge-public:3000,3339=doge-public-rental:3000"
//
// A label, then the host:port of another container's dashboard. Read-only, a
// GET to a fixed path on hosts the owner configured, never anything a browser
// supplies; at most eight, each answer capped in size and trimmed to the few
// figures the dashboard shows. A peer that is down is shown as down and costs
// this pool nothing.
const PEER_POLL_MS = 15000;
const PEER_TIMEOUT_MS = 3000;
const PEER_MAX_BYTES = 2 * 1024 * 1024;

function parsePeerPools(raw) {
  const out = [];
  for (const part of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([A-Za-z0-9 ._-]{1,32})=([a-z0-9][a-z0-9._-]{0,62}):(\d{1,5})$/.exec(part);
    if (!m || Number(m[3]) < 1 || Number(m[3]) > 65535) {
      console.log(`PEER_POOLS: ignoring "${part}" (expected label=host:port)`);
      continue;
    }
    out.push({ name: m[1], host: m[2], port: Number(m[3]) });
  }
  return out.slice(0, 8);
}

// The figures of a peer's status that the dashboard and widgets use. A 1.8.x
// peer has no `chains`; its Litecoin and Dogecoin difficulties are still in
// the status under their older names.
function trimPeerStatus(s) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  let chains = Array.isArray(s.chains) ? s.chains : [];
  if (!chains.length) {
    if (s.merged && s.merged.parentDifficulty) {
      chains.push({ name: 'LTC', label: 'Litecoin', height: s.merged.parentHeight, difficulty: s.merged.parentDifficulty });
    }
    if (s.networkDifficulty) chains.push({ name: 'DOGE', label: 'Dogecoin', height: s.height, difficulty: s.networkDifficulty });
  }
  chains = chains.slice(0, 8).map((c) => ({
    name: String(c.name || '').slice(0, 8),
    label: String(c.label || c.name || '').slice(0, 24),
    height: num(c.height),
    difficulty: num(c.difficulty),
    // A chain that is not in every job (PEP, SOQ) carries its own best share:
    // only shares made while it was being mined. Absent: the pool's best. The
    // same for the hashrate that can win it.
    ...(typeof c.best === 'number' && Number.isFinite(c.best) ? { best: c.best } : {}),
    ...(typeof c.hashrate === 'number' && Number.isFinite(c.hashrate) ? { hashrate: c.hashrate } : {}),
  }));
  return {
    totalHashrate: num(s.totalHashrate),
    workerCount: Array.isArray(s.workers) ? s.workers.length : 0,
    bestShareDiff: num(s.bestShareDiff),
    bestShareStratum: num(s.bestShareStratum),
    bestShareAt: num(s.bestShareAt) || null,
    blocksFound: num(s.blocksFound),
    chains,
  };
}

function fetchPeerStatus(peer) {
  return new Promise((settle) => {
    // One answer per request, and a deadline for the WHOLE exchange: the
    // socket timeout alone only fires after a silence, so a peer trickling a
    // byte every few seconds would otherwise hold the request open for ever.
    let settled = false;
    let deadline = null;
    const resolve = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      settle(v);
    };
    const req = http.get(
      {
        host: peer.host,
        port: peer.port,
        path: '/api/status',
        timeout: PEER_TIMEOUT_MS,
        headers: { Accept: 'application/json' },
        // A name another container on the shared network also answers to is
        // refused rather than read (see singleAddressLookup in rpc.js).
        lookup: singleAddressLookup,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve({ ok: false, error: `HTTP ${res.statusCode}` });
          return;
        }
        let size = 0;
        const chunks = [];
        // Destroying the request mid-body (too large, too slow) makes the
        // response emit 'error'. Unhandled, that would take down this whole
        // process — the pool included — for a fault in somebody else's.
        res.on('error', (err) => resolve({ ok: false, error: err.message || err.code || 'connection lost' }));
        res.on('data', (c) => {
          size += c.length;
          if (size > PEER_MAX_BYTES) {
            req.destroy();
            resolve({ ok: false, error: 'answer too large' });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            const s = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(s && s.ok ? { ok: true, status: trimPeerStatus(s) } : { ok: false, error: 'pool not running' });
          } catch {
            resolve({ ok: false, error: 'not a pool status' });
          }
        });
      }
    );
    deadline = setTimeout(() => req.destroy(new Error('timed out')), PEER_TIMEOUT_MS);
    req.on('timeout', () => req.destroy(new Error('timed out')));
    // A name that resolves to several addresses fails with an AggregateError
    // whose message is empty; its code (ECONNREFUSED, ENOTFOUND) is the reason.
    req.on('error', (err) => resolve({ ok: false, error: err.message || err.code || 'unreachable' }));
  });
}

const peerPools = parsePeerPools(process.env.PEER_POOLS);
let peerResults = peerPools.map((p) => ({ name: p.name, ok: false, error: 'not read yet', at: null, status: null }));

let peersPolling = false;
async function pollPeers() {
  // Never two rounds at once, so a slow round can neither pile up sockets nor
  // land after a newer one and overwrite it.
  if (peersPolling) return;
  peersPolling = true;
  try {
    peerResults = await Promise.all(
      peerPools.map(async (p) => ({ name: p.name, at: Date.now(), status: null, error: null, ...(await fetchPeerStatus(p)) }))
    );
  } finally {
    peersPolling = false;
  }
}

// This port plus every peer that answered: what the widgets show, so umbrelOS
// tells the same story for LTC + DOGE as it does for the BTC and BCH apps,
// whose public ports live inside the app itself.
function combinedFigures(snap) {
  const live = peerResults.filter((p) => p.ok && p.status).map((p) => p.status);
  const own = snap ? trimPeerStatus({ ...snap, ok: true }) : null;
  const all = own ? [own, ...live] : live;
  const chains = (own && own.chains.length ? own : all.find((s) => s.chains.length) || { chains: [] }).chains;
  // Per coin, the best share of the ports that mine that coin: a share on a
  // port without Soqucoin could never have been a Soqucoin block.
  const bestFor = (name) => Math.max(0, ...all.map((x) => {
    const c = x.chains.find((k) => k.name === name);
    return !c ? 0 : c.best !== undefined ? c.best : x.bestShareDiff;
  }));
  return {
    peers: live.length,
    bestFor,
    totalHashrate: all.reduce((s, x) => s + x.totalHashrate, 0),
    workerCount: all.reduce((s, x) => s + x.workerCount, 0),
    bestShareDiff: Math.max(0, ...all.map((x) => x.bestShareDiff)),
    bestShareStratum: Math.max(0, ...all.map((x) => x.bestShareStratum)),
    blocksFound: all.reduce((s, x) => s + x.blocksFound, 0),
    chains,
  };
}

// Reads a small JSON body. Bounded before anything is parsed: this is the only
// endpoint that accepts input from a browser, and an unbounded read is a way to
// exhaust the process's memory with a single request.
const MAX_BODY_BYTES = 4096;
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Destroy rather than merely stop reading, so the sender cannot hold
        // the connection open streaming into a socket we are ignoring.
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

const server = http.createServer((req, res) => {
  // llhttp accepts an absolute-form request target, so req.url can be a string
  // new URL() rejects — "GET http://[ HTTP/1.1" is enough. Unguarded, that is
  // an uncaught exception in the request handler, which this process answers by
  // exiting. Any device on the home network could therefore kill the app in the
  // middle of submitting a block.
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad request target');
    return;
  }

  // The dashboard sits behind Umbrel's authenticating proxy, but defence in
  // depth costs nothing here. POST is allowed only for the notification
  // endpoints, which need it to receive a subscription.
  const PUSH_POST_PATHS = new Set(['/api/push/subscribe', '/api/push/unsubscribe', '/api/push/test']);
  if (req.method === 'POST' && url.pathname === '/api/reset') {
    handleResetPost(req, res).catch((err) => {
      console.error('[reset]', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'internal error' }));
      } else {
        res.end();
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    handleSettingsPost(req, res).catch((err) => {
      console.error('[settings]', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'internal error' }));
      } else {
        res.end();
      }
    });
    return;
  }
  if (req.method === 'POST' && PUSH_POST_PATHS.has(url.pathname)) {
    // A rejection here would leave the request hanging open forever and, with
    // no handler, take the process down as an unhandled rejection.
    handlePushPost(req, res, url.pathname).catch((err) => {
      console.error('[push]', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'internal error' }));
      } else {
        res.end();
      }
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    // This used to answer "is my own web server up?", which it always was —
    // including for the thirteen hours when both node apps were switched off
    // and nothing whatsoever was being mined. It now answers the question the
    // name promises: is this pool getting work?
    //
    // evaluate() is pure, so asking it here cannot disturb the notification
    // bookkeeping the watchdog owns.
    const report = health.evaluate(Date.now(), healthInput());
    const healthy = pool !== null && !startupError && report.level !== 'down';
    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: healthy,
        error: startupError,
        level: report.level,
        alerts: report.alerts.map((a) => a.text),
      })
    );
    return;
  }

  // History is served separately from status: it is far larger and changes far
  // more slowly, so the dashboard polls it every 30 seconds instead of every 5.
  if (url.pathname === '/api/history') {
    const s = store.state;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        ok: true,
        persistent: store.writable,
        storeError: store.lastError,
        firstStartedAt: s.firstStartedAt,
        minuteSamples: s.minuteSamples,
        hourSamples: s.hourSamples.map(([ts, hr]) => [ts, hr]),
        shareLog: s.shareLog,
        // Without the per-worker sample series. Two workers with a day of
        // minutes each is ~60 kB, and this endpoint is polled every 30
        // seconds — on a phone over mobile data that is the whole budget for
        // a chart nobody has opened. The series is fetched per worker from
        // /api/worker when the detail panel is actually shown.
        workers: Object.fromEntries(
          Object.entries(s.workers).map(([name, w]) => {
            const { samples, ...rest } = w;
            const list = Array.isArray(samples) ? samples : [];
            // The one number the summary view needs from the series: this
            // worker's own 24-hour mean, which is what "it is running at half
            // its normal rate" is measured against. Computed here so the
            // series itself does not have to travel.
            // Windowed by timestamp and suppressed until there is enough of it.
            // The health badge compares live hashrate against this and says
            // "N% of its own 24h average"; the mean of three ramp-up samples
            // is not a 24-hour average and would make that warning fire on a
            // miner that just reconnected.
            const dayAgo = Math.round(Date.now() / 1000) - 86400;
            const recent = list.filter((p) => p[0] >= dayAgo);
            const avg24h = recent.length >= MIN_SAMPLES_FOR_AVERAGE
              ? Math.round(recent.reduce((sum, p) => sum + p[1], 0) / recent.length)
              : 0;
            return [name, { ...rest, sampleCount: list.length, avg24h }];
          })
        ),
        // "Lifetime" is a claim, and after a reset it is the wrong one — so the
        // timestamp travels with the figures it qualifies.
        resetAt: s.resetAt || null,
        lifetime: {
          accepted: s.accepted,
          rejected: s.rejected,
          rejectReasons: s.rejectReasons,
          blocksFound: store.blocksFound(),
          bestShareDiff: s.bestShareDiff,
          bestShareAt: s.bestShareAt,
        },
      })
    );
    return;
  }

  // The VAPID public key the browser needs to subscribe, plus whether anything
  // is subscribed at all so the UI can show the real state rather than a
  // checkbox that remembers nothing.
  if (url.pathname === '/api/push/key') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: push.enabled,
      key: push.publicKeyBase64(),
      subscriptions: push.subscriptions.length,
      error: push.enabled ? null : 'notifications are unavailable without a writable data directory',
    }));
    return;
  }

  // The notification icon. Small, cached, and the only binary this app serves.
  if (url.pathname === '/icon-192.png') {
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': ICON_PNG.length,
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(req.method === 'HEAD' ? undefined : ICON_PNG);
    return;
  }

  if (url.pathname === '/sw.js') {
    // Served from the root so its scope covers the whole dashboard.
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Service-Worker-Allowed': '/',
    });
    res.end(SERVICE_WORKER);
    return;
  }

  // One worker's own history, fetched when its detail panel is opened.
  if (url.pathname === '/api/worker') {
    const name = url.searchParams.get('name') || '';
    // hasOwnProperty, not a bare lookup: `?name=constructor` would otherwise
    // resolve through the prototype chain and return a truthy function, which
    // JSON.stringify drops — producing a 200 with no worker in it.
    const w = Object.prototype.hasOwnProperty.call(store.state.workers, name)
      ? store.state.workers[name] : null;
    if (!w || typeof w !== 'object') {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: 'unknown worker' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, name, worker: w }));
    return;
  }

  // The dashboard's mining-profile control reads this to know what is active,
  // whether it can be changed at all, and whether "rented" would currently be
  // refused — so it can explain that before the user hits the button, not
  // just after.
  if (url.pathname === '/api/settings') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        ok: true,
        profile: config.profile,
        available: Array.from(VALID_PROFILES),
        locked: profileLockedByEnv,
        lockedReason: profileLockedByEnv ? 'MINING_PROFILE is set in .env' : null,
        canRent: !!config.lockPayoutAddress,
        // The dedicated rented-capacity port's configuration, as distinct from
        // whether it actually bound — that lives on /api/status's snapshot,
        // which needs a running pool to answer at all. This endpoint has to
        // work even before the pool exists, so it can only say what was
        // configured, not what is currently listening.
        rentedStratumPort: config.rentedStratumPort || null,
      })
    );
    return;
  }

  if (url.pathname === '/api/status') {
    const snap = snapshotOrNull();
    // The alarms travel with the status, on BOTH branches. The dashboard and
    // the service worker have to be able to explain a pool that never started,
    // and that branch has no snapshot to hang anything off.
    const report = health.evaluate(Date.now(), healthInput());
    const alarm = {
      health: report.level,
      alerts: report.alerts.map((a) => ({ key: a.key, level: a.level, text: a.text, since: a.since })),
      // Both of these come from the CONFIGURATION rather than from a snapshot,
      // so they are the only things the dashboard can rely on when there is no
      // pool — which is exactly the branch where it has to tell the user which
      // node app to go and look at. Without it the alarm bar sends a merged
      // pool whose Litecoin node is down to the Dogecoin app.
      mergedMining: !!config.mergedMining,
      resetAt: store.state.resetAt || null,
    };
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify(snap ? { ok: true, ...snap, ...alarm } : { ok: false, error: startupError, ...alarm })
    );
    return;
  }

  // ---- Umbrel widgets ----
  // umbrelOS runs ms(widgetData.refresh) on every response, and ms() throws on
  // undefined. Every return path below must carry `refresh`, including the
  // degraded ones.
  // The other pool containers' figures, trimmed (see PEER_POOLS above). An
  // empty list when none are configured.
  if (url.pathname === '/api/peers') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ peers: peerResults }));
    return;
  }

  if (url.pathname === '/api/widget/hashrate') {
    const snap = snapshotOrNull();
    // This port plus the configured peers. Without PEER_POOLS it is exactly
    // this port's figures, as before.
    const all = combinedFigures(snap);
    const hr = fmtHashrate(all.totalHashrate);
    const doge = all.chains.find((c) => c.name === 'DOGE');

    // Progress on the same logarithmic scale the dashboard uses: how close the
    // best share came to a Dogecoin block, across six decades. A linear ratio
    // would sit at zero forever and say nothing. The label gives every coin
    // the same hash could have won: one share, several difficulties.
    let progress = 0;
    let progressLabel = 'no shares yet';
    const pct = (f) => {
      const p = f * 100;
      return p >= 100 ? 'BLOCK' : p >= 1 ? `${p.toFixed(1)}%` : `${p.toPrecision(2)}%`;
    };
    if (all.bestShareDiff > 0 && doge && doge.difficulty > 0) {
      const fraction = all.bestFor('DOGE') / doge.difficulty;
      progress = Math.max(0, Math.min(1, (Math.log10(fraction) + 6) / 6));
      progressLabel =
        all.chains.length > 1
          ? all.chains.filter((c) => c.difficulty > 0).map((c) => `${c.name} ${pct(all.bestFor(c.name) / c.difficulty)}`).join(' · ')
          : fraction >= 1
            ? 'a share met the full difficulty'
            : `best share ${pct(fraction)}`;
    } else if (!all.workerCount) {
      progressLabel = 'no miners connected';
    }

    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        type: 'text-with-progress',
        refresh: SYNC_REFRESH,
        link: '',
        title: all.peers ? 'Hashrate, all ports' : 'Solo hashrate',
        text: `${hr.value} ${hr.unit}`,
        progressLabel,
        progress,
      })
    );
    return;
  }

  if (url.pathname === '/api/widget/stats') {
    const snap = snapshotOrNull();
    const all = combinedFigures(snap);
    const hr = fmtHashrate(all.totalHashrate);
    // Stratum units here, matching what a miner reports. The consensus-space
    // figure is a fraction for any realistic share and renders as "0".
    const best = all.bestShareStratum || 0;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        type: 'four-stats',
        refresh: STATS_REFRESH,
        link: '',
        items: [
          { title: 'Hashrate', text: hr.value, subtext: hr.unit },
          { title: 'Workers', text: String(all.workerCount), subtext: all.peers ? 'all ports' : 'connected' },
          {
            title: 'Best share',
            text:
              best >= 1e12 ? `${(best / 1e12).toFixed(1)}T`
                : best >= 1e9 ? `${(best / 1e9).toFixed(1)}G`
                  : best >= 1e6 ? `${(best / 1e6).toFixed(1)}M`
                    : best >= 1e3 ? `${(best / 1e3).toFixed(1)}k` : best.toFixed(0),
            subtext: 'difficulty',
          },
          { title: 'Blocks', text: String(all.blocksFound), subtext: 'found' },
        ],
      })
    );
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const nonce = crypto.randomBytes(16).toString('base64');
    const body = INDEX_HTML.replaceAll('__NONCE__', nonce);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
        // worker-src is NOT covered by the nonce: a service worker is fetched
        // by URL, so without this the registration is refused by the policy and
        // notifications silently never work.
        `connect-src 'self'; img-src 'self' data:; worker-src 'self'; ` +
        `base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

async function main() {
  if (!config.payoutAddress) {
    startupError =
      'PAYOUT_ADDRESS is not set. Set it to the Dogecoin address that should receive block rewards.';
    console.error(`[config] ${startupError}`);
  }

  // The same refusal for the parent chain. Checked here rather than in the
  // retry loop below: a missing address is not something retrying fixes, and
  // mining Litecoin blocks that pay nobody is worse than not starting.
  if (config.mergedMining && !config.ltcPayoutAddress && !startupError) {
    startupError =
      'MERGED_MINING=1 but LTC_PAYOUT_ADDRESS is not set. Set it to the Litecoin address that ' +
      'should receive the parent block rewards.';
    console.error(`[config] ${startupError}`);
  }

  // Without this an EADDRINUSE is an uncaught exception rather than a message.
  server.on('error', (err) => {
    console.error(`[web] cannot serve on port ${PORT}: ${err.message}`);
    startupError = `the dashboard could not start: ${err.message}`;
  });
  server.listen(PORT, () => console.log(`[web] dashboard on :${PORT}`));

  if (peerPools.length) {
    console.log(`[web] reading the other pools: ${peerPools.map((p) => `${p.name} (${p.host}:${p.port})`).join(', ')}`);
    pollPeers().catch(() => {});
    setInterval(() => pollPeers().catch(() => {}), PEER_POLL_MS).unref();
  }

  // Armed BEFORE the start loop below, and not inside it. A missing payout
  // address returns early, and a node that never answers keeps the loop turning
  // forever — both are exactly when someone needs to be told.
  const healthTimer = setInterval(healthTick, HEALTH_TICK_MS);
  // Never the reason the process stays alive; the HTTP server owns that.
  healthTimer.unref();

  if (startupError) return;

  // The node may still be starting; keep retrying rather than crash-looping,
  // which would make the container's restart policy fight the node's startup.
  //
  // A FRESH Pool per attempt. Retrying start() on the same instance would leave
  // the previous attempt's poll timer and longpoll loop running, and after a
  // minute of retries there would be a dozen of each competing for the node's
  // RPC threads — starving the very call that submits a found block.
  for (let attempt = 1; ; attempt++) {
    const p = new Pool(config, store);
    p.on('error', (err) => console.error('[pool]', err.message));
    // Wake subscribed phones. Both events fire for the same block — found, then
    // accepted — and the service worker uses one notification tag, so the
    // second replaces the first instead of buzzing twice.
    //
    // The catch is not decoration: this runs on the block path, and an
    // unhandled rejection here would take down the process that is in the
    // middle of submitting the block.
    const announce = (reason) => (record) => {
      push.notifyAll(`${reason} ${record && record.height}`)
        .catch((err) => console.error('[push]', err.message));
    };
    p.on('blockfound', announce('block found'));
    p.on('block', announce('block accepted'));
    try {
      await p.start();
      pool = p;
      startupError = null;
      return;
    } catch (err) {
      p.stop();
      startupError = err.message;
      const wait = Math.min(30000, attempt * 3000);
      console.error(`[pool] start failed (${err.message}); retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// A solo pool holds no state on disk, so a restart costs one reconnect. Losing
// the process to an unhandled rejection while miners sit idle costs more, so
// these are logged loudly rather than fatal.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  // Something got past every guard. Save what we have — this is the one path
  // where losing the last half minute of history would hurt most — then log it
  // in full and let the container's restart policy give us a clean process.
  console.error('[fatal] uncaught exception:', err && err.stack ? err.stack : err);
  try { store.save(true); } catch { /* nothing left to try */ }
  process.exit(1);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    server.close();
    if (!pool) {
      store.save(true);
      process.exit(0);
      return;
    }
    // Close the stratum port FIRST and refuse new submissions, so the drain
    // below can actually reach zero instead of chasing a moving target.
    pool.beginShutdown();
    // Then wait for work already in progress. This includes block submissions,
    // whose retry schedule runs to about two minutes: exiting while one is
    // pending is the one bug here that costs real money.
    try {
      const clean = await pool.drain(130000);
      if (!clean) console.error('[shutdown] gave up waiting; some work was still in progress');
    } catch { /* fall through and save anyway */ }
    pool.stop();
    try { store.save(true); } catch { /* nothing left to try */ }
    process.exit(0);
  });
}

main();
