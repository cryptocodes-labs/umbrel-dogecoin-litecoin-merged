'use strict';
//
// The parent-chain job: a Litecoin block template that carries a commitment to
// a Dogecoin block in its coinbase.
//
// Litecoin is what the miners actually hash. Dogecoin never sees this block —
// it only ever sees the header, the coinbase and a merkle proof (see
// auxpow.js). So this class has two jobs that must not be confused:
//
//   * produce a block that LITECOIN will accept — right payout script for the
//     Litecoin chain, segwit witness commitment, witness-serialised coinbase;
//   * produce a coinbase that DOGECOIN can verify — the aux commitment placed
//     so that CAuxPow::check() finds it, and serialised WITHOUT the witness,
//     because the merkle tree the proof walks is built from txids.
//
// The commitment lives in the fixed tail of the scriptSig (coinb2), after the
// extranonce. It cannot be split across the extranonce: the magic must be
// followed IMMEDIATELY by the aux hash, and the miner owns the four bytes in
// the middle.
//

const u = require('./util');
const aux = require('./auxpow');
const { Job, EXTRANONCE1_SIZE, EXTRANONCE2_SIZE } = require('./job');
const { splitReward } = require('./public-merged');

// Dogecoin's chain ID, from its consensus parameters. Used to re-run the aux
// rules against our own proof before it is submitted.
const DOGE_CHAIN_ID = 98;

// litecoind refuses getblocktemplate unless the caller declares it understands
// the deployed rules. Without mweb it answers "getblocktemplate must be called
// with the mweb rule set" and the pool never gets a template at all.
const LTC_RULES = ['mweb', 'segwit'];

class MergedJob extends Job {
  /**
   * @param {object} template  litecoind getblocktemplate result (the parent)
   * @param {Buffer} payoutScript  a LITECOIN scriptPubKey
   * @param {object} auxBlock  dogecoind createauxblock result
   */
  constructor(id, template, payoutScript, tag, auxBlock, extra = {}) {
    // `extra.fee` ({ script, percent }) is set only by the public merged mode;
    // without it the coinbase below is byte-for-byte what it always was.
    super(id, template, payoutScript, tag, { auxBlock, fee: extra.fee || null });

    this.auxBlock = auxBlock;
    this.auxHash = auxBlock.hash;
    this.auxHeight = auxBlock.height;
    this.auxValue = auxBlock.coinbasevalue;

    // BOTH targets come from `bits`, and neither from a target string.
    // litecoind reports getblocktemplate.target big-endian while dogecoind
    // reports createauxblock._target little-endian, nothing warns about it, and
    // reading either the wrong way round fails silently: one direction makes
    // the target unreachable so blocks are never submitted, the other makes
    // every share look like a block.
    this.auxTarget = u.targetFromBits(auxBlock.bits);
    this.auxDifficulty = u.difficultyFromTarget(this.auxTarget);
    this.networkTarget = u.targetFromBits(template.bits);
    this.networkDifficulty = u.difficultyFromTarget(this.networkTarget);

    this.witnessCommitment = template.default_witness_commitment || null;
    // MWEB's extension block, when the template has one. Serialised after the
    // transactions. Empty on every chain state this has been run against, so
    // the branch exists to avoid dropping data rather than because it has been
    // exercised.
    this.mweb = typeof template.mweb === 'string' && template.mweb.length ? template.mweb : null;
  }

  _buildCoinbase(payoutScript, tag) {
    const auxBlock = this.opts.auxBlock;

    // BIP34 height first; Litecoin enforces it exactly as Dogecoin does.
    const prefix = Buffer.concat([
      u.coinbaseHeightScript(this.height),
      Buffer.from((this.template.coinbaseaux && this.template.coinbaseaux.flags) || '', 'hex'),
    ]);
    // Nonce 0: with a single aux chain the expected index is 0 for every nonce
    // (getExpectedIndex mod 2^0), so rolling it would buy nothing and only add
    // a way to get it wrong.
    const suffix = Buffer.concat([
      Buffer.from(tag, 'utf8'),
      aux.auxCommitment(auxBlock.hash, 0),
    ]);

    const scriptSigLength =
      prefix.length + EXTRANONCE1_SIZE + EXTRANONCE2_SIZE + suffix.length;
    // 44 of those bytes are the commitment, so a long COINBASE_TAG is the way
    // this trips. Refuse at template time rather than mining blocks both chains
    // reject.
    if (scriptSigLength < 2 || scriptSigLength > 100) {
      throw new Error(
        `merged coinbase scriptSig would be ${scriptSigLength} bytes; must be 2..100 ` +
          `(the aux commitment needs 44 of them — shorten COINBASE_TAG)`
      );
    }

    this.coinb1 = Buffer.concat([
      Buffer.from('01000000', 'hex'),
      u.varIntBuffer(1),
      Buffer.alloc(32),
      Buffer.from('ffffffff', 'hex'),
      u.varIntBuffer(scriptSigLength),
      prefix,
      // extranonce1 + extranonce2 land here
    ]);

    const outputs = [];
    const fee = this.opts.fee;
    if (fee) {
      // Public mode: the miner's share first, then the pool fee. The split is
      // integer and exact, so the two always sum to what the template allows.
      const { miner, fee: feeValue } = splitReward(this.coinbaseValue, fee.percent);
      outputs.push(output(miner, payoutScript));
      if (feeValue > 0n) outputs.push(output(feeValue, fee.script));
      this.minerValue = miner;
      this.feeValue = feeValue;
    } else {
      outputs.push(output(this.coinbaseValue, payoutScript));
    }
    // The segwit commitment output. The template's value is computed from the
    // transactions alone — the coinbase's own wtxid is defined as zero — so it
    // stays valid however we build this coinbase.
    if (this.template.default_witness_commitment) {
      const wc = Buffer.from(this.template.default_witness_commitment, 'hex');
      outputs.push(Buffer.concat([Buffer.alloc(8), u.varIntBuffer(wc.length), wc]));
    }

    this.coinb2 = Buffer.concat([
      suffix,
      Buffer.from('ffffffff', 'hex'),
      u.varIntBuffer(outputs.length),
      ...outputs,
      Buffer.from('00000000', 'hex'),
    ]);

    // Where the scriptSig sits inside the assembled coinbase. Recovering it by
    // parsing the transaction back would mean writing a second serialiser that
    // has to agree with this one; these two numbers cannot drift.
    this.scriptSigOffset = this.coinb1.length - prefix.length;
    this.scriptSigLength = scriptSigLength;
  }

  scriptSigOf(coinbase) {
    return coinbase.subarray(this.scriptSigOffset, this.scriptSigOffset + this.scriptSigLength);
  }

  /**
   * The block as LITECOIN must receive it.
   *
   * The coinbase is re-serialised with a witness whenever the template carries
   * a witness commitment: a block committing to a witness merkle root must
   * supply the reserved value the root was computed from. The txid — and so the
   * merkle root in the header — is unchanged by this.
   */
  serializeBlock(header, coinbase) {
    const parts = [
      header,
      u.varIntBuffer(this.transactions.length + 1),
      this.witnessCommitment ? withWitness(coinbase) : coinbase,
      ...this.transactions.map((t) => Buffer.from(t, 'hex')),
    ];
    // MWEB is serialised after the transaction list behind a one-byte PRESENCE
    // FLAG, not as a bare blob. Appending the blob raw produces a block
    // litecoind rejects with "mweb-missing".
    //
    // This is not an edge case: MWEB has been active on Litecoin mainnet since
    // block 2,265,984 and getblocktemplate returns an mweb field on every
    // template after it — 167 bytes even with no MWEB activity at all. Without
    // the flag, every Litecoin block this pool ever finds is rejected, six
    // retries deep, while the Dogecoin half keeps working perfectly. That
    // asymmetry is what makes it so easy to miss.
    if (this.mweb) parts.push(Buffer.from([0x01]), Buffer.from(this.mweb, 'hex'));
    return Buffer.concat(parts).toString('hex');
  }

  /** The proof Dogecoin needs, as hex. Non-witness coinbase, deliberately. */
  auxPowHex(header, coinbase) {
    return aux
      .serializeAuxPow({
        coinbaseTx: coinbase,
        parentBlockHash: u.reverseBuffer(u.sha256d(header)).toString('hex'),
        merkleBranch: this.merkleSteps,
        parentHeader: header,
      })
      .toString('hex');
  }

  /**
   * Re-run Dogecoin's acceptance rules over what we are about to submit.
   *
   * Worth doing on every candidate because one input here is attacker-chosen:
   * extranonce2 comes from the miner, and a client that sets it to fa be 6d 6d
   * puts a second merged-mining magic in the scriptSig, which makes the proof
   * invalid by consensus. That must cost the aux submission and nothing else —
   * the Litecoin block is still perfectly good.
   */
  verifyAgainstDogecoin(header, coinbase) {
    return aux.verifyAuxPow({
      scriptSig: this.scriptSigOf(coinbase),
      auxHashHex: this.auxHash,
      chainId: DOGE_CHAIN_ID,
      coinbaseTxid: u.reverseBuffer(u.sha256d(coinbase)).toString('hex'),
      merkleBranch: this.merkleSteps,
      parentMerkleRoot: u.reverseBuffer(header.subarray(36, 68)).toString('hex'),
      parentVersion: this.version,
    });
  }
}

function output(value, script) {
  const v = Buffer.alloc(8);
  v.writeBigUInt64LE(BigInt(value));
  return Buffer.concat([v, u.varIntBuffer(script.length), script]);
}

// The same transaction with a segwit marker, flag and the coinbase's single
// witness item: 32 zero bytes, the reserved value default_witness_commitment
// assumes. Byte-identical txid, different wire form.
function withWitness(tx) {
  const version = tx.subarray(0, 4);
  const rest = tx.subarray(4);
  return Buffer.concat([
    version,
    Buffer.from([0x00, 0x01]),
    rest.subarray(0, rest.length - 4),
    u.varIntBuffer(1), u.varIntBuffer(32), Buffer.alloc(32),
    rest.subarray(rest.length - 4),
  ]);
}

module.exports = { MergedJob, withWitness, LTC_RULES, DOGE_CHAIN_ID };
