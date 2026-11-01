'use strict';
//
// Public merged mining: every miner is paid on BOTH chains at their OWN
// addresses, with a pool fee taken on both.
//
// The private merged mode asks dogecoind for its aux block with
// `createauxblock <address>`. That is the right tool for one operator, but it
// cannot serve a public port: the Dogecoin coinbase it builds pays exactly one
// address, so neither a per-miner payout nor a fee output is possible.
//
// So in public mode the Dogecoin block is built HERE, from dogecoind's own
// getblocktemplate, exactly as the Dogecoin-only mode already does for plain
// Dogecoin mining — the only additions are the auxpow version bit and, on
// submission, the auxpow proof between the header and the transactions. The
// node validates the result like any other block, so every rule below is
// checked by the consensus code that judges it (see test/public_merged_regtest.js).
//
// Layout of a submitted Dogecoin block (src/primitives/block.h, CBlock):
//
//   80-byte header, nVersion carrying the auxpow flag (1 << 8)
//   CAuxPow        — because the flag is set
//   varint tx count, coinbase, template transactions
//

const u = require('./util');

// src/primitives/pureheader.h: VERSION_AUXPOW = (1 << 8), VERSION_CHAIN_START
// = (1 << 16). dogecoind's getblocktemplate already carries the chain ID in
// `version` (0x620004 on every chain it serves); the flag is ours to set,
// because it is exactly what says "an auxpow follows this header".
const VERSION_AUXPOW = 1 << 8;
const DOGE_CHAIN_ID = 98;

/**
 * Split a coinbase value between the miner and the pool.
 *
 * Integer arithmetic on satoshis, rounding the FEE down: the miner is never
 * short-changed by a rounding step, and the two always add up to the exact
 * value the template allows — a single satoshi over and the block is invalid.
 */
function splitReward(value, feePercent) {
  const total = BigInt(value);
  // Hundredths of a percent, so 1.25% is representable without floats.
  const bp = BigInt(Math.round(Number(feePercent) * 100));
  if (bp < 0n || bp > 10000n) throw new Error(`pool fee ${feePercent}% is outside 0..100`);
  const fee = (total * bp) / 10000n;
  return { miner: total - fee, fee };
}

function outputBuf(value, script) {
  const v = Buffer.alloc(8);
  v.writeBigUInt64LE(BigInt(value));
  return Buffer.concat([v, u.varIntBuffer(script.length), script]);
}

/**
 * The Dogecoin block a given miner is working on, minus its proof of work.
 *
 * @param {object} template     dogecoind getblocktemplate result
 * @param {Buffer} minerScript  Dogecoin scriptPubKey the miner is paid at
 * @param {Buffer} feeScript    Dogecoin scriptPubKey of the pool fee
 * @param {number} feePercent   e.g. 1 for 1%
 * @param {string} tag          coinbase marker
 *
 * Returns an object shaped like a createauxblock answer — hash, height,
 * coinbasevalue, bits, previousblockhash, chainid — so MergedJob consumes it
 * unchanged, plus what submission needs to rebuild the block.
 */
function buildAuxBlock(template, minerScript, feeScript, feePercent, tag, chainId = DOGE_CHAIN_ID) {
  // `chainId` names the aux chain whose block this is. Dogecoin by default;
  // Pepecoin (63) is built the same way — it is Dogecoin Core 1.14 underneath,
  // with the same block layout and the same auxpow code.
  const version = (template.version | VERSION_AUXPOW) >>> 0;
  if (((version >>> 16) & 0xffff) !== chainId) {
    throw new Error(
      `the aux template version 0x${version.toString(16)} does not carry chain id ${chainId}`
    );
  }

  const { miner, fee } = splitReward(template.coinbasevalue, feePercent);
  const outputs = [outputBuf(miner, minerScript)];
  if (fee > 0n) outputs.push(outputBuf(fee, feeScript));

  // BIP34 height, then the tag. No extranonce: the proof of work is on the
  // Litecoin header, so this coinbase never needs to vary to find more work.
  const scriptSig = Buffer.concat([
    u.coinbaseHeightScript(template.height),
    Buffer.from((template.coinbaseaux && template.coinbaseaux.flags) || '', 'hex'),
    Buffer.from(tag, 'utf8'),
  ]);
  if (scriptSig.length < 2 || scriptSig.length > 100) {
    throw new Error(`Dogecoin coinbase scriptSig would be ${scriptSig.length} bytes; must be 2..100`);
  }
  const coinbase = Buffer.concat([
    Buffer.from('01000000', 'hex'),
    u.varIntBuffer(1),
    Buffer.alloc(32),
    Buffer.from('ffffffff', 'hex'),
    u.varIntBuffer(scriptSig.length),
    scriptSig,
    Buffer.from('ffffffff', 'hex'),
    u.varIntBuffer(outputs.length),
    ...outputs,
    Buffer.from('00000000', 'hex'),
  ]);

  const txs = (template.transactions || []).map((t) => t.data);
  const txHashes = (template.transactions || []).map((t) =>
    u.reverseBuffer(Buffer.from(t.txid || t.hash, 'hex'))
  );
  const merkleRoot = u.merkleRootFromSteps(u.sha256d(coinbase), u.merkleSteps(txHashes));

  const header = Buffer.alloc(80);
  header.writeUInt32LE(version, 0);
  u.reverseBuffer(Buffer.from(template.previousblockhash, 'hex')).copy(header, 4);
  merkleRoot.copy(header, 36);
  header.writeUInt32LE(template.curtime, 68);
  header.writeUInt32LE(parseInt(template.bits, 16), 72);
  header.writeUInt32LE(0, 76); // unused: the work is on the parent

  return {
    // Display order — the form createauxblock reports and CAuxPow::check()
    // searches the parent coinbase for.
    hash: u.reverseBuffer(u.sha256d(header)).toString('hex'),
    chainid: chainId,
    previousblockhash: template.previousblockhash,
    coinbasevalue: template.coinbasevalue,
    bits: template.bits,
    height: template.height,
    // What submission needs.
    header,
    coinbase,
    transactions: txs,
    minerValue: miner,
    feeValue: fee,
  };
}

// ---------------------------------------------------------------- Soqucoin
//
// Soqucoin's block cannot be built from nothing the way Dogecoin's and
// Pepecoin's are, for two reasons:
//
//   * SegWit is active, so the coinbase carries a witness commitment and a
//     witness nonce, and the template's transactions carry witnesses.
//   * When the template's transactions spend ordinary sq1p outputs, the
//     coinbase carries a PAT block attestation: a 36-byte OP_RETURN,
//     6a22 5041 <32-byte hash>, committing to those spends' signatures
//     (soqucoin doc/PAT_BLOCK_ATTESTATION.md §6). Every node recomputes it and
//     rejects a block whose commitment differs; from a height Soqucoin will
//     announce, a block with attested spends and NO commitment is rejected too.
//
// So the pool starts from the coinbase soqucoind itself assembled, which
// getblocktemplate hands over as `coinbasetxn.data` (src/rpc/mining.cpp), and
// changes exactly one thing: the placeholder payout output, OP_1 followed by 32
// zero bytes, becomes the miner's output plus the pool's fee output. Every
// other output (witness commitment, PAT commitment), the coinbase witness
// nonce, the scriptSig and the template's transactions stay byte for byte as
// the node gave them. This is the second row of the table in soqucoin
// doc/pool-integration.md, "Block attestation (PAT)".
//
// Why splitting the payout is safe for both commitments: the witness
// commitment is over wtxids, and the coinbase's wtxid is defined as zero; the
// PAT attestation covers two-item witness spends, and the coinbase spends
// nothing. Neither depends on the coinbase's outputs. Part 3 of
// test/soq_pool_regtest.js proves it against soqucoind with attested spends
// in the block.

const SOQ_CHAIN_ID = 21329;
// CScript() << OP_1 << std::vector<unsigned char>(32, 0) — mining.cpp's scriptDummy.
const SOQ_PLACEHOLDER = Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32)]);
// OP_RETURN OP_PUSHBYTES_34 'P' 'A'
const PAT_PREFIX = Buffer.from('6a225041', 'hex');
const COINBASE_PREVOUT = Buffer.concat([Buffer.alloc(32), Buffer.from('ffffffff', 'hex')]);

/** A transaction, witness or not, as Bitcoin Core serializes it. Refuses anything malformed. */
function parseTx(buf) {
  let pos = 0;
  const need = (n) => {
    if (pos + n > buf.length) throw new Error('the transaction is truncated');
  };
  const take = (n) => {
    need(n);
    const out = buf.subarray(pos, pos + n);
    pos += n;
    return Buffer.from(out);
  };
  const varint = () => {
    need(1);
    const b = buf[pos];
    if (b < 0xfd) { pos += 1; return b; }
    if (b === 0xfd) { need(3); const v = buf.readUInt16LE(pos + 1); pos += 3; return v; }
    if (b === 0xfe) { need(5); const v = buf.readUInt32LE(pos + 1); pos += 5; return v; }
    need(9);
    const v = buf.readBigUInt64LE(pos + 1);
    pos += 9;
    if (v > BigInt(buf.length)) throw new Error('the transaction has an impossible length field');
    return Number(v);
  };
  const version = take(4);
  let segwit = false;
  if (buf.length > pos + 1 && buf[pos] === 0x00 && buf[pos + 1] === 0x01) {
    segwit = true;
    pos += 2;
  }
  const inputs = [];
  for (let i = 0, n = varint(); i < n; i++) {
    const prevout = take(36);
    const script = take(varint());
    const sequence = take(4);
    inputs.push({ prevout, script, sequence });
  }
  const outputs = [];
  for (let i = 0, n = varint(); i < n; i++) {
    const value = take(8).readBigUInt64LE(0);
    const script = take(varint());
    outputs.push({ value, script });
  }
  const witnesses = [];
  if (segwit) {
    for (let i = 0; i < inputs.length; i++) {
      const items = [];
      for (let j = 0, n = varint(); j < n; j++) items.push(take(varint()));
      witnesses.push(items);
    }
  }
  const locktime = take(4);
  if (pos !== buf.length) throw new Error(`the transaction has ${buf.length - pos} bytes after its end`);
  return { version, segwit, inputs, outputs, witnesses, locktime };
}

/** parseTx's inverse. Without the witness, it is what the txid is the hash of. */
function serializeTx(tx, withWitness) {
  const witness = withWitness && tx.segwit;
  const parts = [tx.version];
  if (witness) parts.push(Buffer.from([0x00, 0x01]));
  parts.push(u.varIntBuffer(tx.inputs.length));
  for (const i of tx.inputs) parts.push(i.prevout, u.varIntBuffer(i.script.length), i.script, i.sequence);
  parts.push(u.varIntBuffer(tx.outputs.length));
  for (const o of tx.outputs) parts.push(outputBuf(o.value, o.script));
  if (witness) {
    for (const items of tx.witnesses) {
      parts.push(u.varIntBuffer(items.length));
      for (const it of items) parts.push(u.varIntBuffer(it.length), it);
    }
  }
  parts.push(tx.locktime);
  return Buffer.concat(parts);
}

const isPatCommitment = (script) => script.length === 36 && script.subarray(0, 4).equals(PAT_PREFIX);

/**
 * The Soqucoin block a given miner is working on, minus its proof of work.
 * Same contract as buildAuxBlock; see the section comment above for what is
 * taken from soqucoind as is and what is the pool's.
 *
 * @param {object} template     soqucoind getblocktemplate result (rules: segwit)
 * @param {Buffer} minerScript  sq1p scriptPubKey the miner is paid at
 * @param {Buffer} feeScript    sq1p scriptPubKey of the pool fee
 * @param {number} feePercent   e.g. 1 for 1%
 */
function buildSoqAuxBlock(template, minerScript, feeScript, feePercent) {
  const version = (template.version | VERSION_AUXPOW) >>> 0;
  if (((version >>> 16) & 0xffff) !== SOQ_CHAIN_ID) {
    throw new Error(
      `the Soqucoin template version 0x${version.toString(16)} does not carry chain id ${SOQ_CHAIN_ID}`
    );
  }
  const data = template.coinbasetxn && template.coinbasetxn.data;
  if (typeof data !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(data)) {
    throw new Error('the Soqucoin template has no coinbasetxn to build the coinbase from');
  }
  const cb = parseTx(Buffer.from(data, 'hex'));
  if (cb.inputs.length !== 1 || !cb.inputs[0].prevout.equals(COINBASE_PREVOUT)) {
    throw new Error('the Soqucoin template\'s coinbasetxn is not a coinbase');
  }

  // Exactly one placeholder, paying exactly the template's coinbase value, and
  // nothing else in the coinbase paying anybody: otherwise the split below
  // would not be the whole reward, and the block would pay an output nobody
  // here chose.
  const slots = cb.outputs.map((o, i) => (o.script.equals(SOQ_PLACEHOLDER) ? i : -1)).filter((i) => i >= 0);
  if (slots.length !== 1) {
    throw new Error(`the Soqucoin coinbase has ${slots.length} placeholder payouts; exactly one was expected`);
  }
  const slot = slots[0];
  const total = BigInt(template.coinbasevalue);
  if (cb.outputs[slot].value !== total) {
    throw new Error(
      `the Soqucoin placeholder pays ${cb.outputs[slot].value}, the template's coinbasevalue is ${total}`
    );
  }
  if (cb.outputs.some((o, i) => i !== slot && o.value !== 0n)) {
    throw new Error('the Soqucoin coinbase pays an output besides the placeholder; refusing to guess what it is');
  }
  // At most one PAT commitment: a second one makes the block invalid
  // (bad-blk-pat-commitment-duplicate). Kept as the node computed it.
  const pats = cb.outputs.filter((o) => isPatCommitment(o.script));
  if (pats.length > 1) throw new Error('the Soqucoin coinbase carries more than one PAT commitment');
  // The witness commitment the template announces must be the one in the
  // coinbase we keep; a mismatch means the two did not come from one template.
  if (template.default_witness_commitment) {
    const wc = Buffer.from(template.default_witness_commitment, 'hex');
    if (cb.outputs.filter((o) => o.script.equals(wc)).length !== 1) {
      throw new Error('the Soqucoin coinbase does not carry the template\'s witness commitment');
    }
  }

  const { miner, fee } = splitReward(total, feePercent);
  const payouts = [{ value: miner, script: minerScript }];
  if (fee > 0n) payouts.push({ value: fee, script: feeScript });
  const tx = { ...cb, outputs: [...cb.outputs.slice(0, slot), ...payouts, ...cb.outputs.slice(slot + 1)] };
  const coinbase = serializeTx(tx, true);
  const coinbaseTxid = u.sha256d(serializeTx(tx, false));

  // The merkle root is over txids, never wtxids: `txid`, not `hash`, which on
  // a SegWit chain is the wtxid.
  const transactions = template.transactions || [];
  for (const t of transactions) {
    if (!/^[0-9a-f]{64}$/.test(String(t.txid)) || typeof t.data !== 'string') {
      throw new Error('a Soqucoin template transaction has no txid or data');
    }
  }
  const txHashes = transactions.map((t) => u.reverseBuffer(Buffer.from(t.txid, 'hex')));
  const merkleRoot = u.merkleRootFromSteps(coinbaseTxid, u.merkleSteps(txHashes));

  const header = Buffer.alloc(80);
  header.writeUInt32LE(version, 0);
  u.reverseBuffer(Buffer.from(template.previousblockhash, 'hex')).copy(header, 4);
  merkleRoot.copy(header, 36);
  header.writeUInt32LE(template.curtime, 68);
  header.writeUInt32LE(parseInt(template.bits, 16), 72);
  header.writeUInt32LE(0, 76);

  return {
    hash: u.reverseBuffer(u.sha256d(header)).toString('hex'),
    chainid: SOQ_CHAIN_ID,
    previousblockhash: template.previousblockhash,
    coinbasevalue: template.coinbasevalue,
    bits: template.bits,
    height: template.height,
    header,
    // With its witness: that is how the block carries it.
    coinbase,
    transactions: transactions.map((t) => t.data),
    minerValue: miner,
    feeValue: fee,
    // The commitment kept from soqucoind's coinbase, or null when the
    // template has no attested spends (and so must carry none).
    patCommitment: pats.length ? pats[0].script.toString('hex') : null,
  };
}

/**
 * The full aux block for submitblock: header, auxpow, transactions. Dogecoin,
 * Pepecoin and Soqucoin alike (Soqucoin's coinbase and transactions are
 * carried with their witnesses, as buildSoqAuxBlock returns them).
 */
function serializeAuxBlock(auxBlock, auxPow) {
  return Buffer.concat([
    auxBlock.header,
    auxPow,
    u.varIntBuffer(auxBlock.transactions.length + 1),
    auxBlock.coinbase,
    ...auxBlock.transactions.map((t) => Buffer.from(t, 'hex')),
  ]).toString('hex');
}

/**
 * A public username: "<LTC address>.<DOGE address>[.<worker>]".
 *
 * Both addresses are required. A miner who gives only one would otherwise have
 * the other chain's reward paid to somebody — and on a public port there is
 * nobody it would be right to pay. Returns {ok:false, reason} instead of
 * guessing.
 */
function parsePublicUsername(username, ltcChain, dogeChain, pepChain = null, soqChain = null) {
  const parts = String(username || '').split('.');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    return {
      ok: false,
      reason: 'username must be <LTC address>.<DOGE address>[.worker]',
    };
  }
  let ltcScript;
  let dogeScript;
  try {
    ltcScript = u.addressToScript(parts[0], ltcChain);
  } catch (err) {
    return { ok: false, reason: `the Litecoin address is not valid: ${err.message}` };
  }
  try {
    dogeScript = u.addressToScript(parts[1], dogeChain);
  } catch (err) {
    return { ok: false, reason: `the Dogecoin address is not valid: ${err.message}` };
  }
  // An optional third address, Pepecoin's, when the pool merge-mines it:
  // "<LTC>.<DOGE>.<PEP>[.worker]". Without one the name reads exactly as it
  // always did, the third part being the worker, and that miner simply mines
  // without Pepecoin. Something shaped like an address that does not decode is
  // refused rather than taken for a rig name — a typo there would otherwise
  // cost the miner every Pepecoin block without a word.
  //
  // And Soqucoin's, likewise optional, an sq1p… address: "<LTC>.<DOGE>[.<PEP>]
  // [.<SOQ>][.worker]", the two in either order. A Bech32m address and a Base58
  // one cannot be mistaken for each other, so the order needs no rule. Here too
  // something that looks like a Soqucoin address and does not decode is
  // refused: a worker name it is not.
  let pepScript = null;
  let pepAddress = null;
  let soqScript = null;
  let soqAddress = null;
  let rest = parts.slice(2);
  for (let round = 0; round < 2 && rest.length && rest[0]; round++) {
    const part = rest[0];
    if (pepChain && !pepScript) {
      try {
        pepScript = u.addressToScript(part, pepChain);
        pepAddress = part;
        rest = rest.slice(1);
        continue;
      } catch (err) {
        if (/^[1-9A-HJ-NP-Za-km-z]{33,35}$/.test(part)) {
          return { ok: false, reason: `the Pepecoin address is not valid: ${err.message}` };
        }
      }
    }
    if (soqChain && !soqScript) {
      try {
        soqScript = u.addressToScript(part, soqChain);
        soqAddress = part;
        rest = rest.slice(1);
        continue;
      } catch (err) {
        // Only something that could be (part of) an address: sq1/ssq1 and then
        // nothing but Bech32 characters, 14 or more in all. A rig name such as
        // "sq1-garage-rig" or "SQ1rig-L7" (a dash, or b/i/o/1 after the prefix)
        // stays a rig name; a cut-off or mistyped address is still refused.
        if (/^s{1,2}q1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/i.test(part) && part.length >= 14) {
          return { ok: false, reason: `the Soqucoin address is not valid: ${err.message}` };
        }
      }
    }
    break;
  }
  return {
    ok: true,
    ltcAddress: parts[0],
    dogeAddress: parts[1],
    pepAddress,
    soqAddress,
    ltcScript,
    dogeScript,
    pepScript,
    soqScript,
    workerName: rest.join('.') || null,
  };
}

module.exports = {
  VERSION_AUXPOW,
  SOQ_PLACEHOLDER,
  splitReward,
  buildAuxBlock,
  buildSoqAuxBlock,
  parseTx,
  serializeTx,
  serializeAuxBlock,
  parsePublicUsername,
};
