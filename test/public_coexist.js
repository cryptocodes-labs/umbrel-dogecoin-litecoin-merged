'use strict';
//
// The private pool and the public pool side by side on the SAME two nodes,
// which is how they run on the Umbrel: the existing app keeps its locked
// home/rented ports, a second container serves the public port. A block found
// through the public pool must move the private pool onto the new tips too,
// and neither may starve the other of node RPC threads.
//
// Usage: node test/public_coexist.js <ltcRpcPort> <dogeRpcPort> <stratumPortBase>
//
const { Pool } = require('../images/stratum/src/pool');
const { RpcClient } = require('../images/stratum/src/rpc');

const LTC_PORT = Number(process.argv[2] || 19332);
const DOGE_PORT = Number(process.argv[3] || 18332);
const BASE = Number(process.argv[4] || 23900);
let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const ltc = new RpcClient({ host: '127.0.0.1', port: LTC_PORT, user: 'test', password: 'test' });
const doge = new RpcClient({ host: '127.0.0.1', port: DOGE_PORT, user: 'test', password: 'test' });
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

const base = (extra) => ({
  rpc: { host: '127.0.0.1', port: DOGE_PORT, user: 'test', password: 'test' },
  ltcRpc: { host: '127.0.0.1', port: LTC_PORT, user: 'test', password: 'test' },
  mergedMining: true, startDifficulty: 1, minDifficulty: 1, maxDifficulty: 1e6, maxPayoutVariants: 16,
  targetShareSeconds: 10, vardiffWindow: 8, hashrateWindowMs: 300000, pollIntervalMs: 2000,
  jobRebuildMs: 30000, socketTimeoutMs: 600000, coinbaseTag: '/coexist/', auxLongpoll: true, ...extra,
});

(async () => {
  const dAddr = await doge.call('getnewaddress');
  const lAddr = await ltc.call('getnewaddress', ['', 'legacy']);
  const priv = new Pool(base({ payoutAddress: dAddr, ltcPayoutAddress: lAddr, lockPayoutAddress: true, stratumPort: BASE }));
  const pub = new Pool(base({ payoutAddress: dAddr, ltcPayoutAddress: lAddr, publicMerged: true, poolFeePercent: 1, stratumPort: BASE + 1 }));
  await priv.start();
  await pub.start();
  check('both pools started', !!priv.currentJob && !!pub.currentJob);
  check('the private pool is still locked and uses createauxblock', priv.config.lockPayoutAddress === true && !priv.currentJob.dogeTemplate);
  check('the public pool builds its own Dogecoin block', !!pub.currentJob.dogeTemplate);
  check('they mine on the same Litecoin tip', priv.currentJob.template.previousblockhash === pub.currentJob.template.previousblockhash);

  const ltcTip = priv.currentJob.template.previousblockhash;
  const dogeTip = pub.currentJob.dogeTemplate.previousblockhash;
  await ltc.call('generatetoaddress', [1, lAddr]);
  await doge.call('generatetoaddress', [1, dAddr]);
  check('the private pool follows both new tips', await waitFor(() =>
    priv.currentJob.template.previousblockhash !== ltcTip, 15000));
  check('the public pool follows both new tips', await waitFor(() =>
    pub.currentJob.template.previousblockhash !== ltcTip && pub.currentJob.dogeTemplate.previousblockhash !== dogeTip, 15000));

  // Thirty seconds of both running: nodes must keep answering promptly.
  const t0 = Date.now();
  let slowest = 0;
  while (Date.now() - t0 < 30000) {
    const s = Date.now();
    await Promise.all([ltc.call('getblockcount'), doge.call('getblockcount')]);
    slowest = Math.max(slowest, Date.now() - s);
    await new Promise((r) => setTimeout(r, 1000));
  }
  check('both nodes stay responsive with two pools attached', slowest < 2000, `${slowest}ms`);
  check('neither pool reports a template error', !priv.stats.templateError && !pub.stats.templateError,
    `${priv.stats.templateError} / ${pub.stats.templateError}`);
  priv.stop(); pub.stop();
  console.log(failures === 0 ? '\nCOEXISTENCE VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
