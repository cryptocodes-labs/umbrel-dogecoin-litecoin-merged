'use strict';
//
// Every miner's averages over an hour, a day and a week, and the miners that
// dropped out — what the dashboard's table of every miner on the Umbrel shows,
// as the BTC and BCH pools do. No daemon needed, so this runs in CI.
//
// The rules under test, from store.js:
//   * an average is the work done in the window over the time the POOL ran in
//     it: a minute the miner was absent counts as zero, a minute the app was
//     down counts for nobody;
//   * too little history is a dash (null), not a ramp-up figure;
//   * a minute series cut short to share the budget gives no day figure that
//     reaches past the cut;
//   * the week starts at the first whole hour the hourly means were kept, so
//     an update does not make every miner look slower for a week;
//   * the hourly means survive a restart, and a hostile file cannot put
//     anything else in their place;
//   * a reset of the charts starts them again;
//   * a miner seen in the last week and not connected is listed as gone.
//
// Usage: node test/miner_averages.js
//
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const u = require('../images/stratum/src/util');
const { Store, WORKER_HOUR_SAMPLES } = require('../images/stratum/src/store');
const { Pool, workerName } = require('../images/stratum/src/pool');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const near = (a, b) => a != null && Math.abs(a - b) <= Math.max(1, Math.abs(b) * 1e-6);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-averages-'));
const HOUR = 3600 * 1000;
// Half past an hour, so the first hour is a partial one.
const T0 = Math.floor(Date.UTC(2026, 9, 31, 12, 0, 0) / HOUR) * HOUR + 30 * 60000;

// One pool minute: the total, and each connected worker's own figure.
function minute(store, at, perWorker) {
  const total = Object.values(perWorker).reduce((s, v) => s + v, 0);
  store.recordSample(at, total);
  store.recordWorkerSamples(at, new Map(Object.entries(perWorker)));
}

console.log('\nan average is the work in the window over the time the pool ran');
{
  const s = new Store(null);
  s.load();
  // 120 minutes. "a" mines at 100 throughout; "b" at 60 only for the last 30.
  for (let i = 0; i < 120; i++) {
    const at = T0 + i * 60000;
    minute(s, at, i >= 90 ? { a: 100, b: 60 } : { a: 100 });
  }
  const now = T0 + 119 * 60000 + 1000;
  const a = s.workerAverages('a', now);
  const b = s.workerAverages('b', now);
  check('a steady miner averages its rate over the hour', near(a.h1, 100), JSON.stringify(a));
  check('and over the day, on the 120 minutes there are', near(a.h24, 100), JSON.stringify(a));
  check('a miner here for half the hour averages half its rate', near(b.h1, 30), JSON.stringify(b));
  check('and a quarter of it over the two hours of the day so far', near(b.h24, 15), JSON.stringify(b));

  // Another hour in which the APP was not running: no minutes at all, then
  // twenty minutes of both miners.
  for (let i = 0; i < 20; i++) minute(s, T0 + (180 + i) * 60000, { a: 100, b: 60 });
  const later = s.workerAverages('b', T0 + 199 * 60000 + 1000);
  check('time the app was down counts for nobody: b over the last hour is its full rate',
    near(later.h1, 60), JSON.stringify(later));
  check('a name never seen has nothing to average', s.workerAverages('nobody', now).h1 === 0 ||
    s.workerAverages('nobody', now).h1 === null);
}

console.log('\ntoo little history is a dash');
{
  const s = new Store(null);
  s.load();
  for (let i = 0; i < 9; i++) minute(s, T0 + i * 60000, { a: 100 });
  const v = s.workerAverages('a', T0 + 8 * 60000 + 1000);
  check('nine minutes: no hour figure', v.h1 === null, JSON.stringify(v));
  check('no day figure', v.h24 === null, JSON.stringify(v));
  check('no week figure', v.d7 === null, JSON.stringify(v));
  minute(s, T0 + 9 * 60000, { a: 100 });
  check('ten minutes: an hour figure', near(s.workerAverages('a', T0 + 9 * 60000 + 1000).h1, 100));
}

console.log('\na series cut to share the budget gives no day figure past the cut');
{
  const s = new Store(null);
  s.load();
  for (let i = 0; i < 300; i++) minute(s, T0 + i * 60000, { a: 100 });
  const w = s.workerRecord('a');
  const now = T0 + 299 * 60000 + 1000;
  // As pruneWorkerSamples leaves it: the first 200 minutes gone.
  w.samples = w.samples.slice(200);
  w.trimmedAt = w.samples[0][0];
  s.averageCache = null;
  const v = s.workerAverages('a', now);
  check('the day reaches past the cut: taken from the hourly means, not a third of the rate', near(v.h24, 100), JSON.stringify(v));
  check('the hour is inside what is left: still there', near(v.h1, 100), JSON.stringify(v));

  // And pruneWorkerSamples itself marks the cut: ten workers with a full day
  // each are over the shared budget.
  const t = new Store(null);
  t.load();
  for (let i = 0; i < 1440; i++) {
    const per = {};
    for (let k = 0; k < 10; k++) per[`w${k}`] = 10;
    minute(t, T0 + i * 60000, per);
  }
  const cut = t.workerRecord('w0');
  check('a series over the budget is cut and the cut is recorded',
    cut.samples.length < 1440 && cut.trimmedAt === cut.samples[0][0], `${cut.samples.length} ${cut.trimmedAt}`);
  check('its day figure comes from the hourly means rather than being understated',
    near(t.workerAverages('w0', T0 + 1439 * 60000 + 1000).h24, 10), JSON.stringify(t.workerAverages('w0', T0 + 1439 * 60000 + 1000)));

}

console.log('\nthe week starts at the first whole hour it was kept');
{
  const s = new Store(null);
  s.load();
  // A history from before the hourly means existed: the pool's own hours go
  // back a week, the worker's do not.
  for (let h = 7 * 24; h > 0; h--) s.state.hourSamples.push([Math.floor((T0 - h * HOUR) / 1000 / 3600) * 3600, 100, 60]);
  for (let i = 0; i < 150; i++) minute(s, T0 + i * 60000, { a: 100 });
  const since = s.state.workerHoursSince;
  check('workerHoursSince is the next whole hour after the first minute',
    since === Math.ceil(T0 / 1000 / 3600) * 3600, String(since));
  const v = s.workerAverages('a', T0 + 149 * 60000 + 1000);
  check('the week is the rate, not a fraction diluted by the pool\'s older hours', near(v.d7, 100), JSON.stringify(v));
  // Eight days of a steady miner: the week is exactly its rate, the hour a
  // week ago and the current one included.
  const long = new Store(null);
  long.load();
  for (let i = 0; i < 8 * 1440; i++) minute(long, T0 + i * 60000, { a: 100 });
  const week = long.workerAverages('a', T0 + (8 * 1440 - 1) * 60000 + 1000);
  check('after eight days the week of a steady miner is its rate, not an hour short', near(week.d7, 100), JSON.stringify(week));
  check('hourly means are [hour, mean, minutes]',
    s.workerRecord('a').hours.every((p) => p[0] % 3600 === 0 && p[1] === 100 && p[2] >= 1 && p[2] <= 60));
}

console.log('\nthe hourly means survive a restart; a hostile file does not');
{
  const file = path.join(dir, 'stats.json');
  const s = new Store(file);
  s.load();
  for (let i = 0; i < 150; i++) minute(s, T0 + i * 60000, { a: 100 });
  s.save(true);
  const again = new Store(file);
  again.load();
  const w = again.workerRecord('a');
  check('hours restored', w && w.hours.length === s.workerRecord('a').hours.length, String(w && w.hours.length));
  check('workerHoursSince restored', again.state.workerHoursSince === s.state.workerHoursSince);

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.workerHoursSince = Math.round(Date.now() / 1000) + 10 * 365 * 86400;
  raw.workers.a.hours = [['x', 1, 1], [1, 'y', 1], [3600, 50, -4], ...Array(500).fill([7200, 1, 1])];
  raw.workers.a.trimmedAt = 'soon';
  fs.writeFileSync(file, JSON.stringify(raw));
  const hostile = new Store(file);
  hostile.load();
  const h = hostile.workerRecord('a');
  check('a week of hours at most, numbers only, minutes at least one',
    h.hours.length === WORKER_HOUR_SAMPLES && WORKER_HOUR_SAMPLES === 169 && h.hours.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[2] >= 1), String(h.hours.length));
  check('a start far in the future is dropped', hostile.state.workerHoursSince === null, String(hostile.state.workerHoursSince));
  check('a cut mark that is not a time is dropped', h.trimmedAt === null, String(h.trimmedAt));
}

console.log('\na reset of the charts starts the averages again');
{
  const s = new Store(null);
  s.load();
  for (let i = 0; i < 150; i++) minute(s, T0 + i * 60000, { a: 100 });
  s.reset({ history: true });
  const v = s.workerAverages('a', T0 + 149 * 60000 + 1000);
  check('no averages straight after', v.h1 === null && v.h24 === null && v.d7 === null, JSON.stringify(v));
  check('hours and their start are cleared', s.workerRecord('a').hours.length === 0 && s.state.workerHoursSince === null);
}

console.log('\nminers that dropped out');
{
  const s = new Store(null);
  s.load();
  const now = Date.now();
  for (const [name, ago] of [['gone-2h', 2 * HOUR], ['gone-2d', 48 * HOUR], ['gone-8d', 8 * 24 * HOUR], ['here', 0]]) {
    const w = s.worker(name, now - ago);
    w.lastSeen = now - ago;
    w.accepted = 5;
  }
  const off = s.offlineWorkers(new Set(['here']), now);
  check('the connected one is not listed', !off.some((w) => w.worker === 'here'));
  check('one gone for eight days is not either', !off.some((w) => w.worker === 'gone-8d'));
  check('the rest, most recent first', off.map((w) => w.worker).join() === 'gone-2h,gone-2d', off.map((w) => w.worker).join());
  check('each with its totals and averages', off[0].accepted === 5 && off[0].avg && 'd7' in off[0].avg);
  for (let i = 0; i < 30; i++) s.worker(`extra${i}`, now).lastSeen = now - HOUR;
  check('at most twenty', s.offlineWorkers(new Set(), now).length === 20);
}

console.log('\nthe status carries all of it');
{
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = (buf) => {
    let n = BigInt('0x' + buf.toString('hex'));
    let out = '';
    while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
    for (const byte of buf) { if (byte === 0) out = '1' + out; else break; }
    return out;
  };
  const addr = (version) => {
    const body = Buffer.concat([Buffer.from([version]), crypto.randomBytes(20)]);
    return b58(Buffer.concat([body, u.sha256d(body).subarray(0, 4)]));
  };
  class FakeSocket extends EventEmitter {
    constructor(remoteAddress) { super(); this.remoteAddress = remoteAddress; this.destroyed = false; this.written = []; }
    setKeepAlive() {}
    setNoDelay() {}
    setTimeout() {}
    write(x) { this.written.push(x); return true; }
    destroy() { this.destroyed = true; this.emit('close'); }
  }
  const store = new Store(null);
  store.load();
  const pool = new Pool({
    rpc: { host: '127.0.0.1', port: 1, user: 'u', password: 'p' },
    ltcRpc: { host: '127.0.0.1', port: 1, user: 'u', password: 'p' },
    mergedMining: true,
    payoutAddress: addr(0x1e),
    ltcPayoutAddress: addr(0x30),
    stratumPort: 0,
    maxPayoutVariants: 8,
    handshakeTimeoutMs: 60000,
    publicMerged: true,
  }, store);
  pool.log = () => {};
  pool.ltcChain = 'ltc-main';
  const username = `${addr(0x30)}.${addr(0x1e)}.rig`;
  const socket = new FakeSocket('10.0.0.1');
  pool.onConnection(socket);
  socket.emit('data', Buffer.from(
    JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['t/1'] }) + '\n' +
    JSON.stringify({ id: 2, method: 'mining.authorize', params: [username, 'x'] }) + '\n'
  ));
  const name = [...pool.clients.values()][0].worker;
  // Its history from before this connection: shares, a best share, minutes.
  const now = Date.now();
  for (let i = 30; i > 0; i--) minute(store, now - i * 60000, { [name]: 5e8 });
  store.recordShare(now - 3600000, 123456, 1024, name);
  const gone = store.worker('old@DU4KTk97aC46ZbXjdTpP9tFNYCrmuLZXLd', now - HOUR);
  gone.lastSeen = now - HOUR;

  const snap = JSON.parse(JSON.stringify(pool.snapshot()));
  const w = snap.workers[0] || {};
  check('a connected worker carries its averages', w.avg && near(w.avg.h24, 5e8) && near(w.avg.h1, 5e8), JSON.stringify(w.avg));
  check('its best share ever, from before this connection', w.bestEverDiff === 123456, String(w.bestEverDiff));
  check('its shares since the last reset', w.totalAccepted === 1, String(w.totalAccepted));
  check('and when it was first seen', typeof w.firstSeen === 'number' && w.firstSeen <= now, String(w.firstSeen));
  check('the status lists the miner that dropped out', snap.offlineWorkers.length === 1 &&
    snap.offlineWorkers[0].worker === 'old@DU4KTk97aC46ZbXjdTpP9tFNYCrmuLZXLd', JSON.stringify(snap.offlineWorkers));
  check('but not the connected one as gone', !snap.offlineWorkers.some((x) => x.worker === name));
  pool.stop();
}

console.log('\none name per rig, also on the private port');
{
  const L = 'LdAEjWgrrUjyV6Cy3DTKZ3uBNmG3FQhXsj';
  const D = 'DFabbT3ZNZpm8UjtJkNBFbtcFvrb1kSzx9';
  const P = 'Pfe2U3n5GYXJd9TMAKNCGVhhSDyj35yjvj';
  check('LTC.DOGE.PEP.rig is named rig@DOGE, as on the public port',
    workerName(`${L}.${D}.${P}.nexus`) === `nexus@${D}`, workerName(`${L}.${D}.${P}.nexus`));
  check('two rigs of one owner keep two names',
    workerName(`${L}.${D}.${P}.nexus`) !== workerName(`${L}.${D}.${P}.dogexus1`));
  check('LTC.DOGE.PEP without a rig is the Dogecoin address', workerName(`${L}.${D}.${P}`) === D);
  check('a name that fits is left as it is', workerName(`${D}.nexusl1r`) === `${D}.nexusl1r` && workerName('worker1') === 'worker1');
  check('a long name that is not addresses is cut at 64, as before', workerName('x'.repeat(80)) === 'x'.repeat(64));
  check('a rig name is kept to twenty characters', workerName(`${L}.${D}.${P}.${'r'.repeat(40)}`) === `${'r'.repeat(20)}@${D}`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nMINER AVERAGES VERIFIED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
