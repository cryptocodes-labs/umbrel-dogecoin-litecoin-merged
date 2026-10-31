'use strict';
//
// Soqucoin as a third aux chain, without a daemon:
//
//   1. Addresses. Only a Bech32m witness-v1 address with a 32-byte program
//      (sq1p…, ssq1p… on stagenet) becomes a payout script. Everything else is
//      refused — in particular a Base58 address, which soqucoind's own
//      createauxblock would accept and mine to an output nobody can spend.
//   2. The chain merkle tree with DOGE (98), PEP (63) and SOQ (21329): four
//      leaves at nonce 0, every chain's proof passing the auxpow.cpp rules,
//      which Soqucoin 2.6.1 shares with Dogecoin 1.14.9.
//   3. The pool: SOQ only in private merged mode, and nothing about the other
//      chains changes when it is configured but absent.
//
// The daemon-backed proof (soqucoind accepts the block) is
// test/soq_pool_regtest.js.
//
const crypto = require('node:crypto');
const u = require('../images/stratum/src/util');
const aux = require('../images/stratum/src/auxpow');
const { MergedJob, DOGE_CHAIN_ID, PEP_CHAIN_ID, SOQ_CHAIN_ID } = require('../images/stratum/src/merged');
const { Pool } = require('../images/stratum/src/pool');

let failures = 0;
let checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const throwsWith = (fn, re) => {
  try { fn(); return false; } catch (err) { return re.test(err.message); }
};
const hex32 = () => crypto.randomBytes(32).toString('hex');

// A valid Base58Check address for a version byte (as test/multi_aux_unit.js).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58addr(version) {
  const body = Buffer.concat([Buffer.from([version]), crypto.randomBytes(20)]);
  const buf = Buffer.concat([body, u.sha256d(body).subarray(0, 4)]);
  let n = BigInt('0x' + buf.toString('hex'));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  return s;
}
const DOGE_ADDR = b58addr(0x1e);
const LTC_ADDR = b58addr(0x30);

// An encoder written apart from util.js (BIP173/BIP350 reference algorithm),
// so the decoder is checked against something other than itself.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
function encode(hrp, version, program, constant = 0x2bc830a3) {
  const data = [version];
  let acc = 0; let bits = 0;
  for (const byte of program) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; data.push((acc >> bits) & 31); }
  }
  if (bits) data.push((acc << (5 - bits)) & 31);
  const exp = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod(exp.concat(data, [0, 0, 0, 0, 0, 0])) ^ constant;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${data.concat(checksum).map((d) => CHARSET[d]).join('')}`;
}

console.log('\nSoqucoin addresses');
{
  // A real mainnet payout: the coinbase of block 28,722 on explorer.soqu.org
  // (read 31-10-2026), address and scriptPubKey hex exactly as the node reports.
  const real = 'sq1pu43lfdnte6tmfwzhvy8y8j8ga0xghd9j9hhaazczrl2ellfynqtsv270c8';
  const realScript = '5120e563f4b66bce97b4b857610e43c8e8ebcc8bb4b22defde8b021fd59ffd249817';
  check('a real mainnet address gives the script soqucoind put on chain',
    u.addressToScript(real, 'soq-main').toString('hex') === realScript);
  check('the address is 62 characters', real.length === 62, String(real.length));
  check('regtest and testnet share the sq prefix',
    u.addressToScript(real, 'soq-regtest').toString('hex') === realScript &&
    u.addressToScript(real, 'soq-test').toString('hex') === realScript);
  check('upper case is the same address', u.addressToScript(real.toUpperCase(), 'soq-main').toString('hex') === realScript);
  check('our own encoder reproduces the real address',
    encode('sq', 1, Buffer.from(realScript.slice(4), 'hex')) === real);

  const prog = crypto.randomBytes(32);
  const stage = encode('ssq', 1, prog);
  check('stagenet ssq1p… decodes on stagenet', u.addressToScript(stage, 'soq-stagenet').equals(Buffer.concat([Buffer.from('5120', 'hex'), prog])));
  check('and is refused on mainnet', throwsWith(() => u.addressToScript(stage, 'soq-main'), /prefix ssq is not sq/));
  check('a mainnet address is refused on stagenet', throwsWith(() => u.addressToScript(real, 'soq-stagenet'), /prefix sq is not ssq/));

  const typo = real.slice(0, 20) + (real[20] === 'q' ? 'p' : 'q') + real.slice(21);
  check('one mistyped character is refused', throwsWith(() => u.addressToScript(typo, 'soq-main'), /checksum/));
  const mixed = real.slice(0, 10) + real.slice(10, 12).toUpperCase() + real.slice(12);
  check('mixed case is refused', throwsWith(() => u.addressToScript(mixed, 'soq-main'), /mixes upper and lower/));
  check('a bech32 (not bech32m) checksum is refused', throwsWith(() => u.addressToScript(encode('sq', 1, prog, 1), 'soq-main'), /checksum/));
  check('witness version 0 is refused', throwsWith(() => u.addressToScript(encode('sq', 0, prog), 'soq-main'), /witness version 0/));
  check('witness version 2 is refused', throwsWith(() => u.addressToScript(encode('sq', 2, prog), 'soq-main'), /witness version 2/));
  check('a 20-byte program is refused', throwsWith(() => u.addressToScript(encode('sq', 1, prog.subarray(0, 20)), 'soq-main'), /20 bytes/));
  check('a Dogecoin Base58 address is refused (createauxblock would take it)',
    throwsWith(() => u.addressToScript(DOGE_ADDR, 'soq-main'), /bech32m/));
  check('an LTC bech32 address is refused', throwsWith(() => u.addressToScript('ltc1qg82tn4v0yj6dr0mqpwyrjt9vxpnfyuwkwx5ae3', 'soq-main'), /prefix ltc is not sq/));
  check('an empty value is refused', throwsWith(() => u.addressToScript('', 'soq-main'), /bech32m/));

  // The other chains are untouched by the new branch.
  check('a Dogecoin address still decodes on Dogecoin', u.addressToScript(DOGE_ADDR, 'main').length === 25);
  check('a Soqucoin address is still refused on Dogecoin', throwsWith(() => u.addressToScript(real, 'main'), /./));
  check('and on Litecoin', throwsWith(() => u.addressToScript(real, 'ltc-main'), /./));
}

console.log('\nDOGE + PEP + SOQ: a four-leaf tree');
const dogeHash = hex32();
const pepHash = hex32();
const soqHash = hex32();
const chains3 = [
  { chainId: DOGE_CHAIN_ID, hash: dogeHash },
  { chainId: PEP_CHAIN_ID, hash: pepHash },
  { chainId: SOQ_CHAIN_ID, hash: soqHash },
];
const tree3 = aux.buildChainTree(chains3);
{
  check('Soqucoin chain id is 0x5351', SOQ_CHAIN_ID === 0x5351);
  check('size 4, nonce 0', tree3.size === 4 && tree3.nonce === 0, `${tree3.size}/${tree3.nonce}`);
  const idx = (id) => tree3.proofs.get(id).index;
  check('slots DOGE 0, PEP 1, SOQ 3 — getExpectedIndex(0, id, 2)',
    idx(98) === 0 && idx(63) === 1 && idx(21329) === 3 &&
    aux.expectedIndex(0, 98, 2) === 0 && aux.expectedIndex(0, 63, 2) === 1 && aux.expectedIndex(0, 21329, 2) === 3);
  const commitment = aux.auxCommitment(tree3.root, tree3.nonce, tree3.size);
  check('the commitment is still 44 bytes', commitment.length === 44);
  const scriptSig = Buffer.concat([u.coinbaseHeightScript(1000), crypto.randomBytes(8), Buffer.from('/t/'), commitment]);
  for (const c of chains3) {
    const pr = tree3.proofs.get(c.chainId);
    const r = aux.verifyAuxPow({ scriptSig, auxHashHex: c.hash, chainId: c.chainId, chainBranch: pr.branch, chainIndex: pr.index });
    check(`chain ${c.chainId}'s proof passes the auxpow.cpp rules`, r.ok, r.problems.join(' | '));
  }
  const soqAtPep = aux.verifyAuxPow({
    scriptSig, auxHashHex: soqHash, chainId: SOQ_CHAIN_ID,
    chainBranch: tree3.proofs.get(PEP_CHAIN_ID).branch, chainIndex: 1,
  });
  check("SOQ at PEP's slot is refused", !soqAtPep.ok);

  const t2 = aux.buildChainTree([chains3[0], chains3[2]]);
  check('DOGE + SOQ (Pepecoin away): two leaves, SOQ at slot 1',
    t2.size === 2 && t2.nonce === 0 && t2.proofs.get(SOQ_CHAIN_ID).index === 1);
}

console.log('\nMergedJob with PEP and SOQ');
const template = {
  version: 0x20000000,
  previousblockhash: 'ab'.repeat(32),
  curtime: 1786000000,
  mintime: 1785999000,
  bits: '207fffff',
  height: 2400000,
  coinbasevalue: 625000000,
  target: '7fffff' + '00'.repeat(29),
  transactions: [],
};
const payout = u.addressToScript('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'ltc-regtest');
const dogeAux = { hash: dogeHash, bits: '207fffff', height: 100, coinbasevalue: 50000000000, chainid: 98 };
const pepAux = { hash: pepHash, bits: '207fffff', height: 200, coinbasevalue: 1000000000000, chainid: 63 };
// A real Soqucoin target is far easier than Litecoin's and far harder than
// regtest's; 1a096559 is mainnet block 28,722.
const soqAux = { hash: soqHash, bits: '1a096559', height: 28723, coinbasevalue: 10000000000000, chainid: 21329 };
{
  const job = new MergedJob('1', template, payout, '/t/', dogeAux, {
    extraAux: [
      { name: 'PEP', chainId: PEP_CHAIN_ID, block: pepAux },
      { name: 'SOQ', chainId: SOQ_CHAIN_ID, block: soqAux },
    ],
  });
  const plain = new MergedJob('2', template, payout, '/t/', dogeAux);
  check('coinb1 is unchanged — the commitment keeps its length', job.coinb1.equals(plain.coinb1));
  check('coinb2 is the same length as single-chain', job.coinb2.length === plain.coinb2.length);
  check('coinb2 carries the three-chain root', job.coinb2.indexOf(aux.auxCommitment(tree3.root, 0, 4)) >= 0);
  check('the Litecoin outputs are untouched (one payout, value unchanged)',
    job.coinb2.subarray(job.coinb2.length - plain.coinb2.length + 44).equals(plain.coinb2.subarray(44)));

  const coinbase = Buffer.concat([job.coinb1, crypto.randomBytes(8), job.coinb2]);
  const merkleRoot = u.merkleRootFromSteps(u.sha256d(coinbase), job.merkleSteps);
  const header = Buffer.alloc(80);
  header.writeUInt32LE(template.version, 0);
  merkleRoot.copy(header, 36);
  check("Dogecoin's rule check passes", job.verifyAgainstDogecoin(header, coinbase).ok);
  check("Pepecoin's rule check passes", job.verifyAux(header, coinbase, PEP_CHAIN_ID, pepHash).ok);
  const vs = job.verifyAux(header, coinbase, SOQ_CHAIN_ID, soqHash);
  check("Soqucoin's rule check passes", vs.ok, vs.problems.join(' | '));
  const sHex = job.auxPowHex(header, coinbase, SOQ_CHAIN_ID);
  const dHex = job.auxPowHex(header, coinbase);
  check('the SOQ proof has a two-step chain branch at index 3',
    sHex.length === dHex.length && sHex.slice(-160 - 8, -160) === '03000000');
  const soqTarget = u.targetFromBits('1a096559');
  check('a share that only meets the (regtest-easy) PEP target is no SOQ candidate',
    job.extraAuxCandidates(u.targetFromBits('207fffff')).map((a) => a.name).join() === 'PEP');
  check('a share meeting the SOQ target is a SOQ candidate', job.extraAuxCandidates(soqTarget).some((a) => a.name === 'SOQ'));
  check("the parent's version never claims Soqucoin's id", ((template.version >>> 16) & 0xffff) !== SOQ_CHAIN_ID);
}

console.log('\nthe pool: SOQ in private merged mode only');
{
  const soqConf = { rpc: { host: '127.0.0.1', port: 1, user: 'u', password: 'p' }, payoutAddress: 'sq1pu43lfdnte6tmfwzhvy8y8j8ga0xghd9j9hhaazczrl2ellfynqtsv270c8' };
  const base = {
    rpc: { host: '127.0.0.1', port: 1, user: 'u', password: 'p' },
    ltcRpc: { host: '127.0.0.1', port: 1, user: 'u', password: 'p' },
    mergedMining: true,
    payoutAddress: DOGE_ADDR,
    ltcPayoutAddress: LTC_ADDR,
    stratumPort: 0,
  };
  const priv = new Pool({ ...base, soq: soqConf });
  check('private merged: Soqucoin is on', priv.soq && priv.soq.name === 'SOQ' && !priv.soqIgnored);
  const pub = new Pool({ ...base, publicMerged: true, soq: soqConf });
  check('public merged: Soqucoin is off, and says why', pub.soq === null && /private port only/.test(pub.soqIgnored || ''));
  const none = new Pool({ ...base });
  check('not configured: off, nothing to say', none.soq === null && none.soqIgnored === null);
  const dogeOnly = new Pool({ ...base, mergedMining: false, soq: soqConf });
  check('Dogecoin-only mode: off', dogeOnly.soq === null);
  const snap = none.snapshot();
  check('the snapshot reports soq null when it is not configured', snap.soq === null && snap.soqIgnored === null);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
