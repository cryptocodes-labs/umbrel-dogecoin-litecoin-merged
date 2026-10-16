'use strict';
//
// Which workers mine Pepecoin, as the status snapshot reports it — no daemon
// needed, so this runs in CI.
//
// The pool overview counts PEP hashrate over the workers whose snapshot entry
// carries a pepPayoutAddress, so that field has to be right per worker:
//
//   * public port, LTC.DOGE.PEP.rig: the worker's own Pepecoin address;
//   * public port, LTC.DOGE.rig: null (it mines Litecoin and Dogecoin only);
//   * public port with Pepecoin off: null, whatever the username says;
//   * private port: null for both, the app's own addresses pay there.
//
// Each miner goes through the real path — onConnection, onData, subscribe,
// authorize — over a fake socket. The daemon-backed check of the same fields
// is part 2 of test/pep_pool_regtest.js.
//
// Usage: node test/pep_snapshot_unit.js
//
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const u = require('../images/stratum/src/util');
const { Pool } = require('../images/stratum/src/pool');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (buf) => {
  let n = BigInt('0x' + buf.toString('hex'));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const byte of buf) { if (byte === 0) s = '1' + s; else break; }
  return s;
};
const addr = (version) => {
  const body = Buffer.concat([Buffer.from([version]), crypto.randomBytes(20)]);
  return b58(Buffer.concat([body, u.sha256d(body).subarray(0, 4)]));
};

// What onConnection touches on a net.Socket, and nothing more. Writes are kept
// so a test can read the authorize reply.
class FakeSocket extends EventEmitter {
  constructor(remoteAddress) { super(); this.remoteAddress = remoteAddress; this.destroyed = false; this.written = []; }
  setKeepAlive() {}
  setNoDelay() {}
  setTimeout() {}
  write(s) { this.written.push(s); return true; }
  destroy() { this.destroyed = true; this.emit('close'); }
}

function poolWith(extra) {
  const pool = new Pool({
    rpc: { host: '127.0.0.1', port: 1, user: 'u', password: 'p' },
    ltcRpc: { host: '127.0.0.1', port: 1, user: 'u', password: 'p' },
    mergedMining: true,
    payoutAddress: addr(0x1e),
    ltcPayoutAddress: addr(0x30),
    stratumPort: 0,
    maxPayoutVariants: 8,
    handshakeTimeoutMs: 60000,
    ...extra,
  });
  pool.log = () => {};
  // Set by startMerged() from the nodes' answers; there are no nodes here.
  pool.ltcChain = 'ltc-main';
  pool.pepChain = 'pep-main';
  return pool;
}

let ipCounter = 0;
function connect(pool, username) {
  const socket = new FakeSocket(`10.0.0.${++ipCounter}`);
  pool.onConnection(socket);
  socket.emit('data', Buffer.from(
    JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['t/1'] }) + '\n' +
    JSON.stringify({ id: 2, method: 'mining.authorize', params: [username, 'x'] }) + '\n'
  ));
  const reply = socket.written.map((l) => JSON.parse(l)).find((m) => m.id === 2);
  return { socket, authorized: !!(reply && reply.result === true), reply };
}

const workerOf = (pool, socket) => {
  const client = [...pool.clients.values()].find((c) => c.socket === socket);
  return client ? pool.snapshot().workers.find((w) => w.id === client.id) : null;
};

const pepConfig = { rpc: { host: '127.0.0.1', port: 1, user: 'u', password: 'p' }, payoutAddress: addr(0x38) };

console.log('\npublic port, Pepecoin on');
{
  const pool = poolWith({ publicMerged: true, pep: pepConfig });
  const ltc = addr(0x30);
  const doge = addr(0x1e);
  const pep = addr(0x38);
  const A = connect(pool, `${ltc}.${doge}.${pep}.rig`);
  check('LTC.DOGE.PEP.rig is authorized', A.authorized, JSON.stringify(A.reply));
  const a = workerOf(pool, A.socket);
  check('its snapshot entry carries its Pepecoin address', a && a.pepPayoutAddress === pep, JSON.stringify(a && a.pepPayoutAddress));
  check('and its Litecoin address', a && a.ltcPayoutAddress === ltc, JSON.stringify(a && a.ltcPayoutAddress));
  check('and its Dogecoin address, as before', a && a.payoutAddress === doge, JSON.stringify(a && a.payoutAddress));

  const bLtc = addr(0x30);
  const bDoge = addr(0x1e);
  const B = connect(pool, `${bLtc}.${bDoge}.rig`);
  check('LTC.DOGE.rig is authorized', B.authorized, JSON.stringify(B.reply));
  const b = workerOf(pool, B.socket);
  check('its pepPayoutAddress is null', b && b.pepPayoutAddress === null, JSON.stringify(b && b.pepPayoutAddress));
  check('its ltcPayoutAddress is its own', b && b.ltcPayoutAddress === bLtc, JSON.stringify(b && b.ltcPayoutAddress));

  const C = connect(pool, `${addr(0x30)}.${addr(0x1e)}`);
  const c = workerOf(pool, C.socket);
  check('LTC.DOGE without a rig: pepPayoutAddress null', C.authorized && c && c.pepPayoutAddress === null,
    JSON.stringify(c && c.pepPayoutAddress));

  const snap = pool.snapshot();
  check('exactly one of three workers reports a Pepecoin address',
    snap.workers.filter((w) => w.pepPayoutAddress).length === 1, String(snap.workers.length));
  check('every worker has both fields, never undefined',
    snap.workers.every((w) => 'pepPayoutAddress' in w && 'ltcPayoutAddress' in w));
  check('the snapshot survives JSON with the fields intact', (() => {
    const back = JSON.parse(JSON.stringify(snap)).workers;
    return back.some((w) => w.pepPayoutAddress === pep) && back.filter((w) => w.pepPayoutAddress === null).length === 2;
  })());

  A.socket.destroy();
  check('a disconnected worker leaves the snapshot', !pool.snapshot().workers.some((w) => w.pepPayoutAddress === pep));
  pool.stop();
}

console.log('\npublic port, Pepecoin off');
{
  const pool = poolWith({ publicMerged: true });
  const pep = addr(0x38);
  const A = connect(pool, `${addr(0x30)}.${addr(0x1e)}.${pep}.rig`);
  check('LTC.DOGE.PEP.rig is still authorized', A.authorized, JSON.stringify(A.reply));
  const a = workerOf(pool, A.socket);
  check('but reports no Pepecoin address: it is not mining Pepecoin', a && a.pepPayoutAddress === null,
    JSON.stringify(a && a.pepPayoutAddress));
  pool.stop();
}

console.log('\nprivate port');
{
  const pool = poolWith({ pep: pepConfig });
  const A = connect(pool, 'rig1');
  check('a private worker is authorized', A.authorized, JSON.stringify(A.reply));
  const a = workerOf(pool, A.socket);
  check('pepPayoutAddress and ltcPayoutAddress are null there',
    a && a.pepPayoutAddress === null && a.ltcPayoutAddress === null, JSON.stringify(a));
  pool.stop();
}

console.log(failures === 0 ? '\nPEP SNAPSHOT VERIFIED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
