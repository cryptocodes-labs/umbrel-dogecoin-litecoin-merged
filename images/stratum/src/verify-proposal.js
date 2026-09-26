'use strict';
//
// Independent check of the PUBLIC merged coinbases against the live nodes,
// without mining: both blocks a public miner would be working on are built
// with this pool's own code and handed to dogecoind and litecoind as
// getblocktemplate PROPOSALS (BIP23). A proposal runs the node's full block
// validation — coinbase amount, fees, BIP34 height, transactions, segwit and
// MWEB commitments — and skips only the proof of work. "null" from a node means
// it would accept that block if the work were there.
//
// Run inside the public container, which already has the node credentials:
//   docker exec doge-public node /app/verify-proposal.js <LTC address> <DOGE address>
//
// The Dogecoin block is proposed WITHOUT the auxpow flag: with the flag set the
// node expects an auxpow after the header, and the proof is the one part that
// cannot exist without mining. The auxpow itself is covered by
// test/public_aux_regtest.js against a real dogecoind.
//

const { RpcClient } = require('./rpc');
const u = require('./util');
const pm = require('./public-merged');
const { MergedJob, LTC_RULES } = require('./merged');
const { EXTRANONCE1_SIZE, EXTRANONCE2_SIZE } = require('./job');

const env = process.env;
const doge = new RpcClient({ host: env.RPC_HOST, port: Number(env.RPC_PORT || 22555), user: env.RPC_USER || 'umbrel', password: env.RPC_PASSWORD || '' });
const ltc = new RpcClient({ host: env.LTC_RPC_HOST, port: Number(env.LTC_RPC_PORT || 9332), user: env.LTC_RPC_USER || 'umbrel', password: env.LTC_RPC_PASSWORD || '' });
const pct = Number(env.POOL_FEE_PERCENT || 1);
const tag = env.COINBASE_TAG || '/umbrel-doge-solo/';

const fmt = (v) => (Number(v) / 1e8).toFixed(8);

(async () => {
  const [minerLtc, minerDoge] = process.argv.slice(2);
  if (!minerLtc || !minerDoge) throw new Error('usage: node verify-proposal.js <LTC address> <DOGE address>');
  const dInfo = await doge.call('getblockchaininfo');
  const lInfo = await ltc.call('getblockchaininfo');
  const dChain = dInfo.chain === 'main' ? 'main' : dInfo.chain === 'test' ? 'test' : 'regtest';
  const lChain = lInfo.chain === 'main' ? 'ltc-main' : lInfo.chain === 'test' ? 'ltc-test' : 'ltc-regtest';
  const feeDoge = u.addressToScript(env.PAYOUT_ADDRESS, dChain);
  const feeLtc = u.addressToScript(env.LTC_PAYOUT_ADDRESS, lChain);
  let ok = true;

  // --- Dogecoin -----------------------------------------------------------
  const dt = await doge.call('getblocktemplate');
  const auxBlock = pm.buildAuxBlock(dt, u.addressToScript(minerDoge, dChain), feeDoge, pct, tag);
  const header = Buffer.from(auxBlock.header);
  header.writeUInt32LE(header.readUInt32LE(0) & ~pm.VERSION_AUXPOW, 0);
  const dHex = Buffer.concat([
    header, u.varIntBuffer(auxBlock.transactions.length + 1), auxBlock.coinbase,
    ...auxBlock.transactions.map((t) => Buffer.from(t, 'hex')),
  ]).toString('hex');
  const dVerdict = await doge.call('getblocktemplate', [{ mode: 'proposal', data: dHex }]);
  console.log(`DOGE ${dInfo.chain} height ${dt.height}, ${dt.transactions.length} txs, reward ${fmt(dt.coinbasevalue)}`);
  console.log(`  miner ${minerDoge}: ${fmt(auxBlock.minerValue)}   fee ${env.PAYOUT_ADDRESS}: ${fmt(auxBlock.feeValue)} (${pct}%)`);
  console.log(`  node verdict: ${dVerdict === null ? 'VALID (null)' : JSON.stringify(dVerdict)}`);
  if (dVerdict !== null) ok = false;

  // --- Litecoin -----------------------------------------------------------
  const lt = await ltc.call('getblocktemplate', [{ rules: LTC_RULES }]);
  const job = new MergedJob('01', lt, u.addressToScript(minerLtc, lChain), tag, auxBlock, { fee: { script: feeLtc, percent: pct } });
  const coinbase = job.buildCoinbase(Buffer.alloc(EXTRANONCE1_SIZE, 1), Buffer.alloc(EXTRANONCE2_SIZE, 2));
  const root = u.merkleRootFromSteps(u.sha256d(coinbase), job.merkleSteps);
  const lHeader = job.buildHeader(root, lt.curtime, 0);
  const lHex = job.serializeBlock(lHeader, coinbase);
  const lVerdict = await ltc.call('getblocktemplate', [{ mode: 'proposal', data: lHex, rules: LTC_RULES }]);
  console.log(`LTC ${lInfo.chain} height ${lt.height}, ${lt.transactions.length} txs, reward ${fmt(lt.coinbasevalue)}`);
  console.log(`  miner ${minerLtc}: ${fmt(job.minerValue)}   fee ${env.LTC_PAYOUT_ADDRESS}: ${fmt(job.feeValue)} (${pct}%)`);
  console.log(`  aux commitment in coinbase: ${coinbase.includes(Buffer.from('fabe6d6d', 'hex')) ? 'yes' : 'NO'}`);
  console.log(`  node verdict: ${lVerdict === null ? 'VALID (null)' : JSON.stringify(lVerdict)}`);
  if (lVerdict !== null) ok = false;

  console.log(ok ? '\nBOTH NODES ACCEPT THE PUBLIC COINBASES' : '\nA NODE REFUSED — do not open the port');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.message); process.exit(1); });
