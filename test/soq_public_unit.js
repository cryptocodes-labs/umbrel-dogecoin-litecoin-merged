'use strict';
//
// Public Soqucoin without a daemon: the block the pool builds for one miner
// from soqucoind's getblocktemplate coinbase, and the sq1p part of a public
// username. The daemon-backed proof — soqucoind accepting such a block with
// attested spends in it, PAT commitment and all — is part 3 of
// test/soq_pool_regtest.js.
//
// Usage: node test/soq_public_unit.js
//
const crypto = require('node:crypto');
const u = require('../images/stratum/src/util');
const pm = require('../images/stratum/src/public-merged');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

// ------------------------------------------------------------ helpers
// Written apart from public-merged.js, so its serializer is not checked
// against itself.
const varint = (n) => (n < 0xfd ? Buffer.from([n]) : Buffer.from([0xfd, n & 0xff, n >> 8]));
const out = (value, script) => {
  const v = Buffer.alloc(8);
  v.writeBigUInt64LE(BigInt(value));
  return Buffer.concat([v, varint(script.length), script]);
};
function coinbaseHex({ height = 1234, outputs, witness = true }) {
  const scriptSig = Buffer.concat([u.coinbaseHeightScript(height), Buffer.from([0x00])]);
  return Buffer.concat([
    Buffer.from('01000000', 'hex'),
    witness ? Buffer.from('0001', 'hex') : Buffer.alloc(0),
    varint(1), Buffer.alloc(32), Buffer.from('ffffffff', 'hex'),
    varint(scriptSig.length), scriptSig, Buffer.from('ffffffff', 'hex'),
    varint(outputs.length), ...outputs.map((o) => out(o.value, o.script)),
    // The coinbase witness: one 32-byte nonce.
    witness ? Buffer.concat([varint(1), varint(32), Buffer.alloc(32)]) : Buffer.alloc(0),
    Buffer.from('00000000', 'hex'),
  ]).toString('hex');
}
const PLACEHOLDER = Buffer.concat([Buffer.from('5120', 'hex'), Buffer.alloc(32)]);
const witnessCommitment = Buffer.concat([Buffer.from('6a24aa21a9ed', 'hex'), crypto.randomBytes(32)]);
const patCommitment = Buffer.concat([Buffer.from('6a225041', 'hex'), crypto.randomBytes(32)]);
const program = () => crypto.randomBytes(32);
const v1 = (p) => Buffer.concat([Buffer.from('5120', 'hex'), p]);

const VALUE = 10000012345678; // 100,000 SOQ subsidy plus fees
const txs = [0, 1, 2].map(() => {
  const data = crypto.randomBytes(120).toString('hex');
  return { data, txid: crypto.randomBytes(32).toString('hex'), hash: crypto.randomBytes(32).toString('hex') };
});
function template(extra = {}) {
  return {
    version: 0x53518004,
    previousblockhash: crypto.randomBytes(32).toString('hex'),
    curtime: 1793000000,
    bits: '1d00ffff',
    height: 1234,
    coinbasevalue: VALUE,
    default_witness_commitment: witnessCommitment.toString('hex'),
    coinbasetxn: {
      data: coinbaseHex({ outputs: [
        { value: VALUE, script: PLACEHOLDER },
        { value: 0, script: witnessCommitment },
        { value: 0, script: patCommitment },
      ] }),
    },
    transactions: txs,
    ...extra,
  };
}

// ------------------------------------------------------- the block
console.log('\nthe block one public miner works on');
const minerProg = program();
const feeProg = program();
const t = template();
const b = pm.buildSoqAuxBlock(t, v1(minerProg), v1(feeProg), 1);
const cb = pm.parseTx(b.coinbase);
check('the auxpow flag is added to the template version, nothing else changes', b.header.readUInt32LE(0) === 0x53518104,
  b.header.readUInt32LE(0).toString(16));
check('it describes chain 21329', b.chainid === 21329);
check('the coinbase keeps its witness (the 32-byte nonce)', cb.segwit && cb.witnesses.length === 1 &&
  cb.witnesses[0].length === 1 && cb.witnesses[0][0].equals(Buffer.alloc(32)));
check('the placeholder became two outputs: the miner first, then the fee',
  cb.outputs.length === 4 && cb.outputs[0].script.equals(v1(minerProg)) && cb.outputs[1].script.equals(v1(feeProg)));
check('99% to the miner, 1% (rounded down) to the pool, exactly the template value',
  cb.outputs[0].value === BigInt(VALUE) - BigInt(VALUE) / 100n && cb.outputs[1].value === BigInt(VALUE) / 100n);
check('the witness commitment is kept, byte for byte, value 0',
  cb.outputs[2].script.equals(witnessCommitment) && cb.outputs[2].value === 0n);
check('the PAT commitment is kept, byte for byte, value 0',
  cb.outputs[3].script.equals(patCommitment) && cb.outputs[3].value === 0n);
check('and reported as the block\'s commitment', b.patCommitment === patCommitment.toString('hex'));
const orig = pm.parseTx(Buffer.from(t.coinbasetxn.data, 'hex'));
check('the scriptSig, sequence and locktime are soqucoind\'s',
  cb.inputs[0].script.equals(orig.inputs[0].script) && cb.inputs[0].sequence.equals(orig.inputs[0].sequence) &&
  cb.locktime.equals(orig.locktime));

// The merkle root, recomputed here from the txid of the coinbase WITHOUT its
// witness and the template's txids (never its wtxids).
const noWitness = Buffer.from(coinbaseHex({ witness: false, outputs: [
  { value: BigInt(VALUE) - BigInt(VALUE) / 100n, script: v1(minerProg) },
  { value: BigInt(VALUE) / 100n, script: v1(feeProg) },
  { value: 0, script: witnessCommitment },
  { value: 0, script: patCommitment },
] }), 'hex');
let level = [u.sha256d(noWitness), ...txs.map((x) => u.reverseBuffer(Buffer.from(x.txid, 'hex')))];
while (level.length > 1) {
  if (level.length % 2) level.push(level[level.length - 1]);
  const next = [];
  for (let i = 0; i < level.length; i += 2) next.push(u.sha256d(Buffer.concat([level[i], level[i + 1]])));
  level = next;
}
check('the merkle root is over the coinbase txid without witness and the template txids',
  b.header.subarray(36, 68).equals(level[0]));
check('prev hash, time and bits are the template\'s',
  u.reverseBuffer(b.header.subarray(4, 36)).toString('hex') === t.previousblockhash &&
  b.header.readUInt32LE(68) === t.curtime && b.header.readUInt32LE(72) === 0x1d00ffff);
check('the hash is the header\'s', b.hash === u.reverseBuffer(u.sha256d(b.header)).toString('hex'));
check('the transactions go out as soqucoind gave them (with their witnesses)',
  b.transactions.length === 3 && b.transactions.every((d, i) => d === txs[i].data));
const blockHex = pm.serializeAuxBlock(b, Buffer.from('aa', 'hex'));
check('the submitted block is header, auxpow, count, coinbase with witness, transactions',
  blockHex === Buffer.concat([b.header, Buffer.from('aa', 'hex'), Buffer.from([4]), b.coinbase,
    ...txs.map((x) => Buffer.from(x.data, 'hex'))]).toString('hex'));

console.log('\nwhat the template may vary');
{
  const noPat = template({
    coinbasetxn: { data: coinbaseHex({ outputs: [
      { value: VALUE, script: PLACEHOLDER }, { value: 0, script: witnessCommitment },
    ] }) },
  });
  const nb = pm.buildSoqAuxBlock(noPat, v1(minerProg), v1(feeProg), 1);
  check('no attested spends, no PAT output: the block carries none either',
    nb.patCommitment === null && !pm.parseTx(nb.coinbase).outputs.some((o) => o.script.subarray(0, 4).toString('hex') === '6a225041'));
  const middle = template({
    coinbasetxn: { data: coinbaseHex({ outputs: [
      { value: 0, script: witnessCommitment }, { value: VALUE, script: PLACEHOLDER }, { value: 0, script: patCommitment },
    ] }) },
  });
  const mb = pm.parseTx(pm.buildSoqAuxBlock(middle, v1(minerProg), v1(feeProg), 1).coinbase);
  check('a placeholder in another position is replaced in that position',
    mb.outputs[0].script.equals(witnessCommitment) && mb.outputs[1].script.equals(v1(minerProg)) &&
    mb.outputs[2].script.equals(v1(feeProg)) && mb.outputs[3].script.equals(patCommitment));
  const zero = pm.parseTx(pm.buildSoqAuxBlock(t, v1(minerProg), v1(feeProg), 0).coinbase);
  check('a 0% fee adds no fee output', zero.outputs.length === 3 && zero.outputs[0].value === BigInt(VALUE));
  const empty = template({ transactions: [] });
  check('a template without transactions builds', !!pm.buildSoqAuxBlock(empty, v1(minerProg), v1(feeProg), 1).hash);
}

console.log('\nwhat is refused (Soqucoin is then left out, never mined wrongly)');
const build = (tt) => () => pm.buildSoqAuxBlock(tt, v1(minerProg), v1(feeProg), 1);
check('a template without coinbasetxn', throwsWith(build(template({ coinbasetxn: undefined })), /no coinbasetxn/));
check('a template of another chain (Dogecoin\'s id)', throwsWith(build(template({ version: 0x00620004 })), /chain id 21329/));
check('no placeholder output', throwsWith(build(template({ coinbasetxn: { data: coinbaseHex({ outputs: [
  { value: VALUE, script: v1(program()) }, { value: 0, script: witnessCommitment }] }) } })), /0 placeholder/));
check('two placeholder outputs', throwsWith(build(template({ coinbasetxn: { data: coinbaseHex({ outputs: [
  { value: VALUE - 1, script: PLACEHOLDER }, { value: 1, script: PLACEHOLDER }, { value: 0, script: witnessCommitment }] }) } })),
/2 placeholder/));
check('a placeholder that is not the whole coinbase value', throwsWith(build(template({ coinbasevalue: VALUE + 1 })), /placeholder pays/));
check('another output carrying value', throwsWith(build(template({ coinbasetxn: { data: coinbaseHex({ outputs: [
  { value: VALUE, script: PLACEHOLDER }, { value: 5, script: v1(program()) }, { value: 0, script: witnessCommitment }] }) } })),
/besides the placeholder/));
check('two PAT commitments', throwsWith(build(template({ coinbasetxn: { data: coinbaseHex({ outputs: [
  { value: VALUE, script: PLACEHOLDER }, { value: 0, script: witnessCommitment }, { value: 0, script: patCommitment },
  { value: 0, script: patCommitment }] }) } })), /more than one PAT/));
check('a coinbase without the announced witness commitment', throwsWith(build(template({
  default_witness_commitment: Buffer.concat([Buffer.from('6a24aa21a9ed', 'hex'), crypto.randomBytes(32)]).toString('hex'),
})), /witness commitment/));
check('a transaction without txid', throwsWith(build(template({ transactions: [{ data: '00', hash: 'ab'.repeat(32) }] })), /no txid/));
check('a coinbasetxn that is not hex', throwsWith(build(template({ coinbasetxn: { data: 'zz' } })), /no coinbasetxn/));
check('a truncated coinbasetxn', throwsWith(build(template({ coinbasetxn: { data: t.coinbasetxn.data.slice(0, -10) } })), /truncated|after its end/));
check('a coinbasetxn with trailing bytes', throwsWith(build(template({ coinbasetxn: { data: `${t.coinbasetxn.data}00` } })), /after its end/));
{
  const notCb = pm.parseTx(Buffer.from(t.coinbasetxn.data, 'hex'));
  notCb.inputs[0].prevout = crypto.randomBytes(36);
  check('a "coinbase" that spends something', throwsWith(build(template({
    coinbasetxn: { data: pm.serializeTx(notCb, true).toString('hex') },
  })), /not a coinbase/));
}

console.log('\nparseTx / serializeTx');
check('a witness coinbase round-trips', pm.serializeTx(pm.parseTx(Buffer.from(t.coinbasetxn.data, 'hex')), true)
  .toString('hex') === t.coinbasetxn.data);
const legacy = coinbaseHex({ witness: false, outputs: [{ value: 5, script: PLACEHOLDER }] });
check('a legacy one too', pm.serializeTx(pm.parseTx(Buffer.from(legacy, 'hex')), true).toString('hex') === legacy);
check('without the witness, a witness coinbase is its legacy form',
  pm.serializeTx(pm.parseTx(Buffer.from(coinbaseHex({ outputs: [{ value: 5, script: PLACEHOLDER }] }), 'hex')), false)
    .toString('hex') === legacy);

// ------------------------------------------------------- usernames
console.log('\npublic usernames with a Soqucoin address');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (buf) => {
  let n = BigInt(`0x${buf.toString('hex')}`);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const byte of buf) { if (byte === 0) s = `1${s}`; else break; }
  return s;
};
const addr = (version) => {
  const body = Buffer.concat([Buffer.from([version]), crypto.randomBytes(20)]);
  return b58(Buffer.concat([body, u.sha256d(body).subarray(0, 4)]));
};
const ltc = addr(0x30);
const doge = addr(0x1e);
const pep = addr(0x38);
// A real mainnet address (test/soq_unit.js checks it against its on-chain script).
const soq = 'sq1pu43lfdnte6tmfwzhvy8y8j8ga0xghd9j9hhaazczrl2ellfynqtsv270c8';
const soqScript = u.addressToScript(soq, 'soq-main');
const parse = (name, pepChain = 'pep-main', soqChain = 'soq-main') =>
  pm.parsePublicUsername(name, 'ltc-main', 'main', pepChain, soqChain);

const a = parse(`${ltc}.${doge}.${soq}.rig1`);
check('LTC.DOGE.SOQ.rig', a.ok && a.soqAddress === soq && a.soqScript.equals(soqScript) && a.pepScript === null &&
  a.workerName === 'rig1', JSON.stringify(a));
const bth = parse(`${ltc}.${doge}.${pep}.${soq}.rig1`);
check('LTC.DOGE.PEP.SOQ.rig', bth.ok && bth.pepAddress === pep && bth.soqAddress === soq && bth.workerName === 'rig1');
const rev = parse(`${ltc}.${doge}.${soq}.${pep}.rig1`);
check('LTC.DOGE.SOQ.PEP.rig (either order)', rev.ok && rev.pepAddress === pep && rev.soqAddress === soq && rev.workerName === 'rig1');
const noRig = parse(`${ltc}.${doge}.${soq}`);
check('LTC.DOGE.SOQ without a rig name', noRig.ok && noRig.soqAddress === soq && noRig.workerName === null);
const none = parse(`${ltc}.${doge}.rig1`);
check('LTC.DOGE.rig: no Soqucoin, rig name kept', none.ok && none.soqScript === null && none.workerName === 'rig1');
const typo = parse(`${ltc}.${doge}.${soq.slice(0, -1)}q.rig1`);
check('a Soqucoin address with a typo is refused, not taken for a rig name', !typo.ok && /Soqucoin address is not valid/.test(typo.reason),
  JSON.stringify(typo));
const stagenet = parse(`${ltc}.${doge}.s${soq}.rig1`);
check('a stagenet-looking (ssq1…) one on mainnet is refused', !stagenet.ok && /Soqucoin/.test(stagenet.reason), JSON.stringify(stagenet));
const off = parse(`${ltc}.${doge}.${soq}.rig1`, 'pep-main', null);
check('with Soqucoin off the name reads exactly as before', off.ok && off.soqScript === null && off.workerName === `${soq}.rig1`);
const rigSq = parse(`${ltc}.${doge}.sq1`);
check('a short rig name that happens to start with sq1 is still a rig name', rigSq.ok && rigSq.workerName === 'sq1');
const twice = parse(`${ltc}.${doge}.${soq}.${soq}`);
check('a second Soqucoin address is just part of the rig name', twice.ok && twice.soqAddress === soq && twice.workerName === soq);

console.log(failures ? `\n${failures} FAILED` : '\nPUBLIC SOQUCOIN UNIT VERIFIED');
process.exit(failures ? 1 : 0);
