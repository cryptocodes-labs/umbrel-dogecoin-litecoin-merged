'use strict';
//
// Merged mining: one set of scrypt hashes, two chains.
//
// Dogecoin has been merge-mined under Litecoin since 2014. The hashing happens
// on a LITECOIN block header — that is the "parent". Inside that parent block's
// coinbase sits a commitment to a Dogecoin block, and a Dogecoin block is
// accepted when its parent's header carries enough work and the commitment
// proves the two belong together. The same hash can therefore win on either
// chain, or both.
//
// Everything in this file is written against the consensus code that judges it,
// Dogecoin Core src/auxpow.cpp CAuxPow::check(), which requires:
//
//   * nIndex == 0 — the committing transaction is the parent's coinbase.
//   * The parent's chain ID differs from Dogecoin's (98). Litecoin's is not 98,
//     so this holds by construction.
//   * The coinbase scriptSig contains the chain merkle root, in DISPLAY byte
//     order (the code reverses the internal representation before searching).
//   * If the magic header fa be 6d 6d is present, the root must follow it
//     immediately and the magic may appear only once. Otherwise the root must
//     start within the first 20 bytes. We always write the magic — the modern
//     form, and the one that leaves room for a proper height push before it.
//   * Immediately after the root: a little-endian uint32 merkle SIZE, which
//     must equal 2^(chain merkle branch length), and a little-endian uint32
//     nonce. With a single aux chain the branch is empty, so size is 1 and the
//     expected index is 0.
//   * The coinbase must hash into the parent header's merkle root via the
//     supplied branch.
//
// The parent block itself is never validated by Dogecoin — it cannot be, since
// a Dogecoin node has no Litecoin chain. Only its header's proof of work and
// the merkle proofs matter. That is what makes merged mining cheap for the
// parent chain and free of consensus risk for it.
//

const u = require('./util');

// "fabe" then 'm','m'. src/auxpow.cpp pchMergedMiningHeader.
const MERGED_MINING_HEADER = Buffer.from([0xfa, 0xbe, 0x6d, 0x6d]);

// A single aux chain: no branch, so the tree has one leaf.
const CHAIN_MERKLE_SIZE = 1;
const CHAIN_MERKLE_BRANCH = [];
const CHAIN_MERKLE_INDEX = 0;

// CAuxPow::check(): "Aux POW chain merkle branch too long" above 30.
const MAX_CHAIN_MERKLE_HEIGHT = 30;

/**
 * The bytes that must appear in the parent coinbase's scriptSig.
 *
 * `auxHashHex` is the hash exactly as `createauxblock` reports it — display
 * order — which is also the order CAuxPow::check() searches for after it
 * reverses its internal uint256. It is written through unchanged, deliberately:
 * reversing it here would produce a commitment that no node can find, and the
 * only symptom would be a rejected block on the day it finally matters.
 *
 * With several aux chains the hash written here is the chain merkle ROOT (see
 * buildChainTree), in the same display order, and `size` is the tree's leaf
 * count. With one chain the root IS that chain's block hash and the size is 1,
 * which is the call every single-chain caller makes.
 */
function auxCommitment(auxHashHex, nonce = 0, size = CHAIN_MERKLE_SIZE) {
  const hash = Buffer.from(auxHashHex, 'hex');
  if (hash.length !== 32) throw new Error('aux block hash must be 32 bytes');
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(size >>> 0, 0);
  tail.writeUInt32LE(nonce >>> 0, 4);
  return Buffer.concat([MERGED_MINING_HEADER, hash, tail]);
}

// CAuxPow::CheckMerkleBranch: walk from a leaf to the root. Internal byte
// order throughout; the bit of the index at each level says which side the
// running hash is on.
function chainMerkleRoot(leafInternal, branch, index) {
  let hash = leafInternal;
  let i = index;
  for (const step of branch) {
    hash = i & 1 ? u.sha256d(Buffer.concat([step, hash])) : u.sha256d(Buffer.concat([hash, step]));
    i >>= 1;
  }
  return hash;
}

/**
 * The chain merkle tree for one or more aux chains merge-mined under one
 * parent.
 *
 * @param {Array<{chainId:number, hash:string}>} chains  aux block hashes in
 *        display order, as createauxblock reports them
 * @returns {{ root:string, size:number, nonce:number,
 *             proofs: Map<number,{branch:Buffer[], index:number}> }}
 *
 * Each chain's node only ever checks ITS leaf: that the branch leads from its
 * block hash to the committed root, that size == 2^(branch length), and that
 * its leaf sits at getExpectedIndex(nonce, chainId, height). So the tree must
 * put every chain at exactly that slot, and no two chains may share one. The
 * smallest height that has room is tried first, and for each height the nonces
 * from 0 up — DOGE (98) and PEP (63) land on slots 0 and 1 of a two-leaf tree
 * at nonce 0. Unused slots hold zero hashes; no node looks at them.
 *
 * One chain returns exactly what the single-chain code always committed to:
 * root = its hash, size 1, nonce 0, an empty branch at index 0.
 */
function buildChainTree(chains) {
  if (!Array.isArray(chains) || chains.length === 0) throw new Error('at least one aux chain is required');
  const ids = new Set();
  for (const c of chains) {
    if (!Number.isInteger(c.chainId) || c.chainId < 0) throw new Error(`bad chain id ${c.chainId}`);
    if (ids.has(c.chainId)) throw new Error(`chain id ${c.chainId} appears twice; two chains cannot share a slot`);
    ids.add(c.chainId);
    if (!/^[0-9a-f]{64}$/i.test(c.hash)) throw new Error(`aux block hash for chain ${c.chainId} must be 32 bytes of hex`);
  }

  if (chains.length === 1) {
    return {
      root: chains[0].hash,
      size: CHAIN_MERKLE_SIZE,
      nonce: 0,
      proofs: new Map([[chains[0].chainId, { branch: [], index: CHAIN_MERKLE_INDEX }]]),
    };
  }

  const minHeight = Math.ceil(Math.log2(chains.length));
  for (let height = minHeight; height <= MAX_CHAIN_MERKLE_HEIGHT; height++) {
    // A few hundred nonces is plenty at the smallest height that can fit; the
    // cap only keeps a pathological set of ids from looping for ever before
    // moving up a height.
    for (let nonce = 0; nonce < 1000; nonce++) {
      const slots = chains.map((c) => expectedIndex(nonce, c.chainId, height));
      if (new Set(slots).size !== slots.length) continue;

      const width = 2 ** height;
      let level = new Array(width).fill(null).map(() => Buffer.alloc(32));
      chains.forEach((c, k) => {
        level[slots[k]] = u.reverseBuffer(Buffer.from(c.hash, 'hex'));
      });

      const branches = chains.map(() => []);
      const positions = slots.slice();
      while (level.length > 1) {
        chains.forEach((_, k) => {
          branches[k].push(level[positions[k] ^ 1]);
          positions[k] >>= 1;
        });
        const next = [];
        for (let i = 0; i < level.length; i += 2) next.push(u.sha256d(Buffer.concat([level[i], level[i + 1]])));
        level = next;
      }

      const proofs = new Map();
      chains.forEach((c, k) => proofs.set(c.chainId, { branch: branches[k], index: slots[k] }));
      return { root: u.reverseBuffer(level[0]).toString('hex'), size: width, nonce, proofs };
    }
  }
  throw new Error('no chain merkle tree layout found for these chain ids');
}

// The index Dogecoin expects for a given nonce, chain and tree height. Ported
// from CAuxPow::getExpectedIndex; for a single chain (h = 0) it is always 0,
// but the function is here so the assumption is checkable rather than assumed.
function expectedIndex(nonce, chainId, height) {
  let rand = nonce >>> 0;
  rand = (Math.imul(rand, 1103515245) + 12345) >>> 0;
  rand = (rand + chainId) >>> 0;
  rand = (Math.imul(rand, 1103515245) + 12345) >>> 0;
  return rand % Math.pow(2, height);
}

/**
 * Serialise the AuxPoW proof, in the order CAuxPow reads it:
 *
 *   CMerkleTx : parent coinbase transaction
 *               parent block hash
 *               merkle branch (varint count, then 32-byte hashes)
 *               index (int32 LE)
 *   CAuxPow   : chain merkle branch (varint count, then hashes)
 *               chain index (int32 LE)
 *               parent block header (80 bytes)
 *
 * The coinbase is serialised WITHOUT witness data. Litecoin has segwit and a
 * coinbase in a block containing segwit transactions carries a witness, but the
 * transaction identifier — and therefore the merkle tree this proof walks — is
 * the non-witness hash. Serialising the witness form here would produce a
 * transaction whose hash does not match the branch.
 */
function serializeAuxPow({
  coinbaseTx, parentBlockHash, merkleBranch, parentHeader,
  chainBranch = CHAIN_MERKLE_BRANCH, chainIndex = CHAIN_MERKLE_INDEX,
}) {
  const parts = [];
  parts.push(coinbaseTx);
  // Internal byte order on the wire, which is the reverse of what RPC prints.
  parts.push(u.reverseBuffer(Buffer.from(parentBlockHash, 'hex')));

  parts.push(u.varIntBuffer(merkleBranch.length));
  for (const step of merkleBranch) parts.push(step);
  const index = Buffer.alloc(4);
  index.writeInt32LE(0, 0); // the coinbase is always the first transaction
  parts.push(index);

  // This chain's path through the chain merkle tree (buildChainTree); empty
  // with a single aux chain.
  parts.push(u.varIntBuffer(chainBranch.length));
  for (const step of chainBranch) parts.push(step);
  const chainIndexBuf = Buffer.alloc(4);
  chainIndexBuf.writeInt32LE(chainIndex, 0);
  parts.push(chainIndexBuf);

  parts.push(parentHeader);
  return Buffer.concat(parts);
}

/**
 * Where the commitment sits inside a scriptSig, or -1. Used to verify our own
 * work before a block is ever submitted: the rules above are easy to satisfy
 * accidentally-wrongly, and a self-check costs microseconds.
 */
function findCommitment(scriptSig, auxHashHex) {
  const wanted = auxCommitment(auxHashHex).subarray(0, 4 + 32);
  return scriptSig.indexOf(wanted);
}

/**
 * Re-run Dogecoin's own acceptance rules against a proof we just built. This is
 * not a substitute for the node's verdict, but it turns "the node said no" into
 * a specific reason at the moment the mistake is made rather than the moment a
 * block is lost.
 */
function verifyAuxPow({
  scriptSig, auxHashHex, chainId, coinbaseTxid, merkleBranch, parentMerkleRoot, parentVersion,
  chainBranch = CHAIN_MERKLE_BRANCH, chainIndex = CHAIN_MERKLE_INDEX,
}) {
  const problems = [];

  if (chainBranch.length > MAX_CHAIN_MERKLE_HEIGHT) problems.push('the chain merkle branch is longer than 30');
  // What the node searches for: the chain merkle root its branch leads to. With
  // a single chain and an empty branch that is the aux hash itself.
  const rootHex = u
    .reverseBuffer(chainMerkleRoot(u.reverseBuffer(Buffer.from(auxHashHex, 'hex')), chainBranch, chainIndex))
    .toString('hex');
  const at = findCommitment(scriptSig, rootHex);
  if (at < 0) problems.push(chainBranch.length ? 'the chain merkle root is not in the parent coinbase' : 'the aux hash is not in the parent coinbase');

  // Only one magic header allowed, and the root must follow it immediately.
  let occurrences = 0;
  for (let i = 0; i + 4 <= scriptSig.length; i++) {
    if (scriptSig.subarray(i, i + 4).equals(MERGED_MINING_HEADER)) occurrences++;
  }
  if (occurrences !== 1) problems.push(`the merged-mining header appears ${occurrences} times, not once`);

  if (at >= 0) {
    const tail = scriptSig.subarray(at + 4 + 32);
    if (tail.length < 8) problems.push('the size and nonce do not fit after the aux hash');
    else {
      const size = tail.readUInt32LE(0);
      const wantSize = 2 ** chainBranch.length;
      if (size !== wantSize) problems.push(`merkle size is ${size}, not ${wantSize}`);
      const nonce = tail.readUInt32LE(4);
      const want = expectedIndex(nonce, chainId, chainBranch.length);
      if (want !== chainIndex) problems.push(`chain index should be ${want}`);
    }
  }

  if (scriptSig.length < 2 || scriptSig.length > 100) {
    problems.push(`coinbase scriptSig is ${scriptSig.length} bytes, outside the 2..100 consensus range`);
  }

  // The parent must not claim to be one of ours; Dogecoin refuses that outright.
  if (parentVersion !== undefined && ((parentVersion >> 16) & 0xffff) === chainId) {
    problems.push('the parent block claims Dogecoin\'s own chain ID');
  }

  // And the coinbase really has to be in the parent's merkle tree.
  if (coinbaseTxid && parentMerkleRoot) {
    const root = u.merkleRootFromSteps(u.reverseBuffer(Buffer.from(coinbaseTxid, 'hex')), merkleBranch);
    if (u.reverseBuffer(root).toString('hex') !== parentMerkleRoot) {
      problems.push('the coinbase does not hash to the parent merkle root');
    }
  }

  return { ok: problems.length === 0, problems };
}

module.exports = {
  MERGED_MINING_HEADER,
  CHAIN_MERKLE_SIZE,
  CHAIN_MERKLE_BRANCH,
  CHAIN_MERKLE_INDEX,
  MAX_CHAIN_MERKLE_HEIGHT,
  auxCommitment,
  buildChainTree,
  chainMerkleRoot,
  expectedIndex,
  serializeAuxPow,
  findCommitment,
  verifyAuxPow,
};
