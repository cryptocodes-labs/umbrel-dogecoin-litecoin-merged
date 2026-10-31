'use strict';
//
// Soqucoin through the pool, end to end, against litecoind, dogecoind,
// pepecoind and soqucoind on regtest:
//
//   1. Private mode: one share becomes a Litecoin, a Dogecoin, a Pepecoin AND a
//      Soqucoin block; the Soqucoin block is the one soqucoind built with
//      createauxblock and pays SOQ_PAYOUT_ADDRESS.
//   2. A Base58 SOQ_PAYOUT_ADDRESS switches Soqucoin off and nothing else.
//   3. The public port ignores SOQ_* and says so.
//   4. soqucoind going away: Soqucoin drops out of the next job and the other
//      three chains keep being mined.
//
// The fake miner rebuilds coinbase, merkle root and header from nothing but
// the mining.notify parameters, as firmware does (see pep_pool_regtest.js).
//
// Runs before pep_pool_regtest in test/merged_regtest.sh: part 4 stops
// soqucoind, and pepecoind must still be up for that suite.
//
// Usage: node test/soq_pool_regtest.js <ltcRpcPort> <dogeRpcPort> <pepRpcPort> <soqRpcPort> <stratumPort>
//
const net = require('node:net');
const crypto = require('node:crypto');
const { Pool } = require('../images/stratum/src/pool');
const { RpcClient } = require('../images/stratum/src/rpc');
const u = require('../images/stratum/src/util');
const aux = require('../images/stratum/src/auxpow');
const { PEP_CHAIN_ID, DOGE_CHAIN_ID, SOQ_CHAIN_ID } = require('../images/stratum/src/merged');

const LTC_PORT = Number(process.argv[2] || 19332);
const DOGE_PORT = Number(process.argv[3] || 18332);
const PEP_PORT = Number(process.argv[4] || 24655);
const SOQ_PORT = Number(process.argv[5] || 24755);
const STRATUM_PORT = Number(process.argv[6] || 24900);

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const ltc = new RpcClient({ host: '127.0.0.1', port: LTC_PORT, user: 'test', password: 'test' });
const doge = new RpcClient({ host: '127.0.0.1', port: DOGE_PORT, user: 'test', password: 'test' });
const pep = new RpcClient({ host: '127.0.0.1', port: PEP_PORT, user: 'test', password: 'test' });
const soq = new RpcClient({ host: '127.0.0.1', port: SOQ_PORT, user: 'test', password: 'test' });

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
    soqPollMs: 1000,
    jobRebuildMs: 30000,
    socketTimeoutMs: 600000,
    coinbaseTag: '/soq-test/',
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

// A Bech32m witness-v1 address (BIP350), the only kind soqucoind should ever be
// paid at. Written apart from util.js so the pool's decoder is not checked
// against itself.
function soqAddress(program) {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const polymod = (values) => {
    let chk = 1;
    for (const v of values) {
      const b = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
    }
    return chk >>> 0;
  };
  const hrp = 'sq';
  const data = [1];
  let acc = 0; let bits = 0;
  for (const byte of program) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; data.push((acc >> bits) & 31); }
  }
  if (bits) data.push((acc << (5 - bits)) & 31);
  const exp = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod(exp.concat(data, [0, 0, 0, 0, 0, 0])) ^ 0x2bc830a3;
  return `${hrp}1${data.concat([0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31)).map((d) => CHARSET[d]).join('')}`;
}

async function coinbaseScripts(rpc, blockHash) {
  const block = await rpc.call('getblock', [blockHash]);
  const tx = await rpc.call('getrawtransaction', [block.tx[0], 1]);
  return tx.vout.map((o) => ({ value: sats(o.value), hex: o.scriptPubKey.hex }));
}

const counts = () => Promise.all([
  ltc.call('getblockcount'), doge.call('getblockcount'), pep.call('getblockcount'), soq.call('getblockcount'),
]);

(async () => {
  const poolDoge = await doge.call('getnewaddress');
  const poolLtc = await ltc.call('getnewaddress', ['', 'legacy']);
  const poolPep = await pep.call('getnewaddress');
  const program = crypto.randomBytes(32);
  const poolSoq = soqAddress(program);
  const soqScriptHex = `5120${program.toString('hex')}`;

  // Regtest Soqucoin accepts auxpow from height 20 (src/chainparams.cpp).
  const v = await soq.call('validateaddress', [poolSoq]);
  check('soqucoind itself calls the test address a Dilithium (v1) address', v.isvalid === true && v.isdilithium === true, JSON.stringify(v));
  if ((await soq.call('getblockcount')) < 25) await soq.call('generatetoaddress', [25, poolSoq]);
  const probe = await soq.call('createauxblock', [poolSoq]);
  check('soqucoind serves createauxblock for chain 21329', probe.chainid === SOQ_CHAIN_ID, JSON.stringify(probe));

  // --------------------------------------------------------- four chains
  console.log('\n1. private mode: Soqucoin beside Litecoin, Dogecoin and Pepecoin');
  {
    const pool = new Pool(poolConfig({
      payoutAddress: poolDoge, ltcPayoutAddress: poolLtc, stratumPort: STRATUM_PORT,
      pep: { rpc: { host: '127.0.0.1', port: PEP_PORT, user: 'test', password: 'test' }, payoutAddress: poolPep },
      soq: { rpc: { host: '127.0.0.1', port: SOQ_PORT, user: 'test', password: 'test' }, payoutAddress: poolSoq },
    }));
    await pool.start();
    const job = pool.currentJob;
    check('the first job carries Pepecoin and Soqucoin',
      job.extraAux.map((a) => a.name).join() === 'PEP,SOQ', job.extraAux.map((a) => a.name).join());
    const { m, en1, auth } = await connectMiner(STRATUM_PORT, 'rig');
    check('a miner is authorized', auth.result === true, JSON.stringify(auth));
    const n = await m.waitForNotify();
    const cur = pool.jobs.get(n[0]);
    const soqAux = cur.extraAux.find((a) => a.name === 'SOQ');
    const tree = aux.buildChainTree([
      { chainId: DOGE_CHAIN_ID, hash: cur.auxHash },
      { chainId: PEP_CHAIN_ID, hash: cur.extraAux[0].hash },
      { chainId: SOQ_CHAIN_ID, hash: soqAux.hash },
    ]);
    check('its work commits to the three-chain root (size 4)',
      tree.size === 4 && n[3].includes(aux.auxCommitment(tree.root, tree.nonce, tree.size).toString('hex')));

    const goal = minOf(cur.networkTarget, cur.auxTarget, ...cur.extraAux.map((a) => a.target));
    const sol = await mine(n, en1, goal);
    check('found a hash meeting all four targets', !!sol);
    const [l0, d0, p0, s0] = await counts();
    const r = await m.call('mining.submit', ['rig', n[0], sol.extranonce2, n[7], sol.nonce.toString(16).padStart(8, '0')]);
    check('the share is accepted', r.result === true, JSON.stringify(r.error));
    await pool.drain(60000);
    const [l1, d1, p1, s1] = await counts();
    check('Litecoin grew by one', l1 === l0 + 1, `${l0} -> ${l1}`);
    check('Dogecoin grew by one', d1 === d0 + 1, `${d0} -> ${d1}`);
    check('Pepecoin grew by one', p1 === p0 + 1, `${p0} -> ${p1}`);
    check('Soqucoin grew by one', s1 === s0 + 1, `${s0} -> ${s1}`);
    const soqTip = await soq.call('getbestblockhash');
    check('the Soqucoin tip is the block soqucoind built for us', soqTip === soqAux.hash, `${soqTip} vs ${soqAux.hash}`);
    const outs = await coinbaseScripts(soq, soqTip);
    const paidOut = outs.find((o) => o.hex === soqScriptHex);
    check('its coinbase pays SOQ_PAYOUT_ADDRESS (OP_1 <32 bytes>) the whole reward',
      paidOut && paidOut.value === BigInt(soqAux.value), JSON.stringify(outs.map((o) => [o.hex, String(o.value)])));
    const tipBlock = await soq.call('getblock', [soqTip]);
    check('the block is merge-mined (it carries an auxpow)', !!tipBlock.auxpow);
    const rec = pool.snapshot().blocks.find((b) => b.chain === 'SOQ');
    check('a SOQ record, accepted, at the SOQ address', rec && rec.accepted === true && rec.address === poolSoq, JSON.stringify(rec));
    const pepRec = pool.snapshot().blocks.find((b) => b.chain === 'PEP');
    check('and the PEP record beside it', pepRec && pepRec.accepted === true, JSON.stringify(pepRec));
    check('the status reports the Soqucoin height', pool.snapshot().soq && pool.snapshot().soq.height >= s0, JSON.stringify(pool.snapshot().soq));
    const chains = pool.snapshot().chains || [];
    check('the status lists all four coins with their own difficulty, for the distance per coin',
      chains.map((c) => c.name).join() === 'LTC,DOGE,PEP,SOQ' && chains.every((c) => c.difficulty > 0), JSON.stringify(chains));
    m.socket.destroy();
    pool.stop();
  }

  // ---------------------------------------------------- refused address
  console.log('\n2. a Base58 SOQ_PAYOUT_ADDRESS switches Soqucoin off, nothing else');
  {
    const lines = [];
    const pool = new Pool(poolConfig({
      payoutAddress: poolDoge, ltcPayoutAddress: poolLtc, stratumPort: STRATUM_PORT + 10,
      pep: { rpc: { host: '127.0.0.1', port: PEP_PORT, user: 'test', password: 'test' }, payoutAddress: poolPep },
      // soqucoind's createauxblock would accept this one — and mine to an
      // output nobody can spend.
      soq: { rpc: { host: '127.0.0.1', port: SOQ_PORT, user: 'test', password: 'test' }, payoutAddress: poolDoge },
    }));
    pool.log = (s) => lines.push(s);
    await pool.start();
    check('the pool starts', !!pool.currentJob);
    check('Soqucoin is off', pool.soq === null);
    check('and the log says why', lines.some((l) => /Soqucoin DISABLED/.test(l)), lines.join(' | '));
    check('Pepecoin is still in the job', pool.currentJob.extraAux.map((a) => a.name).join() === 'PEP');
    pool.stop();
  }

  // -------------------------------------------------------- public port
  console.log('\n3. the public port ignores SOQ_* and says so');
  {
    const lines = [];
    const pool = new Pool(poolConfig({
      payoutAddress: poolDoge, ltcPayoutAddress: poolLtc, stratumPort: STRATUM_PORT + 20, publicMerged: true,
      pep: { rpc: { host: '127.0.0.1', port: PEP_PORT, user: 'test', password: 'test' }, payoutAddress: poolPep },
      soq: { rpc: { host: '127.0.0.1', port: SOQ_PORT, user: 'test', password: 'test' }, payoutAddress: poolSoq },
    }));
    pool.log = (s) => lines.push(s);
    await pool.start();
    check('no Soqucoin on the public port', pool.soq === null && pool.currentJob.extraAux.every((a) => a.name !== 'SOQ'));
    check('the log says so', lines.some((l) => /private port only/.test(l)), lines.join(' | '));
    check('Pepecoin is unaffected', !!pool.currentJob.pepTemplate);
    pool.stop();
  }

  // ---------------------------------------------------- soqucoind away
  console.log('\n4. soqucoind goes away; Litecoin, Dogecoin and Pepecoin carry on');
  {
    const pool = new Pool(poolConfig({
      payoutAddress: poolDoge, ltcPayoutAddress: poolLtc, stratumPort: STRATUM_PORT + 30,
      pep: { rpc: { host: '127.0.0.1', port: PEP_PORT, user: 'test', password: 'test' }, payoutAddress: poolPep },
      soq: { rpc: { host: '127.0.0.1', port: SOQ_PORT, user: 'test', password: 'test' }, payoutAddress: poolSoq },
    }));
    pool.log = () => {};
    await pool.start();
    check('Soqucoin is in the job to begin with', pool.currentJob.extraAux.some((a) => a.name === 'SOQ'));
    const { m, en1 } = await connectMiner(STRATUM_PORT + 30, 'rig');
    await m.waitForNotify();
    await soq.call('stop');
    const dropped = await waitFor(() => pool.currentJob && pool.currentJob.extraAux.map((a) => a.name).join() === 'PEP', 20000);
    check('Soqucoin drops out of the job within seconds, Pepecoin stays', dropped,
      pool.currentJob && pool.currentJob.extraAux.map((a) => a.name).join());
    check('the status says why', !!(pool.snapshot().soq && pool.snapshot().soq.unavailableSince));
    check('and it is not a template error — the pool is healthy', !pool.snapshot().templateError, String(pool.snapshot().templateError));
    await sleep(1500);
    const work = m.latest();
    const cur = work && pool.jobs.get(work[0]);
    check('the miner was handed the three-chain work', !!cur && cur.extraAux.map((a) => a.name).join() === 'PEP');
    if (cur) {
      const goal = minOf(cur.networkTarget, cur.auxTarget, cur.extraAux[0].target);
      const sol = await mine(work, en1, goal);
      const [l0, d0, p0] = await Promise.all([ltc.call('getblockcount'), doge.call('getblockcount'), pep.call('getblockcount')]);
      const r = await m.call('mining.submit', ['rig', work[0], sol.extranonce2, work[7], sol.nonce.toString(16).padStart(8, '0')]);
      check('a share is still accepted', r.result === true, JSON.stringify(r.error));
      await pool.drain(60000);
      const [l1, d1, p1] = await Promise.all([ltc.call('getblockcount'), doge.call('getblockcount'), pep.call('getblockcount')]);
      check('and still makes a Litecoin, a Dogecoin and a Pepecoin block',
        l1 === l0 + 1 && d1 === d0 + 1 && p1 === p0 + 1, `${l0}->${l1} ${d0}->${d1} ${p0}->${p1}`);
    }
    m.socket.destroy();
    pool.stop();
  }

  console.log(failures === 0 ? '\nSOQUCOIN POOL VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
