'use strict';
//
// PUBLIC merged mining, end to end, through the pool: two strangers on one
// port, each paid on both chains at the addresses in its username, the pool
// taking its fee on both. Derived from merged_pool.js, which covers the
// private mode; this file covers what PUBLIC_MERGED=1 adds.
//
// test/merged_regtest.js proves the auxpow rules against the two daemons using
// the helper directly. This one proves the thing the user actually runs: a
// stratum client connects, is handed work, finds one hash, and that single
// share becomes a Dogecoin block accepted by dogecoind AND a Litecoin block
// accepted by litecoind.
//
// The fake miner deliberately rebuilds the coinbase, merkle root and header
// from nothing but the mining.notify parameters, exactly as firmware does — so
// the aux commitment has to have survived the coinb1/coinb2 split, the
// extranonce splice and the wire encoding. Reusing MergedJob here would hide
// precisely the mistakes that matter.
//
// Usage: node test/public_merged_pool.js <ltcRpcPort> <dogeRpcPort> <stratumPort>
//

const net = require('node:net');

const { Pool } = require('../images/stratum/src/pool');
const { RpcClient } = require('../images/stratum/src/rpc');
const u = require('../images/stratum/src/util');
const aux = require('../images/stratum/src/auxpow');
const pm = require('../images/stratum/src/public-merged');

const LTC_PORT = Number(process.argv[2] || 19332);
const DOGE_PORT = Number(process.argv[3] || 18332);
const STRATUM_PORT = Number(process.argv[4] || 23740);

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const ltc = new RpcClient({ host: '127.0.0.1', port: LTC_PORT, user: 'test', password: 'test' });
const doge = new RpcClient({ host: '127.0.0.1', port: DOGE_PORT, user: 'test', password: 'test' });

class FakeMiner {
  constructor(port) {
    this.port = port;
    this.buffer = '';
    this.handlers = new Map();
    this.nextId = 1;
    this.notifications = [];
    this.difficulty = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(this.port, '127.0.0.1', resolve);
      this.socket.on('error', reject);
      this.socket.on('data', (chunk) => this.onData(chunk));
    });
  }
  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== null && msg.id !== undefined && this.handlers.has(msg.id)) {
        const { resolve } = this.handlers.get(msg.id);
        this.handlers.delete(msg.id);
        resolve(msg);
      } else if (msg.method === 'mining.notify') this.notifications.push(msg.params);
      else if (msg.method === 'mining.set_difficulty') this.difficulty = msg.params[0];
    }
  }
  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.handlers.set(id, { resolve });
      this.socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  waitForNotify(timeoutMs = 15000) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.notifications.length) return resolve(this.notifications.shift());
        if (Date.now() - started > timeoutMs) return reject(new Error('no mining.notify'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }
}

// Reverse the bytes within each 4-byte word — the other half of the stratum
// prevhash encoding.
function wordSwap(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < buf.length; i += 4) {
    out[i] = buf[i + 3]; out[i + 1] = buf[i + 2]; out[i + 2] = buf[i + 1]; out[i + 3] = buf[i];
  }
  return out;
}


const sats = (x) => BigInt(Math.round(x * 1e8));
const addrOf = (o) => (o.scriptPubKey.addresses || (o.scriptPubKey.address ? [o.scriptPubKey.address] : []))[0];

function poolConfig(extra) {
  return {
    rpc: { host: '127.0.0.1', port: DOGE_PORT, user: 'test', password: 'test' },
    ltcRpc: { host: '127.0.0.1', port: LTC_PORT, user: 'test', password: 'test' },
    mergedMining: true,
    publicMerged: true,
    poolFeePercent: 1,
    startDifficulty: 0.0009765625,
    minDifficulty: 0.0009765625,
    maxDifficulty: 1000000,
    maxPayoutVariants: 3,
    targetShareSeconds: 10,
    vardiffWindow: 8,
    hashrateWindowMs: 300000,
    pollIntervalMs: 1000,
    jobRebuildMs: 30000,
    socketTimeoutMs: 600000,
    coinbaseTag: '/pub-test/',
    auxLongpoll: true,
    ...extra,
  };
}

async function mine(params, extranonce1, goal) {
  const [, prevHashStratum, coinb1, coinb2, branch, versionHex, nbitsHex, ntimeHex] = params;
  const prevInternal = u.reverseBuffer(wordSwap(u.reverseBuffer(Buffer.from(prevHashStratum, 'hex'))));
  for (let e2 = 0; e2 < 64; e2++) {
    const extranonce2 = Buffer.alloc(4);
    extranonce2.writeUInt32BE(e2, 0);
    const coinbase = Buffer.concat([Buffer.from(coinb1, 'hex'), extranonce1, extranonce2, Buffer.from(coinb2, 'hex')]);
    let root = u.sha256d(coinbase);
    for (const step of branch) root = u.sha256d(Buffer.concat([root, Buffer.from(step, 'hex')]));
    for (let nonce = 0; nonce < 400000; nonce++) {
      const header = Buffer.alloc(80);
      header.writeInt32LE(parseInt(versionHex, 16), 0);
      prevInternal.copy(header, 4);
      root.copy(header, 36);
      header.writeUInt32LE(parseInt(ntimeHex, 16), 68);
      header.writeUInt32LE(parseInt(nbitsHex, 16), 72);
      header.writeUInt32LE(nonce, 76);
      const pow = u.bufferToBigInt(u.reverseBuffer(u.scryptHash(header)));
      if (pow <= goal) return { extranonce2: extranonce2.toString('hex'), nonce, pow };
    }
  }
  return null;
}

(async () => {
  console.log('\nsetup');
  const poolDoge = await doge.call('getnewaddress');
  const poolLtc = await ltc.call('getnewaddress', ['', 'legacy']);
  const aDoge = await doge.call('getnewaddress');
  // Native segwit (rltc1…/ltc1…), what most Litecoin wallets hand out: the
  // block path below proves litecoind accepts a coinbase paying it.
  const aLtc = await ltc.call('getnewaddress', ['', 'bech32']);
  const bDoge = await doge.call('getnewaddress');
  const bLtc = await ltc.call('getnewaddress', ['', 'legacy']);
  // Non-empty mempools, so the merkle paths on both chains are real.
  await doge.call('sendtoaddress', [await doge.call('getnewaddress'), 3]);
  await ltc.call('sendtoaddress', [await ltc.call('getnewaddress', ['', 'legacy']), 0.1]);

  console.log('\nstartup refuses unsafe combinations');
  let locked = null;
  const lp = new Pool(poolConfig({ payoutAddress: poolDoge, ltcPayoutAddress: poolLtc, lockPayoutAddress: true, stratumPort: STRATUM_PORT + 90 }));
  try { await lp.start(); } catch (err) { locked = err.message; }
  lp.stop();
  check('PUBLIC_MERGED with LOCK_PAYOUT_ADDRESS is refused', /LOCK_PAYOUT_ADDRESS/.test(String(locked)), String(locked));
  let badFee = null;
  const fp = new Pool(poolConfig({ payoutAddress: poolDoge, ltcPayoutAddress: poolLtc, poolFeePercent: 50, stratumPort: STRATUM_PORT + 91 }));
  try { await fp.start(); } catch (err) { badFee = err.message; }
  fp.stop();
  check('a pool fee above 10% is refused', /POOL_FEE_PERCENT/.test(String(badFee)), String(badFee));

  console.log('\nthe public pool starts');
  const pool = new Pool(poolConfig({ payoutAddress: poolDoge, ltcPayoutAddress: poolLtc, stratumPort: STRATUM_PORT }));
  await pool.start();
  const job = pool.currentJob;
  check('the job carries a Dogecoin template, not a createauxblock answer', !!job.dogeTemplate);
  check('the Dogecoin template has the mempool transaction', (job.dogeTemplate.transactions || []).length >= 1);
  check('the Litecoin template has the mempool transaction', (job.template.transactions || []).length >= 1);
  check('the payout lock stays off', !pool.config.lockPayoutAddress);

  console.log('\nusernames');
  const bad = new FakeMiner(STRATUM_PORT); await bad.connect();
  await bad.call('mining.subscribe', ['t/1']);
  const r1 = await bad.call('mining.authorize', ['just-a-name', 'x']);
  check('a plain name is refused', r1.result === false && /LTC address/.test(JSON.stringify(r1.error)), JSON.stringify(r1));
  const r2 = await bad.call('mining.authorize', [`${aLtc}.worker1`, 'x']);
  check('an LTC address without a DOGE address is refused', r2.result === false, JSON.stringify(r2));
  // On regtest both chains share version byte 0x6f, so a swapped pair is
  // indistinguishable there; the order check is a mainnet property, stated on
  // real mainnet addresses.
  const LTC_MAIN = 'LdAEjWgrrUjyV6Cy3DTKZ3uBNmG3FQhXsj';
  const DOGE_MAIN = 'DFabbT3ZNZpm8UjtJkNBFbtcFvrb1kSzx9';
  const okMain = pm.parsePublicUsername(`${LTC_MAIN}.${DOGE_MAIN}.rig`, 'ltc-main', 'main');
  check('a mainnet LTC.DOGE.rig username parses', okMain.ok && okMain.workerName === 'rig', JSON.stringify(okMain.reason));
  const swapped = pm.parsePublicUsername(`${DOGE_MAIN}.${LTC_MAIN}`, 'ltc-main', 'main');
  check('addresses in the wrong order are refused on mainnet', !swapped.ok && /Litecoin/.test(swapped.reason), String(swapped.reason));
  check('a refused worker is handed no work', bad.notifications.length === 0);
  bad.socket.destroy();

  const A = new FakeMiner(STRATUM_PORT); await A.connect();
  const subA = await A.call('mining.subscribe', ['t/1']);
  const enA = Buffer.from(subA.result[1], 'hex');
  const authA = await A.call('mining.authorize', [`${aLtc}.${aDoge}.rig1`, 'x']);
  check('miner A is authorized with LTC.DOGE.worker', authA.result === true, JSON.stringify(authA));
  const B = new FakeMiner(STRATUM_PORT); await B.connect();
  await B.call('mining.subscribe', ['t/1']);
  const authB = await B.call('mining.authorize', [`${bLtc}.${bDoge}`, 'x']);
  check('miner B is authorized with LTC.DOGE', authB.result === true, JSON.stringify(authB));

  const pA = await A.waitForNotify();
  const pB = await B.waitForNotify();
  const auxA = pm.buildAuxBlock(pool.currentJob.dogeTemplate, u.addressToScript(aDoge, 'regtest'),
    u.addressToScript(poolDoge, 'regtest'), 1, '/pub-test/');
  const auxB = pm.buildAuxBlock(pool.currentJob.dogeTemplate, u.addressToScript(bDoge, 'regtest'),
    u.addressToScript(poolDoge, 'regtest'), 1, '/pub-test/');
  check("A's work commits to A's own Dogecoin block", pA[3].includes(aux.auxCommitment(auxA.hash, 0).toString('hex')));
  check("B's work commits to B's own Dogecoin block", pB[3].includes(aux.auxCommitment(auxB.hash, 0).toString('hex')));
  check('A and B are mining different coinbases', pA[3] !== pB[3]);
  check("A's Litecoin coinbase pays A", pA[3].includes(u.addressToScript(aLtc, 'ltc-regtest').toString('hex')));
  check("A's Litecoin coinbase pays the pool fee", pA[3].includes(u.addressToScript(poolLtc, 'ltc-regtest').toString('hex')));

  console.log('\nthe pool caps distinct address pairs');
  const extra = [];
  for (let i = 0; i < 2; i++) {
    const m = new FakeMiner(STRATUM_PORT); await m.connect();
    await m.call('mining.subscribe', ['t/1']);
    const r = await m.call('mining.authorize', [
      `${await ltc.call('getnewaddress', ['', 'legacy'])}.${await doge.call('getnewaddress')}`, 'x']);
    extra.push({ m, r });
  }
  check('the third pair is accepted (limit 3)', extra[0].r.result === true, JSON.stringify(extra[0].r));
  check('the fourth pair is refused as full', extra[1].r.result === false && /full/.test(JSON.stringify(extra[1].r.error)), JSON.stringify(extra[1].r));
  const again = new FakeMiner(STRATUM_PORT); await again.connect();
  await again.call('mining.subscribe', ['t/1']);
  const rAgain = await again.call('mining.authorize', [`${aLtc}.${aDoge}.rig2`, 'x']);
  check('a second rig on an existing pair still gets in', rAgain.result === true, JSON.stringify(rAgain));
  for (const e of extra) e.m.socket.destroy();
  again.socket.destroy();

  console.log('\nno needless clean_jobs while nothing changes');
  A.notifications.length = 0;
  await new Promise((r) => setTimeout(r, 6000));
  const cleans = A.notifications.filter((n) => n[8] === true).length;
  check('six seconds of 1s polls on an idle chain send no clean_jobs', cleans === 0, `${cleans} clean notifies`);

  console.log('\nminer A finds a block on both chains');
  const auxTarget = u.targetFromBits(pool.currentJob.dogeTemplate.bits);
  const ltcTarget = u.targetFromBits(pool.currentJob.template.bits);
  const goal = auxTarget < ltcTarget ? auxTarget : ltcTarget;
  const cur = A.notifications.length ? A.notifications[A.notifications.length - 1] : pA;
  const auxCur = pm.buildAuxBlock(pool.currentJob.dogeTemplate, u.addressToScript(aDoge, 'regtest'),
    u.addressToScript(poolDoge, 'regtest'), 1, '/pub-test/');
  const sol = await mine(cur, enA, goal);
  check('found a hash meeting both targets', !!sol);
  const dBefore = await doge.call('getblockcount');
  const lBefore = await ltc.call('getblockcount');
  const sub = await A.call('mining.submit', [`${aLtc}.${aDoge}.rig1`, cur[0], sol.extranonce2, cur[7], sol.nonce.toString(16).padStart(8, '0')]);
  check('the share is accepted', sub.result === true, JSON.stringify(sub.error));
  await pool.drain(60000);

  const dAfter = await doge.call('getblockcount');
  check('the Dogecoin chain grew by one', dAfter === dBefore + 1, `${dBefore} -> ${dAfter}`);
  const dTip = await doge.call('getblock', [await doge.call('getbestblockhash')]);
  check("the tip is A's own Dogecoin block", dTip.hash === auxCur.hash, `${dTip.hash} vs ${auxCur.hash}`);
  check('it is an auxpow block', !!dTip.auxpow);
  check('it includes the mempool transaction', dTip.tx.length >= 2, String(dTip.tx.length));
  const dCb = await doge.call('getrawtransaction', [dTip.tx[0], 1]);
  const dPaid = {}; for (const o of dCb.vout) dPaid[addrOf(o)] = sats(o.value);
  check('A received 99% of the Dogecoin reward', dPaid[aDoge] === auxCur.minerValue, `${dPaid[aDoge]} vs ${auxCur.minerValue}`);
  check('the pool received 1% of the Dogecoin reward', dPaid[poolDoge] === auxCur.feeValue, `${dPaid[poolDoge]} vs ${auxCur.feeValue}`);
  check('nobody else was paid on Dogecoin', Object.keys(dPaid).length === 2, Object.keys(dPaid).join(','));

  const lAfter = await ltc.call('getblockcount');
  check('the Litecoin chain grew by one', lAfter === lBefore + 1, `${lBefore} -> ${lAfter}`);
  const lTip = await ltc.call('getblock', [await ltc.call('getbestblockhash'), 2]);
  const lPaid = {}; for (const o of lTip.tx[0].vout) { const a = addrOf(o); if (a) lPaid[a] = sats(o.value); }
  const split = pm.splitReward(pool.jobs.get(cur[0]).template.coinbasevalue, 1);
  check('A received 99% of the Litecoin reward', lPaid[aLtc] === split.miner, `${lPaid[aLtc]} vs ${split.miner}`);
  check('the pool received 1% of the Litecoin reward', lPaid[poolLtc] === split.fee, `${lPaid[poolLtc]} vs ${split.fee}`);
  check('B was paid nothing', !lPaid[bLtc] && !dPaid[bDoge]);

  const snap = pool.snapshot();
  const dRec = snap.blocks.find((b) => b.chain === 'DOGE');
  const lRec = snap.blocks.find((b) => b.chain === 'LTC');
  check('the DOGE record names A\'s address and is accepted', dRec && dRec.accepted === true && dRec.address === aDoge, JSON.stringify(dRec));
  check('the LTC record names A\'s address and is accepted', lRec && lRec.accepted === true && lRec.address === aLtc, JSON.stringify(lRec));

  console.log('\nthe job follows the tips');
  const prevAux = pool.currentJob.auxHash;
  await doge.call('generatetoaddress', [1, poolDoge]);
  const followed = await waitFor(() => pool.currentJob && pool.currentJob.auxHash !== prevAux, 20000);
  check('a Dogecoin-only tip change rebuilds the job', followed);
  const n = await A.waitForNotify(20000).catch(() => null);
  check('miner A is re-notified afterwards', !!n);

  A.socket.destroy(); B.socket.destroy();
  pool.stop();
  console.log(failures === 0 ? '\nPUBLIC MERGED POOL VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });

async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
