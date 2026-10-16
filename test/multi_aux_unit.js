'use strict';
//
// Several aux chains under one parent: the chain merkle tree.
//
// Two claims, both checkable without a daemon:
//
//   1. With Dogecoin alone nothing changes. The commitment, the coinbase and
//      the auxpow proof are the bytes the single-chain code always produced.
//   2. With more chains, every chain's proof satisfies the rules its node
//      enforces — the rules of src/auxpow.cpp, which Dogecoin 1.14.9 and
//      Pepecoin 1.1.0 share byte for byte (same git blob 5efe0541).
//
// The daemon-backed proof that dogecoind AND pepecoind accept a block from one
// parent is test/pep_merged_regtest.js.
//
const crypto = require('node:crypto');
const u = require('../images/stratum/src/util');
const aux = require('../images/stratum/src/auxpow');
const { MergedJob, DOGE_CHAIN_ID } = require('../images/stratum/src/merged');

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

const PEP_CHAIN_ID = 63;
const DINGO_CHAIN_ID = 50;
const hex32 = () => crypto.randomBytes(32).toString('hex');

// The commitment exactly as the single-chain code wrote it before this change:
// magic, the aux hash in display order, size 1, nonce 0.
function legacyCommitment(hash) {
  return Buffer.concat([
    Buffer.from('fabe6d6d', 'hex'),
    Buffer.from(hash, 'hex'),
    Buffer.from('0100000000000000', 'hex'),
  ]);
}

// A scriptSig shaped like the pool's: height push, extranonce, tag, commitment.
function scriptSigWith(commitment) {
  return Buffer.concat([u.coinbaseHeightScript(1000), crypto.randomBytes(8), Buffer.from('/t/'), commitment]);
}

console.log('\none chain: the tree is the old single leaf');
{
  const h = hex32();
  const tree = aux.buildChainTree([{ chainId: DOGE_CHAIN_ID, hash: h }]);
  check('root is the aux hash itself', tree.root === h, tree.root);
  check('size 1, nonce 0', tree.size === 1 && tree.nonce === 0, `${tree.size}/${tree.nonce}`);
  const p = tree.proofs.get(DOGE_CHAIN_ID);
  check('empty branch at index 0', p.branch.length === 0 && p.index === 0, JSON.stringify(p));
  const c = aux.auxCommitment(tree.root, tree.nonce, tree.size);
  check('the commitment is byte-identical to the single-chain one', c.equals(legacyCommitment(h)), c.toString('hex'));
  check('and to auxCommitment(hash, 0) as every caller wrote it', c.equals(aux.auxCommitment(h, 0)));
}

console.log('\nDOGE + PEP: a two-leaf tree');
const dogeHash = hex32();
const pepHash = hex32();
const tree2 = aux.buildChainTree([
  { chainId: DOGE_CHAIN_ID, hash: dogeHash },
  { chainId: PEP_CHAIN_ID, hash: pepHash },
]);
{
  check('size 2', tree2.size === 2, String(tree2.size));
  check('nonce 0 already separates them', tree2.nonce === 0, String(tree2.nonce));
  const d = tree2.proofs.get(DOGE_CHAIN_ID);
  const p = tree2.proofs.get(PEP_CHAIN_ID);
  // getExpectedIndex(0, 98, 1) and getExpectedIndex(0, 63, 1), by hand from
  // src/auxpow.cpp: (12345 + id) * 1103515245 + 12345, mod 2.
  check('DOGE (98) sits at slot 0, as getExpectedIndex says', d.index === 0 && aux.expectedIndex(0, 98, 1) === 0);
  check('PEP (63) sits at slot 1, as getExpectedIndex says', p.index === 1 && aux.expectedIndex(0, 63, 1) === 1);
  const leafD = u.reverseBuffer(Buffer.from(dogeHash, 'hex'));
  const leafP = u.reverseBuffer(Buffer.from(pepHash, 'hex'));
  const rootInternal = u.sha256d(Buffer.concat([leafD, leafP]));
  check('the root is sha256d(DOGE leaf || PEP leaf), shown in display order',
    tree2.root === u.reverseBuffer(rootInternal).toString('hex'));
  check('each branch is the other chain\'s leaf', d.branch[0].equals(leafP) && p.branch[0].equals(leafD));
  check('DOGE\'s branch leads to the root (CheckMerkleBranch)',
    aux.chainMerkleRoot(leafD, d.branch, d.index).equals(rootInternal));
  check('PEP\'s branch leads to the root (CheckMerkleBranch)',
    aux.chainMerkleRoot(leafP, p.branch, p.index).equals(rootInternal));

  const commitment = aux.auxCommitment(tree2.root, tree2.nonce, tree2.size);
  check('the commitment is still 44 bytes', commitment.length === 44, String(commitment.length));
  const scriptSig = scriptSigWith(commitment);
  for (const [name, id, hash] of [['DOGE', 98, dogeHash], ['PEP', 63, pepHash]]) {
    const pr = tree2.proofs.get(id);
    const r = aux.verifyAuxPow({ scriptSig, auxHashHex: hash, chainId: id, chainBranch: pr.branch, chainIndex: pr.index });
    check(`${name}'s proof passes the auxpow.cpp rules`, r.ok, r.problems.join(' | '));
  }
  const swapped = aux.verifyAuxPow({ scriptSig, auxHashHex: pepHash, chainId: 63, chainBranch: d.branch, chainIndex: 0 });
  check('PEP at DOGE\'s slot is refused', !swapped.ok);
  const wrongSize = aux.verifyAuxPow({
    scriptSig: scriptSigWith(aux.auxCommitment(tree2.root, 0, 4)),
    auxHashHex: pepHash, chainId: 63, chainBranch: p.branch, chainIndex: 1,
  });
  check('a size that does not match the branch is refused', !wrongSize.ok);
  const single = aux.verifyAuxPow({ scriptSig, auxHashHex: dogeHash, chainId: 98 });
  check('a single-chain proof does not pass against a two-chain commitment', !single.ok);
}

console.log('\nthree chains still get distinct slots');
{
  const chains = [
    { chainId: DOGE_CHAIN_ID, hash: hex32() },
    { chainId: PEP_CHAIN_ID, hash: hex32() },
    { chainId: DINGO_CHAIN_ID, hash: hex32() },
  ];
  const t = aux.buildChainTree(chains);
  const slots = chains.map((c) => t.proofs.get(c.chainId).index);
  check('all slots differ', new Set(slots).size === 3, JSON.stringify(slots));
  check('size is a power of two that fits them', t.size >= 4 && (t.size & (t.size - 1)) === 0, String(t.size));
  const scriptSig = scriptSigWith(aux.auxCommitment(t.root, t.nonce, t.size));
  for (const c of chains) {
    const pr = t.proofs.get(c.chainId);
    const r = aux.verifyAuxPow({ scriptSig, auxHashHex: c.hash, chainId: c.chainId, chainBranch: pr.branch, chainIndex: pr.index });
    check(`chain ${c.chainId} verifies`, r.ok, r.problems.join(' | '));
  }
}

console.log('\nrefusals');
{
  let threw = false;
  try { aux.buildChainTree([{ chainId: 98, hash: hex32() }, { chainId: 98, hash: hex32() }]); } catch { threw = true; }
  check('two chains with the same id are refused', threw);
  threw = false;
  try { aux.buildChainTree([]); } catch { threw = true; }
  check('an empty chain list is refused', threw);
}

console.log('\nMergedJob: no extra chain means the old coinbase');
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
{
  const plain = new MergedJob('1', template, payout, '/t/', dogeAux);
  const empty = new MergedJob('2', template, payout, '/t/', dogeAux, { extraAux: [] });
  check('coinb1 is the same with and without an empty extraAux', plain.coinb1.equals(empty.coinb1));
  check('coinb2 is the same with and without an empty extraAux', plain.coinb2.equals(empty.coinb2));
  check('coinb2 carries the single-chain commitment', plain.coinb2.indexOf(legacyCommitment(dogeHash)) >= 0);
  check('no further aux chains', plain.extraAux.length === 0);
}

console.log('\nMergedJob with PEP');
{
  const job = new MergedJob('3', template, payout, '/t/', dogeAux, {
    extraAux: [{ name: 'PEP', chainId: PEP_CHAIN_ID, block: pepAux }],
  });
  const plain = new MergedJob('4', template, payout, '/t/', dogeAux);
  check('coinb1 is unchanged — the commitment is the same length', job.coinb1.equals(plain.coinb1));
  check('coinb2 carries the two-chain root instead', job.coinb2.indexOf(aux.auxCommitment(tree2.root, 0, 2)) >= 0);
  check('PEP is listed with its own target', job.extraAux.length === 1 && job.extraAux[0].target === u.targetFromBits('207fffff'));

  const coinbase = Buffer.concat([job.coinb1, crypto.randomBytes(8), job.coinb2]);
  const merkleRoot = u.merkleRootFromSteps(u.sha256d(coinbase), job.merkleSteps);
  const header = Buffer.alloc(80);
  header.writeUInt32LE(template.version, 0);
  merkleRoot.copy(header, 36);
  check('Dogecoin\'s rule check passes on the two-chain coinbase', job.verifyAgainstDogecoin(header, coinbase).ok,
    job.verifyAgainstDogecoin(header, coinbase).problems.join(' | '));
  const vp = job.verifyAux(header, coinbase, PEP_CHAIN_ID, pepHash);
  check('PEP\'s rule check passes on the same coinbase', vp.ok, vp.problems.join(' | '));
  const dHex = job.auxPowHex(header, coinbase);
  const pHex = job.auxPowHex(header, coinbase, PEP_CHAIN_ID);
  check('the two proofs differ only in the chain branch and index', dHex !== pHex && dHex.length === pHex.length);
  check('a share meeting PEP\'s target is a PEP candidate', job.extraAuxCandidates(1n).length === 1);
  check('a share missing it is not', job.extraAuxCandidates(u.targetFromBits('207fffff') + 1n).length === 0);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
