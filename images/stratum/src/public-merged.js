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
function buildAuxBlock(template, minerScript, feeScript, feePercent, tag) {
  const version = (template.version | VERSION_AUXPOW) >>> 0;
  if (((version >>> 16) & 0xffff) !== DOGE_CHAIN_ID) {
    throw new Error(
      `the Dogecoin template version 0x${version.toString(16)} does not carry chain id ${DOGE_CHAIN_ID}`
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
    chainid: DOGE_CHAIN_ID,
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

/** The full Dogecoin block for submitblock: header, auxpow, transactions. */
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
function parsePublicUsername(username, ltcChain, dogeChain) {
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
  return {
    ok: true,
    ltcAddress: parts[0],
    dogeAddress: parts[1],
    ltcScript,
    dogeScript,
    workerName: parts.slice(2).join('.') || null,
  };
}

module.exports = {
  VERSION_AUXPOW,
  splitReward,
  buildAuxBlock,
  serializeAuxBlock,
  parsePublicUsername,
};
