'use strict';
//
// Public merged mining, proven against the two daemons: a Dogecoin block we
// BUILD OURSELVES (not createauxblock) paying a miner 99% and the pool 1%,
// committed into a Litecoin parent that also pays 99/1, merge-mined, and
// accepted by BOTH nodes. Mempools are deliberately non-empty so the merkle
// paths on both chains are exercised, not just the single-coinbase case.
//
// Usage: node test/public_aux_regtest.js <ltcRpcPort> <dogeRpcPort>
//

const crypto = require('node:crypto');
const { RpcClient } = require('../images/stratum/src/rpc');
const u = require('../images/stratum/src/util');
const aux = require('../images/stratum/src/auxpow');
const pm = require('../images/stratum/src/public-merged');
const { withWitness } = require('../images/stratum/src/merged');

const LTC_PORT = Number(process.argv[2] || 19332);
const DOGE_PORT = Number(process.argv[3] || 18332);

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const ltc = new RpcClient({ host: '127.0.0.1', port: LTC_PORT, user: 'test', password: 'test' });
const doge = new RpcClient({ host: '127.0.0.1', port: DOGE_PORT, user: 'test', password: 'test' });

function out(value, script) {
  const v = Buffer.alloc(8);
  v.writeBigUInt64LE(BigInt(value));
  return Buffer.concat([v, u.varIntBuffer(script.length), script]);
}

const js = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v));
function sats(x) { return BigInt(Math.round(x * 1e8)); }

(async () => {
  const minerDoge = await doge.call('getnewaddress');
  const feeDoge = await doge.call('getnewaddress');
  const minerLtc = await ltc.call('getnewaddress', ['', 'legacy']);
  const feeLtc = await ltc.call('getnewaddress', ['', 'legacy']);

  // Something in both mempools, so neither template is coinbase-only.
  await doge.call('sendtoaddress', [await doge.call('getnewaddress'), 12.5]);
  await ltc.call('sendtoaddress', [await ltc.call('getnewaddress', ['', 'legacy']), 0.25]);

  console.log('\nthe Dogecoin block is built by the pool, not by createauxblock');
  const dt = await doge.call('getblocktemplate');
  check('the Dogecoin template has a transaction in it', (dt.transactions || []).length >= 1,
    String((dt.transactions || []).length));
  const auxBlock = pm.buildAuxBlock(
    dt, u.addressToScript(minerDoge, 'regtest'), u.addressToScript(feeDoge, 'regtest'), 1, '/pub-test/'
  );
  check('the version carries chain 98 and the auxpow flag',
    ((auxBlock.header.readUInt32LE(0) >>> 16) === 98) && (auxBlock.header.readUInt32LE(0) & 0x100) !== 0,
    auxBlock.header.readUInt32LE(0).toString(16));
  check('miner + fee add up to the whole coinbase value',
    auxBlock.minerValue + auxBlock.feeValue === BigInt(dt.coinbasevalue));
  check('the fee is 1%', auxBlock.feeValue === BigInt(dt.coinbasevalue) / 100n,
    `${auxBlock.feeValue} of ${dt.coinbasevalue}`);

  console.log('\na Litecoin parent paying 99/1 commits to it');
  const lt = await ltc.call('getblocktemplate', [{ rules: ['mweb', 'segwit'] }]);
  check('the Litecoin template has a transaction in it', (lt.transactions || []).length >= 1,
    String((lt.transactions || []).length));
  const split = pm.splitReward(lt.coinbasevalue, 1);
  const scriptSig = Buffer.concat([
    u.coinbaseHeightScript(lt.height),
    u.scriptPush(crypto.randomBytes(8)),
    aux.auxCommitment(auxBlock.hash, 0),
  ]);
  const outputs = [
    out(split.miner, u.addressToScript(minerLtc, 'ltc-regtest')),
    out(split.fee, u.addressToScript(feeLtc, 'ltc-regtest')),
  ];
  if (lt.default_witness_commitment) {
    const wc = Buffer.from(lt.default_witness_commitment, 'hex');
    outputs.push(Buffer.concat([Buffer.alloc(8), u.varIntBuffer(wc.length), wc]));
  }
  const coinbase = Buffer.concat([
    Buffer.from('01000000', 'hex'), u.varIntBuffer(1), Buffer.alloc(32), Buffer.from('ffffffff', 'hex'),
    u.varIntBuffer(scriptSig.length), scriptSig, Buffer.from('ffffffff', 'hex'),
    u.varIntBuffer(outputs.length), ...outputs, Buffer.alloc(4),
  ]);
  const steps = u.merkleSteps((lt.transactions || []).map((t) => u.reverseBuffer(Buffer.from(t.txid || t.hash, 'hex'))));
  const root = u.merkleRootFromSteps(u.sha256d(coinbase), steps);

  const auxTarget = u.targetFromBits(auxBlock.bits);
  const ltcTarget = u.targetFromBits(lt.bits);
  const goal = auxTarget < ltcTarget ? auxTarget : ltcTarget;
  let header;
  for (let nonce = 0; nonce < 5000000; nonce++) {
    header = Buffer.alloc(80);
    header.writeInt32LE(lt.version, 0);
    u.reverseBuffer(Buffer.from(lt.previousblockhash, 'hex')).copy(header, 4);
    root.copy(header, 36);
    header.writeUInt32LE(lt.curtime, 68);
    header.writeUInt32LE(parseInt(lt.bits, 16), 72);
    header.writeUInt32LE(nonce, 76);
    if (u.bufferToBigInt(u.reverseBuffer(u.scryptHash(header))) <= goal) break;
  }

  const verdict = aux.verifyAuxPow({
    scriptSig, auxHashHex: auxBlock.hash, chainId: 98,
    coinbaseTxid: u.reverseBuffer(u.sha256d(coinbase)).toString('hex'),
    merkleBranch: steps, parentMerkleRoot: u.reverseBuffer(root).toString('hex'), parentVersion: lt.version,
  });
  check('our own auxpow rule check passes', verdict.ok, verdict.problems.join(' | '));

  console.log('\ndogecoind accepts the block via submitblock');
  const auxPow = aux.serializeAuxPow({
    coinbaseTx: coinbase,
    parentBlockHash: u.reverseBuffer(u.sha256d(header)).toString('hex'),
    merkleBranch: steps,
    parentHeader: header,
  });
  const dBefore = await doge.call('getblockcount');
  const dRes = await doge.call('submitblock', [pm.serializeAuxBlock(auxBlock, auxPow)]);
  check('submitblock answers null (accepted)', dRes === null || dRes === undefined, JSON.stringify(dRes));
  const dAfter = await doge.call('getblockcount');
  check('the Dogecoin chain grew by one', dAfter === dBefore + 1, `${dBefore} -> ${dAfter}`);
  const dTip = await doge.call('getblock', [await doge.call('getbestblockhash')]);
  check('the tip is the block we built', dTip.hash === auxBlock.hash, `${dTip.hash} vs ${auxBlock.hash}`);
  check('it is an auxpow block', !!dTip.auxpow);
  check('it contains the mempool transaction too', dTip.tx.length === 1 + dt.transactions.length,
    String(dTip.tx.length));
  const dCb = await doge.call('getrawtransaction', [dTip.tx[0], 1]);
  const dPaid = Object.fromEntries(dCb.vout.map((o) => [(o.scriptPubKey.addresses || [])[0], sats(o.value)]));
  check('the miner got 99%', dPaid[minerDoge] === auxBlock.minerValue, JSON.stringify(dCb.vout.map((o) => o.value)));
  check('the pool got 1%', dPaid[feeDoge] === auxBlock.feeValue, js(dPaid));

  console.log('\nlitecoind accepts the same parent');
  const body = Buffer.concat([
    header,
    u.varIntBuffer(1 + lt.transactions.length),
    lt.default_witness_commitment ? withWitness(coinbase) : coinbase,
    ...lt.transactions.map((t) => Buffer.from(t.data, 'hex')),
    ...(lt.mweb ? [Buffer.from([0x01]), Buffer.from(lt.mweb, 'hex')] : []),
  ]);
  const lBefore = await ltc.call('getblockcount');
  const lRes = await ltc.call('submitblock', [body.toString('hex')]);
  check('submitblock answers null (accepted)', lRes === null || lRes === undefined, JSON.stringify(lRes));
  const lAfter = await ltc.call('getblockcount');
  check('the Litecoin chain grew by one', lAfter === lBefore + 1, `${lBefore} -> ${lAfter}`);
  const lTip = await ltc.call('getblock', [await ltc.call('getbestblockhash'), 2]);
  const lPaid = {};
  for (const o of lTip.tx[0].vout) {
    const a = o.scriptPubKey.address || (o.scriptPubKey.addresses || [])[0];
    if (a) lPaid[a] = sats(o.value);
  }
  check('the miner got 99% on Litecoin', lPaid[minerLtc] === split.miner, js(lPaid));
  check('the pool got 1% on Litecoin', lPaid[feeLtc] === split.fee);

  console.log(failures === 0 ? '\nPUBLIC AUX BLOCK VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
