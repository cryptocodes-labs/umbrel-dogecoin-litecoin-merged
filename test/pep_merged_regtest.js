'use strict';
//
// Two aux chains under one parent, against the three daemons: one Litecoin
// block, built by the pool's own MergedJob, carrying a chain merkle tree with a
// Dogecoin block AND a Pepecoin block — and dogecoind, pepecoind and litecoind
// each accepting their part.
//
// multi_aux_unit.js checks the tree against the rules of src/auxpow.cpp, which
// both aux chains share byte for byte. This checks it against the nodes that
// enforce them, which is the only verdict that counts.
//
// Usage: node test/pep_merged_regtest.js <ltcRpcPort> <dogeRpcPort> <pepRpcPort>
//
const crypto = require('node:crypto');
const { RpcClient } = require('../images/stratum/src/rpc');
const u = require('../images/stratum/src/util');
const { MergedJob, LTC_RULES, DOGE_CHAIN_ID } = require('../images/stratum/src/merged');

const LTC_PORT = Number(process.argv[2] || 19332);
const DOGE_PORT = Number(process.argv[3] || 18332);
const PEP_PORT = Number(process.argv[4] || 24655);
const PEP_CHAIN_ID = 63; // src/chainparams.cpp, Pepecoin 1.1.0, all networks

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const ltc = new RpcClient({ host: '127.0.0.1', port: LTC_PORT, user: 'test', password: 'test' });
const doge = new RpcClient({ host: '127.0.0.1', port: DOGE_PORT, user: 'test', password: 'test' });
const pep = new RpcClient({ host: '127.0.0.1', port: PEP_PORT, user: 'test', password: 'test' });

function buildHeader({ version, prevHash, merkleRoot, time, bits, nonce }) {
  const header = Buffer.alloc(80);
  header.writeInt32LE(version, 0);
  u.reverseBuffer(Buffer.from(prevHash, 'hex')).copy(header, 4);
  merkleRoot.copy(header, 36);
  header.writeUInt32LE(time, 68);
  u.reverseBuffer(Buffer.from(bits, 'hex')).copy(header, 72);
  header.writeUInt32LE(nonce, 76);
  return header;
}

async function paidTo(rpc, blockHash) {
  const block = await rpc.call('getblock', [blockHash]);
  const tx = await rpc.call('getrawtransaction', [block.tx[0], 1]);
  return tx.vout.flatMap((o) => o.scriptPubKey.addresses || []);
}

(async () => {
  console.log('\nthree chains are reachable');
  const [li, di, pi] = await Promise.all([
    ltc.call('getblockchaininfo'), doge.call('getblockchaininfo'), pep.call('getblockchaininfo'),
  ]);
  check('litecoind on regtest', li.chain === 'regtest', li.chain);
  check('dogecoind on regtest, past auxpow height 20', di.chain === 'regtest' && di.blocks >= 20, `${di.chain} ${di.blocks}`);
  check('pepecoind on regtest, past auxpow height 20', pi.chain === 'regtest' && pi.blocks >= 20, `${pi.chain} ${pi.blocks}`);
  check('pepecoind and dogecoind are different chains', pi.bestblockhash !== di.bestblockhash);

  console.log('\nboth aux chains hand out a block');
  const ltcAddress = await ltc.call('getnewaddress', ['', 'legacy']);
  const dogeAddress = await doge.call('getnewaddress');
  const pepAddress = await pep.call('getnewaddress');
  const dogeAux = await doge.call('createauxblock', [dogeAddress]);
  const pepAux = await pep.call('createauxblock', [pepAddress]);
  check('Dogecoin declares chain 98', dogeAux.chainid === DOGE_CHAIN_ID, String(dogeAux.chainid));
  check('Pepecoin declares chain 63', pepAux.chainid === PEP_CHAIN_ID, String(pepAux.chainid));

  console.log('\nthe pool builds one Litecoin job around both');
  const template = await ltc.call('getblocktemplate', [{ rules: LTC_RULES }]);
  const job = new MergedJob('pep', template, u.addressToScript(ltcAddress, 'ltc-regtest'), '/pep-test/', dogeAux, {
    extraAux: [{ name: 'PEP', chainId: PEP_CHAIN_ID, block: pepAux }],
  });
  check('the chain merkle tree has two leaves', job.chainTree.size === 2, String(job.chainTree.size));
  check('DOGE at slot 0, PEP at slot 1',
    job.chainTree.proofs.get(DOGE_CHAIN_ID).index === 0 && job.chainTree.proofs.get(PEP_CHAIN_ID).index === 1);

  const coinbase = Buffer.concat([job.coinb1, crypto.randomBytes(8), job.coinb2]);
  const merkleRoot = u.merkleRootFromSteps(u.sha256d(coinbase), job.merkleSteps);

  console.log('\nhashing the parent header until it meets all three targets');
  const ltcTarget = u.targetFromBits(template.bits);
  const dogeTarget = u.targetFromBits(dogeAux.bits);
  const pepTarget = u.targetFromBits(pepAux.bits);
  const goal = [ltcTarget, dogeTarget, pepTarget].reduce((a, b) => (a < b ? a : b));
  let header = null;
  let powValue = null;
  const started = Date.now();
  for (let nonce = 0; nonce < 5000000; nonce++) {
    header = buildHeader({
      version: template.version, prevHash: template.previousblockhash, merkleRoot,
      time: template.curtime, bits: template.bits, nonce,
    });
    powValue = u.bufferToBigInt(u.reverseBuffer(u.scryptHash(header)));
    if (powValue <= goal || Date.now() - started > 120000) break;
  }
  check('a header meeting every target was found', powValue <= goal);
  check('the job counts it as a PEP candidate', job.extraAuxCandidates(powValue).length === 1);

  const vd = job.verifyAgainstDogecoin(header, coinbase);
  const vp = job.verifyAux(header, coinbase, PEP_CHAIN_ID, pepAux.hash);
  check('our own Dogecoin rule check passes', vd.ok, vd.problems.join(' | '));
  check('our own Pepecoin rule check passes', vp.ok, vp.problems.join(' | '));

  console.log('\ndogecoind accepts its block');
  const dBefore = await doge.call('getblockcount');
  const dOk = await doge.call('submitauxblock', [dogeAux.hash, job.auxPowHex(header, coinbase)]);
  check('submitauxblock returns true', dOk === true, JSON.stringify(dOk));
  check('the Dogecoin chain grew by one', (await doge.call('getblockcount')) === dBefore + 1);
  check('and its reward pays the Dogecoin address', (await paidTo(doge, dogeAux.hash)).includes(dogeAddress));

  console.log('\npepecoind accepts its block from the very same parent');
  const pBefore = await pep.call('getblockcount');
  const pOk = await pep.call('submitauxblock', [pepAux.hash, job.auxPowHex(header, coinbase, PEP_CHAIN_ID)]);
  check('submitauxblock returns true', pOk === true, JSON.stringify(pOk));
  check('the Pepecoin chain grew by one', (await pep.call('getblockcount')) === pBefore + 1);
  const pepTip = await pep.call('getblock', [pepAux.hash]);
  check('the new tip is our block, recorded with an auxpow', pepTip.confirmations === 1 && !!pepTip.auxpow);
  check('and its reward pays the Pepecoin address', (await paidTo(pep, pepAux.hash)).includes(pepAddress));

  console.log('\nlitecoind accepts the parent itself');
  const lBefore = await ltc.call('getblockcount');
  const lRes = await ltc.call('submitblock', [job.serializeBlock(header, coinbase)]);
  check('submitblock answers null (accepted)', lRes === null || lRes === undefined, JSON.stringify(lRes));
  check('the Litecoin chain grew by one', (await ltc.call('getblockcount')) === lBefore + 1);

  console.log('\na proof for the wrong tree is refused');
  // A fresh Pepecoin block is not in the tree this parent commits to, so the
  // same proof must not carry it — the node is the judge, not our self-check.
  const pepAux2 = await pep.call('createauxblock', [pepAddress]);
  let refused;
  try {
    refused = (await pep.call('submitauxblock', [pepAux2.hash, job.auxPowHex(header, coinbase, PEP_CHAIN_ID)])) !== true;
  } catch {
    refused = true;
  }
  check('pepecoind refuses it', refused);

  console.log(failures === 0 ? '\nDOGE + PEP MERGED MINING VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
