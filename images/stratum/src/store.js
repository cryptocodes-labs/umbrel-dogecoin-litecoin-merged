'use strict';
//
// Durable statistics.
//
// A solo miner runs for years and finds a block on a timescale of decades. If
// the numbers reset every time the container restarts — an update, a reboot, a
// power cut — the dashboard can only ever describe the last few hours, which is
// the least interesting window there is. This module keeps the history on disk.
//
// Design rules, in order of importance:
//   1. Losing the file must never stop the app from mining. Every failure here
//      is logged and swallowed.
//   2. Never destroy history we cannot read. A corrupt file, or one written by
//      a newer version, is preserved and the store goes read-only rather than
//      overwriting years of records.
//   3. A write must never publish a half-written file: temp, fsync, rename.
//   4. Nothing grows without bound — not the file, not memory, not the log.
//

const fs = require('node:fs');
const path = require('node:path');

const VERSION = 2;

// Older layouts this build can read and carry forward. A version that is merely
// OLD is not worthless: v1 files hold months of a solo miner's history, and
// "starting fresh" on an upgrade would throw exactly that away. Every field
// added since is optional and defaults in adopt(), so the upgrade is lossless.
const MIGRATABLE = new Set([1]);

// 48 hours of one-minute samples, then 180 days of hourly averages. Enough to
// see last night's dropout and last quarter's trend.
const MINUTE_SAMPLES = 48 * 60;
const HOUR_SAMPLES = 180 * 24;
const SHARE_LOG = 600;
const BLOCK_LOG = 50;
const WORKER_HISTORY = 50;
// Per-worker minute samples: 24 hours each. Enough to answer "which board died
// last night", without multiplying the file by the number of workers that ever
// connected — samples are dropped for workers that have been gone for a day.
const WORKER_MINUTE_SAMPLES = 24 * 60;
const WORKER_SAMPLE_TTL_MS = 24 * 3600 * 1000;
// How many workers keep a per-minute series. Beyond this the file grows into
// megabytes for history nobody looks at.
// The total number of per-worker samples kept across ALL workers, and the floor
// below which an individual series is never trimmed. 12000 samples is under
// half a megabyte; the floor is four hours, which is still enough to see a
// miner drop out this afternoon.
const TOTAL_WORKER_SAMPLES = 12000;
// A series shorter than this belongs to a worker that barely showed up. Once it
// has been gone for TRANSIENT_TTL_MS its samples are dropped, so it stops
// counting against the budget the established miners share.
const TRANSIENT_SAMPLES = 30;
const TRANSIENT_TTL_MS = 30 * 60 * 1000;
const SHORT_SERIES_SAMPLES = 240;
// Per-worker hourly means for a week: what the "7 days" figure is drawn from.
// Kept apart from the minute series, because that one is cut down when many
// workers share its budget; a week of hours is 168 entries a worker, small
// enough to keep for every worker the history holds.
const WORKER_HOUR_SAMPLES = 7 * 24;
const WORKER_HOURS_TTL_MS = 7 * 24 * 3600 * 1000;
// The least history an average is shown on: ten minutes for the hour, half an
// hour for the day and the week. Fewer than that is a ramp-up, not an average.
const MIN_MINUTES_HOUR = 10;
const MIN_MINUTES_LONG = 30;
// How far back to look for an existing hourly bucket. A clock that steps
// backwards must not open a duplicate bucket for an hour we already have.
const BUCKET_LOOKBACK = 4;
// A stored sample further ahead of the present than this is treated as the
// product of a wrong clock and dropped, rather than being allowed to reject
// every real sample that follows it.
const CLOCK_STEP_TOLERANCE_S = 3600;
// How long the incoming clock must disagree with the stored history before the
// stored timeline is believed to be the wrong one. A quarter of an hour of
// consistent disagreement — far longer than an NTP correction at boot takes,
// and far shorter than a user would stare at a frozen chart.
const RE_ANCHOR_AFTER_SECONDS = 15 * 60;

function emptyState() {
  return {
    version: VERSION,
    firstStartedAt: null,
    accepted: 0,
    rejected: 0,
    rejectReasons: {},
    blocks: [],
    bestShareDiff: 0,
    bestShareAt: null,
    minuteSamples: [], // [tsSeconds, hashrate]
    hourSamples: [], // [hourTsSeconds, meanHashrate, count]
    // [tsSeconds, shareDiff, stratumDifficulty, workerName]. The name is stored
    // in full rather than as an index into a side table: with a handful of
    // workers the few kilobytes cost nothing, and an index that drifts out of
    // step with its table silently mislabels every share in the chart.
    shareLog: [],
    // When the counters were last zeroed by hand, so the dashboard can say
    // "since 13 Aug 14:02" rather than implying these are lifetime figures.
    // Optional: a file written before this existed simply has null.
    resetAt: null,
    // When the incoming clock first disagreed with the stored history, so the
    // decision to re-anchor survives a restart.
    disagreeingSince: null,
    workersDisagreeingSince: null,
    // The first whole hour from which every worker's hourly means exist. The
    // week average divides by the pool's own running time from here on, not
    // from before the hourly series existed: an update that adds them must not
    // make every miner look seven times slower for a week.
    workerHoursSince: null,
    // A null-prototype map. Worker names arrive from the network, and on a
    // plain object a worker called "__proto__" resolves to Object.prototype:
    // the entry is never created, every write lands on the prototype, and from
    // then on every object in the process inherits a bogus `accepted`. With no
    // prototype there is nothing to reach.
    workers: Object.create(null),
  };
}

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Folds one minute into a worker's hourly means: [hourTs, mean, minutes].
function addHour(hours, ts, hashrate) {
  const hour = Math.floor(ts / 3600) * 3600;
  const last = hours[hours.length - 1];
  if (last && last[0] === hour) {
    last[2] += 1;
    last[1] = Math.round(last[1] + (hashrate - last[1]) / last[2]);
  } else if (!last || hour > last[0]) {
    hours.push([hour, Math.round(hashrate), 1]);
    while (hours.length > WORKER_HOUR_SAMPLES) hours.shift();
  }
}

// A worker's mean over the minutes after `from`. The divisor is the number of
// minutes the POOL sampled in that window: a minute the worker was absent
// counts as zero, a minute the app itself was down counts for nobody. Null when
// the window holds fewer than `min` minutes, or reaches back past the point
// where this worker's series was cut to share the budget.
function minuteAverage(pool, w, from, min) {
  if (w && w.trimmedAt && w.trimmedAt > from + 60) return null;
  let minutes = 0;
  for (let i = pool.length - 1; i >= 0 && pool[i][0] > from; i--) minutes++;
  let sum = 0;
  let own = 0;
  const list = w && Array.isArray(w.samples) ? w.samples : [];
  for (let i = list.length - 1; i >= 0 && list[i][0] > from; i--) {
    sum += list[i][1];
    own++;
  }
  minutes = Math.max(minutes, own);
  return minutes >= min ? sum / minutes : null;
}

// The same over whole hours from `from` (an hour boundary), from the hourly
// means: each hour weighs as many minutes as were sampled in it.
function hourAverage(pool, w, from, min) {
  if (!Number.isFinite(from)) return null;
  let minutes = 0;
  for (let i = pool.length - 1; i >= 0 && pool[i][0] >= from; i--) minutes += pool[i][2] || 1;
  let work = 0;
  let own = 0;
  const list = w && Array.isArray(w.hours) ? w.hours : [];
  for (let i = list.length - 1; i >= 0 && list[i][0] >= from; i--) {
    work += list[i][1] * list[i][2];
    own += list[i][2];
  }
  minutes = Math.max(minutes, own);
  return minutes >= min ? work / minutes : null;
}

class Store {
  constructor(filePath, log = () => {}) {
    this.path = filePath;
    this.rawLog = log;
    this.state = emptyState();
    this.dirty = false;
    this.writable = false;
    this.lastError = null;
    this.lastLoggedError = null;
    this.tmpPath = filePath ? `${filePath}.${process.pid}.tmp` : null;
  }

  log(msg) {
    this.rawLog(msg);
  }

  // Repeated identical failures are logged once. A volume that goes read-only
  // would otherwise write 2880 identical lines a day into a rotating log and
  // push out the block-recovery hex, which is the one line that matters.
  logError(msg) {
    if (msg === this.lastLoggedError) return;
    this.lastLoggedError = msg;
    this.rawLog(msg);
  }

  load() {
    if (!this.path) {
      this.log('no stats path configured; history will not survive a restart');
      this.state.firstStartedAt = Date.now();
      return this.state;
    }
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
    } catch {
      /* usually already exists; the probe below is what decides */
    }

    let parsed = null;
    let readError = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.path, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') readError = err;
    }

    if (readError) {
      // Unreadable, but not necessarily worthless. Keep it and start fresh.
      this.log(`stats file unreadable (${readError.message}); starting fresh`);
      this.preserve('corrupt');
    } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const version = Number(parsed.version);
      if (version === VERSION || MIGRATABLE.has(version)) {
        this.adopt(parsed);
        if (version !== VERSION) {
          this.log(`stats file upgraded from version ${version} to ${VERSION}; nothing was discarded`);
          this.dirty = true;
        }
      } else if (version > VERSION) {
        // A downgrade. Writing here would destroy a newer, richer file, so the
        // store stays read-only and says why. Mining is unaffected.
        this.log(
          `stats file was written by a newer version (${version}); running without ` +
            `persistence so it is not overwritten`
        );
        this.readOnlyReason = `file is version ${version}, this build understands ${VERSION}`;
      } else {
        // Note the explicit finite check: version 0 is a perfectly real value
        // and `|| 'unknown'` would rename the archive to the wrong name.
        const label = Number.isFinite(version) ? String(version) : 'unknown';
        this.log(`stats file has version ${label}; starting fresh`);
        this.preserve(`v${label}`);
      }
    }

    // Probe once, at startup, so a permissions problem is reported immediately
    // rather than discovered at the first save an hour later.
    if (this.readOnlyReason) {
      this.writable = false;
      this.lastError = this.readOnlyReason;
    } else {
      try {
        const probe = `${this.path}.probe`;
        fs.writeFileSync(probe, 'x');
        fs.unlinkSync(probe);
        this.writable = true;
      } catch (err) {
        this.writable = false;
        this.lastError = err.message;
        this.log(`WARNING: cannot write ${this.path} (${err.message}); statistics will reset on restart`);
      }
    }

    if (!this.state.firstStartedAt) this.state.firstStartedAt = Date.now();
    return this.state;
  }

  // Copy a file we are about to stop using, so nothing is ever lost silently.
  preserve(suffix) {
    try {
      // Never reuse a name. A fixed `stats.json.corrupt` means the SECOND
      // incident overwrites the archive of the first — and the first archive is
      // the one holding months of history, while the second holds an hour.
      let kept = `${this.path}.${suffix}`;
      for (let n = 2; fs.existsSync(kept) && n < 1000; n++) kept = `${this.path}.${suffix}.${n}`;
      fs.renameSync(this.path, kept);
      this.log(`the previous file was kept as ${kept}`);
    } catch {
      /* if we cannot even rename it, there is nothing further to try */
    }
  }

  // Type-coerce every field. A file that parses as JSON is not necessarily a
  // file with the right shapes in it, and `shareLog: {}` would otherwise throw
  // on the first share — which surfaces to miners as a 100% reject rate.
  adopt(parsed) {
    const s = emptyState();
    s.firstStartedAt = num(parsed.firstStartedAt, null) || null;
    s.accepted = Math.max(0, Math.floor(num(parsed.accepted)));
    s.rejected = Math.max(0, Math.floor(num(parsed.rejected)));
    s.bestShareDiff = Math.max(0, num(parsed.bestShareDiff));
    s.bestShareAt = num(parsed.bestShareAt, null) || null;
    s.resetAt = num(parsed.resetAt, null) || null;
    // Clamped like every other stored number. A negative value would make the
    // elapsed time enormous and re-anchor — deleting history — on the very
    // first out-of-order sample, skipping the waiting period entirely.
    const anchor = (v) => {
      const n = num(v, null);
      if (!Number.isFinite(n) || n <= 0) return null;
      const horizon = Math.round(Date.now() / 1000) + CLOCK_STEP_TOLERANCE_S;
      return n > horizon ? null : n;
    };
    s.disagreeingSince = anchor(parsed.disagreeingSince);
    s.workersDisagreeingSince = anchor(parsed.workersDisagreeingSince);
    s.workerHoursSince = anchor(parsed.workerHoursSince);

    for (const [k, v] of Object.entries(obj(parsed.rejectReasons))) {
      if (typeof k === 'string' && Number.isFinite(v)) s.rejectReasons[k.slice(0, 64)] = Math.floor(v);
    }
    s.blocks = arr(parsed.blocks).filter((b) => b && typeof b === 'object').slice(0, BLOCK_LOG);
    s.minuteSamples = arr(parsed.minuteSamples)
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .slice(-MINUTE_SAMPLES);
    s.hourSamples = arr(parsed.hourSamples)
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map((p) => [p[0], p[1], Number.isFinite(p[2]) ? p[2] : 1])
      .slice(-HOUR_SAMPLES);
    s.shareLog = arr(parsed.shareLog)
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      // A v1 entry has no fourth element; it becomes an unattributed share
      // rather than being dropped.
      .map((p) => [p[0], p[1], Number.isFinite(p[2]) ? p[2] : 0,
        typeof p[3] === 'string' ? p[3].slice(0, 64) : null])
      .slice(-SHARE_LOG);
    // Bounded like every other collection here: a file with ten thousand worker
    // entries would otherwise be loaded whole and only trimmed later.
    for (const [name, w] of Object.entries(obj(parsed.workers)).slice(0, WORKER_HISTORY)) {
      if (!w || typeof w !== 'object') continue;
      // Same reasoning as worker(): a file containing a worker literally called
      // "__proto__" would otherwise replace the map's prototype on assignment.
      // s.workers has none, so the assignment is an ordinary own property.
      const reasons = {};
      for (const [k, v] of Object.entries(obj(w.rejectReasons))) {
        if (typeof k === 'string' && Number.isFinite(v)) reasons[k.slice(0, 64)] = Math.floor(v);
      }
      s.workers[String(name).slice(0, 64)] = {
        accepted: Math.max(0, Math.floor(num(w.accepted))),
        rejected: Math.max(0, Math.floor(num(w.rejected))),
        bestShareDiff: Math.max(0, num(w.bestShareDiff)),
        bestShareAt: num(w.bestShareAt, null) || null,
        firstSeen: num(w.firstSeen, Date.now()),
        lastSeen: num(w.lastSeen, Date.now()),
        work: Math.max(0, num(w.work)),
        rejectReasons: reasons,
        samples: arr(w.samples)
          .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
          .slice(-WORKER_MINUTE_SAMPLES),
        // Absent in a file written before the week figure existed: an empty
        // series, filled from the next minute on.
        hours: arr(w.hours)
          .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
          .map((p) => [p[0], p[1], Number.isFinite(p[2]) && p[2] >= 1 ? Math.floor(p[2]) : 1])
          .slice(-WORKER_HOUR_SAMPLES),
        trimmedAt: anchor(w.trimmedAt),
      };
    }
    this.state = s;
    this.log(
      `restored history: ${s.accepted} shares, ${this.blocksFound()} block(s), ` +
        `best share ${Number(s.bestShareDiff || 0).toPrecision(4)}`
    );
  }

  // Derived, never stored as an independent counter. A process that dies
  // between recording a block and confirming it would otherwise leave the two
  // permanently out of step.
  blocksFound() {
    return this.state.blocks.filter((b) => b && b.accepted === true).length;
  }

  markDirty() {
    this.dirty = true;
  }

  // Zero the counters, on request, from the dashboard.
  //
  // Why this exists: a reject rate is only useful as a rate SINCE something.
  // A day of experimenting with miner settings leaves tens of thousands of
  // rejects on the record, and after that a fresh problem — a board going bad,
  // a stratum change that starts producing stale work — moves the headline
  // figure by a fraction of a percent and is invisible. The number stops
  // answering the only question anyone asks it: is it happening NOW.
  //
  // What is deliberately NOT resettable here:
  //
  //   * The block records. They are the record of money, they are what
  //     reconciliation compares against the node at every startup, and
  //     blocksFound() is derived from them rather than stored — so "resetting"
  //     them would not zero a counter, it would delete the evidence that a
  //     block was ever mined. Nothing in this app deletes those.
  //   * firstStartedAt. "Mining for 8 months" is a fact about the machine, not
  //     a statistic about shares.
  //   * Each worker's `work`, the lifetime sum of credited difficulty. It is
  //     not a share counter: it is the denominator of the "work done" figure
  //     and of the luck percentage, and it is the natural partner of the block
  //     count that is deliberately kept. Zeroing it while keeping blocksFound
  //     leaves `1 block found, 8.0e+10% luck` on the dashboard — a number that
  //     is not merely reset but wrong, and unrecoverable without mining for as
  //     long again.
  //
  // `scope` picks what goes: {counters, best, history}. The timestamp is
  // recorded so every figure derived from these can be labelled honestly
  // afterwards.
  reset(scope = {}) {
    const s = this.state;
    const before = {
      accepted: s.accepted,
      rejected: s.rejected,
      bestShareDiff: s.bestShareDiff,
    };
    const cleared = [];

    if (scope.counters) {
      s.accepted = 0;
      s.rejected = 0;
      s.rejectReasons = {};
      for (const w of Object.values(s.workers)) {
        w.accepted = 0;
        w.rejected = 0;
        w.rejectReasons = {};
      }
      cleared.push('counters');
    }
    if (scope.best) {
      s.bestShareDiff = 0;
      s.bestShareAt = null;
      for (const w of Object.values(s.workers)) {
        w.bestShareDiff = 0;
        w.bestShareAt = null;
      }
      cleared.push('best share');
    }
    if (scope.history) {
      s.minuteSamples = [];
      s.hourSamples = [];
      s.shareLog = [];
      for (const w of Object.values(s.workers)) {
        w.samples = [];
        w.hours = [];
        w.trimmedAt = null;
      }
      // The averages divide by the pool's running time, which was just cleared
      // with the charts; they start again from the next whole hour.
      s.workerHoursSince = null;
      this.averageCache = null;
      cleared.push('charts');
    }

    if (!cleared.length) return { ok: false, error: 'nothing selected', before };
    s.resetAt = Date.now();
    this.dirty = true;
    // Written through immediately. The only other save is a five-minute timer,
    // and a reset that a reboot silently undoes is worse than no reset at all:
    // the user would go on reading a number they believe starts from zero.
    const saved = this.save(true);
    this.log(
      `statistics reset (${cleared.join(', ')}): ${before.accepted} accepted and ` +
        `${before.rejected} rejected shares cleared; block records kept`
    );
    return { ok: true, cleared, before, persisted: saved };
  }

  save(force = false) {
    if (!this.path || !this.writable) return false;
    if (!this.dirty && !force) return false;
    try {
      const json = JSON.stringify(this.state);
      const fd = fs.openSync(this.tmpPath, 'w');
      try {
        fs.writeFileSync(fd, json);
        // Without the fsync a power cut can leave an empty file behind even
        // though the rename succeeded.
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(this.tmpPath, this.path);
      // Fsync the directory so the rename itself is durable, not just the
      // bytes it points at.
      try {
        const dirFd = fs.openSync(path.dirname(this.path), 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch { /* not supported everywhere; the data is already safe */ }
      this.dirty = false;
      this.lastError = null;
      this.lastLoggedError = null;
      return true;
    } catch (err) {
      this.lastError = err.message;
      this.logError(`could not save statistics: ${err.message}`);
      try { fs.unlinkSync(this.tmpPath); } catch { /* ignore */ }
      return false;
    }
  }

  // ---------------------------------------------------------------- recording

  recordShare(at, shareDiff, stratumDifficulty, workerName) {
    const s = this.state;
    s.accepted++;
    if (shareDiff > s.bestShareDiff) {
      s.bestShareDiff = shareDiff;
      s.bestShareAt = at;
    }
    s.shareLog.push([Math.round(at / 1000), shareDiff, stratumDifficulty,
      workerName ? String(workerName).slice(0, 64) : null]);
    while (s.shareLog.length > SHARE_LOG) s.shareLog.shift();

    const w = this.worker(workerName, at);
    w.accepted++;
    w.lastSeen = at;
    w.work += stratumDifficulty;
    if (shareDiff > w.bestShareDiff) {
      w.bestShareDiff = shareDiff;
      w.bestShareAt = at;
    }

    this.trimWorkers();
    this.dirty = true;
  }

  recordReject(reason, workerName) {
    const s = this.state;
    s.rejected++;
    s.rejectReasons[reason] = (s.rejectReasons[reason] || 0) + 1;
    // Create the entry if it does not exist. A worker that produces nothing but
    // rejects — wrong algorithm, broken firmware — is exactly the one you need
    // to see in the table, and it would never appear if only shares created it.
    if (workerName) {
      const w = this.worker(workerName, Date.now());
      w.rejected++;
      w.rejectReasons[reason] = (w.rejectReasons[reason] || 0) + 1;
      w.lastSeen = Date.now();
      this.trimWorkers();
    }
    this.dirty = true;
  }

  worker(name, at) {
    const key = String(name || 'worker').slice(0, 64);
    // hasOwnProperty rather than a truthiness test: on any inherited key the
    // lookup would succeed against the prototype and the entry would never be
    // created. The map is null-prototype, but this must stay correct even if
    // that ever changes.
    if (!Object.prototype.hasOwnProperty.call(this.state.workers, key)) {
      this.state.workers[key] = {
        accepted: 0, rejected: 0, bestShareDiff: 0, bestShareAt: null,
        firstSeen: at, lastSeen: at, work: 0, rejectReasons: {}, samples: [],
        hours: [], trimmedAt: null,
      };
    }
    // A worker restored from a v1 file has neither of the new fields; fill them
    // in on first touch rather than checking for them at every use site.
    const w = this.state.workers[key];
    if (!w.rejectReasons) w.rejectReasons = {};
    if (!Array.isArray(w.samples)) w.samples = [];
    if (!Array.isArray(w.hours)) w.hours = [];
    return w;
  }

  // The caller keeps its own record with the block hex on it; the store must
  // NOT hold that. Fifty mainnet blocks of hex is tens of megabytes, and the
  // file is serialised synchronously on the event loop every time it is saved.
  recordBlock(record) {
    const s = this.state;
    const { blockHex, ...withoutHex } = record;
    s.blocks.unshift(withoutHex);
    while (s.blocks.length > BLOCK_LOG) s.blocks.pop();
    this.dirty = true;
    return withoutHex;
  }

  // Reflect a later status change (accepted / stale / rejected) onto the stored
  // copy, matched by hash so it works after a restart too.
  updateBlock(hash, fields) {
    const found = this.state.blocks.find((b) => b && b.hash === hash);
    if (!found) return false;
    Object.assign(found, fields);
    this.dirty = true;
    return true;
  }

  // Per-worker hashrate, sampled alongside the combined figure. `perWorker` is
  // a Map or plain object of name -> hashrate; workers that are connected but
  // idle must appear with 0 rather than be omitted, otherwise a stalled miner
  // leaves a gap in its chart that reads as "no data" instead of "stopped".
  recordWorkerSamples(at, perWorker) {
    if (!perWorker) return;
    const s = this.state;
    const ts = Math.round(at / 1000);
    // From the next whole hour: the hour this starts in is only partly covered.
    if (!s.workerHoursSince) s.workerHoursSince = Math.ceil(ts / 3600) * 3600;
    const entries = perWorker instanceof Map ? perWorker.entries() : Object.entries(perWorker);
    let behind = 0;
    for (const [name, hashrate] of entries) {
      if (!Number.isFinite(hashrate)) continue;
      const w = this.worker(name, at);
      // A connected worker has been seen, even at zero hashrate. Without this
      // its lastSeen only advances on shares, so a miner that is connected but
      // producing nothing — the exact case a zero sample exists to record —
      // ages out after 24 hours and has its series wiped on the same tick that
      // wrote to it. It would also be first in line for eviction.
      w.lastSeen = at;
      const last = w.samples[w.samples.length - 1];
      if (last && ts < last[0]) { behind++; continue; }
      w.samples.push([ts, Math.round(hashrate)]);
      while (w.samples.length > WORKER_MINUTE_SAMPLES) w.samples.shift();
      addHour(w.hours, ts, hashrate);
    }

    // The same re-anchoring the combined series does, and for the same reason:
    // a series left frozen at a future timestamp can never accept another
    // sample, and pruneWorkerSamples' TTL cannot clear it either because the
    // worker is still connected. Counted separately because a worker can be
    // future-dated on its own — the process can die between writing the two.
    if (behind > 0) {
      if (!s.workersDisagreeingSince || s.workersDisagreeingSince > ts) {
        s.workersDisagreeingSince = ts;
        this.dirty = true;
        this.save(true);
      }
      if (ts - s.workersDisagreeingSince >= RE_ANCHOR_AFTER_SECONDS) {
        const horizon = ts + CLOCK_STEP_TOLERANCE_S;
        for (const w of Object.values(this.state.workers)) {
          if (Array.isArray(w.samples)) w.samples = w.samples.filter((p) => p[0] <= horizon);
          if (Array.isArray(w.hours)) w.hours = w.hours.filter((p) => p[0] <= horizon);
        }
        if (s.workerHoursSince > horizon) s.workerHoursSince = Math.ceil(ts / 3600) * 3600;
        this.log('re-anchored the per-worker history to the current time');
        s.workersDisagreeingSince = null;
      }
    } else {
      s.workersDisagreeingSince = null;
    }
    this.pruneWorkerSamples(at);
    // Entries can be created here as well as by recordShare, so the cap has to
    // be applied here too — MAX_CONNECTIONS is larger than WORKER_HISTORY.
    this.trimWorkers();
    this.dirty = true;
  }

  // Drop the sample series of workers that have been gone for a day. Their
  // totals stay — that is the lifetime record — but a machine sold last month
  // should not carry 1440 samples in every save for the rest of time.
  pruneWorkerSamples(now) {
    const named = Object.entries(this.state.workers);
    for (const [, w] of named) {
      if (w.samples && w.samples.length && now - (w.lastSeen || 0) > WORKER_SAMPLE_TTL_MS) {
        w.samples = [];
      }
      // The hourly means live a week, like the figure they are for.
      if (w.hours && w.hours.length && now - (w.lastSeen || 0) > WORKER_HOURS_TTL_MS) {
        w.hours = [];
      }
    }
    // Only the most recently seen workers carry a series at all. Fifty workers
    // times a day of minutes is a 1.6 MB file, and that file is stringified
    // synchronously on the event loop — including on the block path. A handful
    // of live miners is the real case; the rest keep their totals, which is
    // what the lifetime record is for.
    // A budget shared between the workers that have a series, rather than a
    // cliff at a fixed number of them.
    //
    // Two earlier attempts were worse. Wiping the tail of a recency sort starved
    // one arbitrary worker forever, because every connected worker is stamped
    // with the SAME lastSeen on each pass and the sort is therefore all ties.
    // Cutting everyone to a fixed short length the moment a ninth worker
    // appeared meant a laptop connecting for a minute permanently discarded
    // most of eight real miners' history. Dividing the budget degrades
    // gradually: two miners keep a full day each, nine keep about twenty
    // hours, fifty keep four.
    // Drop the series of workers that appeared briefly and went away. Without
    // this, a client that reconnects under a new name each time — or one
    // afternoon of testing — leaves dozens of one-sample series behind, and
    // the budget below is divided by all of them for a full day, cutting the
    // real miners' history to the floor.
    for (const [, w] of named) {
      const brief = w.samples && w.samples.length > 0 && w.samples.length < TRANSIENT_SAMPLES;
      if (brief && now - (w.lastSeen || 0) > TRANSIENT_TTL_MS) w.samples = [];
    }

    const withSamples = named.filter(([, w]) => w.samples && w.samples.length);
    if (withSamples.length > 1) {
      const each = Math.max(SHORT_SERIES_SAMPLES,
        Math.floor(TOTAL_WORKER_SAMPLES / withSamples.length));
      for (const [, w] of withSamples) {
        if (w.samples.length <= each) continue;
        while (w.samples.length > each) w.samples.shift();
        // Where this series now starts. An average over a window reaching
        // further back than this would count the cut minutes as idle ones.
        w.trimmedAt = w.samples[0][0];
      }
    }
  }

  recordSample(at, hashrate) {
    const s = this.state;
    const ts = Math.round(at / 1000);

    // Clock steps. A machine without a real-time clock reads a wrong date at
    // boot and NTP corrects it minutes later, in either direction.
    //
    // Simply refusing every sample older than the newest stored one is not
    // enough: one reading a year in the future would then reject everything
    // real for a year, freezing the chart permanently with no recovery short of
    // deleting the history. So a stored sample that is implausibly far AHEAD of
    // now is treated as the bogus one and discarded instead.
    // Clock steps, and why this is not simply "trust the newer timestamp".
    //
    // Two situations produce a sample dated before the newest stored one, and
    // they need opposite responses:
    //
    //   a) The clock is wrong NOW. A box with no real-time clock boots with
    //      yesterday's date and NTP corrects it a minute later. The stored
    //      history is right; the incoming sample is wrong. Deleting history
    //      here would destroy months of records over one bad reading — which
    //      is the more common case, and the more expensive mistake.
    //
    //   b) The clock was wrong WHEN A SAMPLE WAS WRITTEN, and is right now.
    //      One reading a year in the future would otherwise reject every real
    //      sample for a year, freezing the chart with no way back.
    //
    // They are indistinguishable from a single sample, so the tie is broken by
    // persistence: (a) resolves itself within a couple of minutes, so history
    // is only re-anchored after the same disagreement has repeated for
    // RE_ANCHOR_AFTER_SECONDS of consistent disagreement. Nothing is deleted
    // before then, and the clock at which it started is stored, so restarting
    // does not reset the wait.
    let lastMinute = s.minuteSamples[s.minuteSamples.length - 1];
    if (lastMinute && ts < lastMinute[0]) {
      // Recorded in the state, not in a counter on this object: a box that
      // reboots every few minutes — `restart: on-failure` against a node that
      // is not up yet, or someone power-cycling — would reset an in-memory
      // count forever and never re-anchor, while the future-dated sample that
      // needs clearing is on disk and survives every one of those restarts.
      // Also revised DOWNWARD. Stamping it once and never lowering it means a
      // second, smaller clock correction leaves the anchor in the frame of the
      // first: the elapsed time goes negative and the chart can never
      // re-anchor again — permanently, because this value is persisted.
      if (!s.disagreeingSince || s.disagreeingSince > ts) {
        s.disagreeingSince = ts;
        // Persisted immediately. The only other save is a five-minute timer,
        // and a box that keeps power-cycling — the exact case this survives a
        // restart for — would otherwise lose the anchor every time.
        this.dirty = true;
        this.save(true);
      }
      const disagreedFor = ts - s.disagreeingSince;
      if (disagreedFor < RE_ANCHOR_AFTER_SECONDS) {
        // A constant message, so logError's de-duplication actually works: an
        // interpolated delta changes every minute and would print 1440 lines a
        // day, which is the flooding that de-duplication exists to prevent.
        this.logError('ignoring a sample dated before the previous one (clock step?)');
        return;
      }
      // The disagreement has held for long enough to believe the present.
      const horizon = ts + CLOCK_STEP_TOLERANCE_S;
      const dropped = s.minuteSamples.filter((p) => p[0] > horizon).length;
      s.minuteSamples = s.minuteSamples.filter((p) => p[0] <= horizon);
      s.hourSamples = s.hourSamples.filter((p) => p[0] <= horizon);
      // Per-worker series share the timeline and would otherwise stay frozen
      // at a future timestamp forever, with no TTL able to clear them.
      for (const w of Object.values(s.workers)) {
        if (Array.isArray(w.samples)) w.samples = w.samples.filter((p) => p[0] <= horizon);
        if (Array.isArray(w.hours)) w.hours = w.hours.filter((p) => p[0] <= horizon);
      }
      if (s.workerHoursSince > horizon) s.workerHoursSince = Math.ceil(ts / 3600) * 3600;
      this.log(
        `the clock has been behind the stored history for ${Math.round(disagreedFor / 60)} minutes; ` +
          `re-anchoring to the current time and discarding ${dropped} future-dated sample(s)`
      );
      s.disagreeingSince = null;
      lastMinute = s.minuteSamples[s.minuteSamples.length - 1];
      if (lastMinute && ts < lastMinute[0]) return;
    } else {
      s.disagreeingSince = null;
    }

    s.minuteSamples.push([ts, Math.round(hashrate)]);
    while (s.minuteSamples.length > MINUTE_SAMPLES) s.minuteSamples.shift();

    const hour = Math.floor(ts / 3600) * 3600;
    // Look back a few buckets rather than only at the last one, so a sample
    // that lands slightly out of order still updates the right hour.
    let bucket = null;
    for (let i = s.hourSamples.length - 1; i >= 0 && i >= s.hourSamples.length - BUCKET_LOOKBACK; i--) {
      if (s.hourSamples[i][0] === hour) { bucket = s.hourSamples[i]; break; }
    }
    if (bucket) {
      bucket[2] = (bucket[2] || 1) + 1;
      bucket[1] = Math.round(bucket[1] + (hashrate - bucket[1]) / bucket[2]);
    } else {
      s.hourSamples.push([hour, Math.round(hashrate), 1]);
      s.hourSamples.sort((a, b) => a[0] - b[0]);
      while (s.hourSamples.length > HOUR_SAMPLES) s.hourSamples.shift();
    }
    this.dirty = true;
  }

  // A worker's stored record, or null. Never creates one: the status asks for
  // every connected worker every few seconds, and a lookup must not write.
  workerRecord(name) {
    const key = String(name || 'worker').slice(0, 64);
    return Object.prototype.hasOwnProperty.call(this.state.workers, key) ? this.state.workers[key] : null;
  }

  // One worker's average hashrate over the last hour, day and week, as the BTC
  // and BCH pools show it: the work done in the window over the time in it
  // (see minuteAverage). The hour and the day come from the minute series; the
  // week from the hourly means, counted from workerHoursSince. Cached until the
  // next minute is sampled: nothing it reads changes in between, and the status
  // is asked for every few seconds by the dashboard and the other pools.
  workerAverages(name, now = Date.now()) {
    const s = this.state;
    const lastMinute = s.minuteSamples.length ? s.minuteSamples[s.minuteSamples.length - 1][0] : 0;
    if (!this.averageCache || this.averageCache.minute !== lastMinute) {
      this.averageCache = { minute: lastMinute, byName: new Map() };
    }
    const key = String(name || 'worker').slice(0, 64);
    const cached = this.averageCache.byName.get(key);
    if (cached) return cached;
    const w = this.workerRecord(key);
    const ts = Math.round(now / 1000);
    const weekFrom = Math.max(Math.floor((ts - 7 * 86400) / 3600) * 3600, s.workerHoursSince || Infinity);
    const out = {
      h1: minuteAverage(s.minuteSamples, w, ts - 3600, MIN_MINUTES_HOUR),
      h24: minuteAverage(s.minuteSamples, w, ts - 86400, MIN_MINUTES_LONG),
      d7: hourAverage(s.hourSamples, w, weekFrom, MIN_MINUTES_LONG),
    };
    this.averageCache.byName.set(key, out);
    return out;
  }

  // Workers seen in the last week that are not connected now, most recent
  // first. The miner that dropped out last night is the one worth seeing; a
  // table of only the connected ones cannot show it.
  offlineWorkers(connected, now = Date.now(), max = 20) {
    const out = [];
    for (const [name, w] of Object.entries(this.state.workers)) {
      if (!w || connected.has(name) || now - (w.lastSeen || 0) > WORKER_HOURS_TTL_MS) continue;
      out.push({
        worker: name,
        firstSeen: w.firstSeen || null,
        lastSeen: w.lastSeen || null,
        accepted: w.accepted || 0,
        rejected: w.rejected || 0,
        bestShareDiff: w.bestShareDiff || 0,
        bestShareAt: w.bestShareAt || null,
        avg: this.workerAverages(name, now),
      });
    }
    return out.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, max);
  }

  // Keep only the most recently seen workers, so a rotating cast of worker
  // names cannot grow the file forever.
  trimWorkers() {
    const names = Object.keys(this.state.workers);
    if (names.length <= WORKER_HISTORY) return;
    names
      .sort((a, b) => this.state.workers[b].lastSeen - this.state.workers[a].lastSeen)
      .slice(WORKER_HISTORY)
      .forEach((n) => delete this.state.workers[n]);
  }
}

module.exports = {
  Store, VERSION, MIGRATABLE, MINUTE_SAMPLES, HOUR_SAMPLES, SHARE_LOG, BLOCK_LOG,
  WORKER_MINUTE_SAMPLES, WORKER_HOUR_SAMPLES, CLOCK_STEP_TOLERANCE_S,
  TOTAL_WORKER_SAMPLES, SHORT_SERIES_SAMPLES, RE_ANCHOR_AFTER_SECONDS,
};
