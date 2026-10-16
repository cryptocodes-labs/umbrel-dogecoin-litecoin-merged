'use strict';
//
// Pepecoin through the pool, end to end, against litecoind, dogecoind and
// pepecoind on regtest:
//
//   1. Private mode: one share becomes a Pepecoin block (beside Litecoin and
//      Dogecoin) paying PEP_PAYOUT_ADDRESS.
//   2. Public mode: a miner who adds a Pepecoin address to its username is paid
//      99% of a Pepecoin block; a miner who does not gets exactly the
//      single-chain work it always got.
//   3. pepecoind going away: Pepecoin drops out of the next job and Litecoin
//      and Dogecoin keep being mined.
//
// The fake miner rebuilds coinbase, merkle root and header from nothing but
// the mining.notify parameters, as firmware does — reusing MergedJob here
// would hide exactly the mistakes that matter (see public_merged_pool.js).
//
// Runs LAST in test/merged_regtest.sh: part 3 stops pepecoind.
//
// Usage: node test/pep_pool_regtest.js <ltcRpcPort> <dogeRpcPort> <pepRpcPort> <stratumPort>
//
const net = require('node:net');
const { Pool } = require('../images/stratum/src/pool');
const { RpcClient } = require('../images/stratum/src/rpc');
const u = require('../images/stratum/src/util');
const aux = require('../images/stratum/src/auxpow');
const pm = require('../images/stratum/src/public-merged');
const { PEP_CHAIN_ID, DOGE_CHAIN_ID } = require('../images/stratum/src/merged');

const LTC_PORT = Number(process.argv[2] || 19332);
const DOGE_PORT = Number(process.argv[3] || 18332);
const PEP_PORT = Number(process.argv[4] || 24655);
const STRATUM_PORT = Number(process.argv[5] || 24800);

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const ltc = new RpcClient({ host: '127.0.0.1', port: LTC_PORT, user: 'test', password: 'test' });
const doge = new RpcClient({ host: '127.0.0.1', port: DOGE_PORT, user: 'test', password: 'test' });
const pep = new RpcClient({ host: '127.0.0.1', port: PEP_PORT, user: 'test', password: 'test' });

class FakeMiner {
  constructor(port) { this.port = port; this.buffer = ''; this.handlers = new Map(); this.nextId = 1; this.notifications = []; }
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
    }
  }
  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.handlers.set(id, { resolve });
      this.socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async waitForNotify(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.notifications.length) return this.notifications.shift();
      await sleep(20);
    }
    throw new Error('no mining.notify');
  }
  latest() { return this.notifications.length ? this.notifications[this.notifications.length - 1] : null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function wordSwap(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < buf.length; i += 4) {
    out[i] = buf[i + 3]; out[i + 1] = buf[i + 2]; out[i + 2] = buf[i + 1]; out[i + 3] = buf[i];
  }
  return out;
}
const sats = (x) => BigInt(Math.round(x * 1e8));
const addrOf = (o) => (o.scriptPubKey.addresses || (o.scriptPubKey.address ? [o.scriptPubKey.address] : []))[0];
async function paid(rpc, blockHash) {
  const block = await rpc.call('getblock', [blockHash]);
  const tx = await rpc.call('getrawtransaction', [block.tx[0], 1]);
  const out = {};
  for (const o of tx.vout) { const a = addrOf(o); if (a) out[a] = sats(o.value); }
  return out;
}
async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await fn()) return true; await sleep(200); }
  return false;
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
      if (pow <= goal) return { extranonce2: extranonce2.toString('hex'), nonce };
    }
  }
  return null;
}
const minOf = (...xs) => xs.reduce((a, b) => (a < b ? a : b));

function poolConfig(extra) {
  return {
    rpc: { host: '127.0.0.1', port: DOGE_PORT, user: 'test', password: 'test' },
    ltcRpc: { host: '127.0.0.1', port: LTC_PORT, user: 'test', password: 'test' },
    mergedMining: true,
    poolFeePercent: 1,
    startDifficulty: 0.0009765625,
    minDifficulty: 0.0009765625,
    maxDifficulty: 1000000,
    maxPayoutVariants: 4,
    targetShareSeconds: 10,
    vardiffWindow: 8,
    hashrateWindowMs: 300000,
    pollIntervalMs: 1000,
    pepPollMs: 1000,
    jobRebuildMs: 30000,
    socketTimeoutMs: 600000,
    coinbaseTag: '/pep-test/',
    auxLongpoll: true,
    ...extra,
  };
}

async function connectMiner(port, username) {
  const m = new FakeMiner(port);
  await m.connect();
  const sub = await m.call('mining.subscribe', ['t/1']);
  const auth = await m.call('mining.authorize', [username, 'x']);
  return { m, en1: Buffer.from(sub.result[1], 'hex'), auth };
}

(async () => {
  const poolDoge = await doge.call('getnewaddress');
  const poolLtc = await ltc.call('getnewaddress', ['', 'legacy']);
  const poolPep = await pep.call('getnewaddress');

  // ------------------------------------------------------------- private
  console.log('\n1. private mode: Pepecoin beside Litecoin and Dogecoin');
  {
    const pool = new Pool(poolConfig({
      payoutAddress: poolDoge, ltcPayoutAddress: poolLtc, stratumPort: STRATUM_PORT,
      pep: { rpc: { host: '127.0.0.1', port: PEP_PORT, user: 'test', password: 'test' }, payoutAddress: poolPep },
    }));
    await pool.start();
    const job = pool.currentJob;
    check('the first job already carries Pepecoin', job.extraAux.length === 1 && job.extraAux[0].chainId === PEP_CHAIN_ID);
    const { m, en1, auth } = await connectMiner(STRATUM_PORT, 'rig');
    check('a miner is authorized', auth.result === true, JSON.stringify(auth));
    const n = await m.waitForNotify();
    const tree = aux.buildChainTree([
      { chainId: DOGE_CHAIN_ID, hash: job.auxHash },
      { chainId: PEP_CHAIN_ID, hash: job.extraAux[0].hash },
    ]);
    check('its work commits to the two-chain root', n[3].includes(aux.auxCommitment(tree.root, tree.nonce, tree.size).toString('hex')));

    const cur = pool.jobs.get(n[0]);
    const goal = minOf(cur.networkTarget, cur.auxTarget, cur.extraAux[0].target);
    const sol = await mine(n, en1, goal);
    check('found a hash meeting all three targets', !!sol);
    const [l0, d0, p0] = await Promise.all([ltc.call('getblockcount'), doge.call('getblockcount'), pep.call('getblockcount')]);
    const r = await m.call('mining.submit', ['rig', n[0], sol.extranonce2, n[7], sol.nonce.toString(16).padStart(8, '0')]);
    check('the share is accepted', r.result === true, JSON.stringify(r.error));
    await pool.drain(60000);
    const [l1, d1, p1] = await Promise.all([ltc.call('getblockcount'), doge.call('getblockcount'), pep.call('getblockcount')]);
    check('Litecoin grew by one', l1 === l0 + 1, `${l0} -> ${l1}`);
    check('Dogecoin grew by one', d1 === d0 + 1, `${d0} -> ${d1}`);
    check('Pepecoin grew by one', p1 === p0 + 1, `${p0} -> ${p1}`);
    const pepTip = await pep.call('getbestblockhash');
    check('the Pepecoin tip is our block', pepTip === cur.extraAux[0].hash, `${pepTip} vs ${cur.extraAux[0].hash}`);
    check('and it pays PEP_PAYOUT_ADDRESS', Object.keys(await paid(pep, pepTip)).includes(poolPep));
    const rec = pool.snapshot().blocks.find((b) => b.chain === 'PEP');
    check('a PEP record, accepted, at the pool address', rec && rec.accepted === true && rec.address === poolPep, JSON.stringify(rec));
    m.socket.destroy();
    pool.stop();
  }

  // -------------------------------------------------------------- public
  console.log('\n2. public mode: Pepecoin for the miners who ask for it');
  const pool = new Pool(poolConfig({
    payoutAddress: poolDoge, ltcPayoutAddress: poolLtc, stratumPort: STRATUM_PORT + 10, publicMerged: true,
    pep: { rpc: { host: '127.0.0.1', port: PEP_PORT, user: 'test', password: 'test' }, payoutAddress: poolPep },
  }));
  await pool.start();
  check('the job carries a Pepecoin template', !!pool.currentJob.pepTemplate);

  const aLtc = await ltc.call('getnewaddress', ['', 'legacy']);
  const aDoge = await doge.call('getnewaddress');
  const aPep = await pep.call('getnewaddress');
  const bLtc = await ltc.call('getnewaddress', ['', 'legacy']);
  const bDoge = await doge.call('getnewaddress');
  const A = await connectMiner(STRATUM_PORT + 10, `${aLtc}.${aDoge}.${aPep}.rig1`);
  const B = await connectMiner(STRATUM_PORT + 10, `${bLtc}.${bDoge}.rig2`);
  check('miner A (LTC.DOGE.PEP.rig) is authorized', A.auth.result === true, JSON.stringify(A.auth));
  check('miner B (LTC.DOGE.rig) is authorized', B.auth.result === true, JSON.stringify(B.auth));
  const nA = await A.m.waitForNotify();
  const nB = await B.m.waitForNotify();

  const job = pool.currentJob;
  const dogeScript = (a) => u.addressToScript(a, 'regtest');
  const pepScript = (a) => u.addressToScript(a, 'pep-regtest');
  const dA = pm.buildAuxBlock(job.dogeTemplate, dogeScript(aDoge), dogeScript(poolDoge), 1, '/pep-test/');
  const pA = pm.buildAuxBlock(job.pepTemplate, pepScript(aPep), pepScript(poolPep), 1, '/pep-test/', PEP_CHAIN_ID);
  const dB = pm.buildAuxBlock(job.dogeTemplate, dogeScript(bDoge), dogeScript(poolDoge), 1, '/pep-test/');
  const treeA = aux.buildChainTree([{ chainId: DOGE_CHAIN_ID, hash: dA.hash }, { chainId: PEP_CHAIN_ID, hash: pA.hash }]);
  check("A's work commits to A's own DOGE and PEP blocks",
    nA[3].includes(aux.auxCommitment(treeA.root, treeA.nonce, treeA.size).toString('hex')));
  check("B's work is the single-chain commitment it always was",
    nB[3].includes(aux.auxCommitment(dB.hash, 0).toString('hex')));

  const goal = minOf(
    u.targetFromBits(job.template.bits), u.targetFromBits(job.dogeTemplate.bits), u.targetFromBits(job.pepTemplate.bits)
  );
  const sol = await mine(nA, A.en1, goal);
  check('A found a hash meeting all three targets', !!sol);
  const [l0, d0, p0] = await Promise.all([ltc.call('getblockcount'), doge.call('getblockcount'), pep.call('getblockcount')]);
  const r = await A.m.call('mining.submit', [`${aLtc}.${aDoge}.${aPep}.rig1`, nA[0], sol.extranonce2, nA[7], sol.nonce.toString(16).padStart(8, '0')]);
  check('the share is accepted', r.result === true, JSON.stringify(r.error));
  await pool.drain(60000);
  const [l1, d1, p1] = await Promise.all([ltc.call('getblockcount'), doge.call('getblockcount'), pep.call('getblockcount')]);
  check('Litecoin, Dogecoin and Pepecoin each grew by one', l1 === l0 + 1 && d1 === d0 + 1 && p1 === p0 + 1,
    `${l0}->${l1} ${d0}->${d1} ${p0}->${p1}`);
  const pepTip = await pep.call('getbestblockhash');
  check("the Pepecoin tip is A's own block", pepTip === pA.hash, `${pepTip} vs ${pA.hash}`);
  const pPaid = await paid(pep, pepTip);
  check('A received 99% of the Pepecoin reward', pPaid[aPep] === pA.minerValue, `${pPaid[aPep]} vs ${pA.minerValue}`);
  check('the pool received 1% of the Pepecoin reward', pPaid[poolPep] === pA.feeValue, `${pPaid[poolPep]} vs ${pA.feeValue}`);
  const rec = pool.snapshot().blocks.find((b) => b.chain === 'PEP');
  check("the PEP record names A's Pepecoin address", rec && rec.accepted === true && rec.address === aPep, JSON.stringify(rec));

  // ----------------------------------------------------- pepecoind away
  console.log('\n3. pepecoind goes away; Litecoin and Dogecoin carry on');
  await pep.call('stop');
  const dropped = await waitFor(() => pool.currentJob && !pool.currentJob.pepTemplate && pool.currentJob.extraAux.length === 0, 20000);
  check('Pepecoin drops out of the job within seconds', dropped);
  check('the dashboard says why', !!(pool.snapshot().pep && pool.snapshot().pep.unavailableSince));
  check('and it is not a template error — the pool is healthy', !pool.snapshot().templateError, String(pool.snapshot().templateError));
  A.m.notifications.length = 0;
  await doge.call('generatetoaddress', [1, poolDoge]);
  const nA2 = await A.m.waitForNotify(20000).catch(() => null);
  check('miner A keeps getting work', !!nA2);
  if (nA2) {
    await sleep(1500); // let any rebuild from the same tip move settle
    const work = A.m.latest() || nA2;
    const dA2 = pm.buildAuxBlock(pool.jobs.get(work[0]).dogeTemplate, dogeScript(aDoge), dogeScript(poolDoge), 1, '/pep-test/');
    check("A's work is back to the single-chain commitment", work[3].includes(aux.auxCommitment(dA2.hash, 0).toString('hex')));
    const g2 = minOf(u.targetFromBits(pool.currentJob.template.bits), u.targetFromBits(pool.currentJob.dogeTemplate.bits));
    const sol2 = await mine(work, A.en1, g2);
    const [l2, d2] = await Promise.all([ltc.call('getblockcount'), doge.call('getblockcount')]);
    const r2 = await A.m.call('mining.submit', [`${aLtc}.${aDoge}.${aPep}.rig1`, work[0], sol2.extranonce2, work[7], sol2.nonce.toString(16).padStart(8, '0')]);
    check('a share is still accepted', r2.result === true, JSON.stringify(r2.error));
    await pool.drain(60000);
    const [l3, d3] = await Promise.all([ltc.call('getblockcount'), doge.call('getblockcount')]);
    check('and still makes a Litecoin and a Dogecoin block', l3 === l2 + 1 && d3 === d2 + 1, `${l2}->${l3} ${d2}->${d3}`);
  }

  A.m.socket.destroy(); B.m.socket.destroy();
  pool.stop();
  console.log(failures === 0 ? '\nPEPECOIN POOL VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
