'use strict';
//
// Turns a getblocktemplate response into a stratum job, and turns a miner's
// share submission back into a candidate block.
//
// The two directions have to agree byte for byte. Every field below is
// constructed explicitly rather than copied from an existing pool codebase,
// and the whole thing is verified end to end by actually mining regtest blocks
// in the test suite — the only test that really proves it.
//

const u = require('./util');

// Bytes each side contributes to the coinbase extranonce. The server owns
// extranonce1 (unique per connection), the miner owns extranonce2 (it rolls
// this to search more space than the 32-bit nonce allows).
const EXTRANONCE1_SIZE = 4;
const EXTRANONCE2_SIZE = 4;

// Upper bound on remembered submissions per job. A worker at one share every
// few seconds produces a handful per job; this leaves four orders of magnitude
// of headroom while keeping the set's worst case around a megabyte.
const MAX_SUBMISSIONS_PER_JOB = 50000;

class Job {
  /**
   * @param {string} id          job id handed to miners
   * @param {object} template    raw getblocktemplate result
   * @param {Buffer} payoutScript scriptPubKey the block reward pays to
   * @param {string} tag         short marker embedded in the coinbase
   * @param {object} opts        subclass data. Assigned BEFORE _buildCoinbase
   *                             runs, because that call happens inside this
   *                             constructor and a subclass's own field
   *                             initialisers do not run until after it — so an
   *                             override reading `this.something` would see
   *                             undefined. MergedJob needs the aux block here.
   */
  constructor(id, template, payoutScript, tag = '/umbrel-doge-solo/', opts = {}) {
    this.id = id;
    this.opts = opts;
    this.template = template;
    this.height = template.height;
    this.createdAt = Date.now();
    this.submissions = new Set();

    this.version = template.version;
    this.bits = template.bits;
    this.curtime = template.curtime;
    this.mintime = template.mintime;
    this.networkTarget = template.target
      ? BigInt('0x' + template.target)
      : u.targetFromBits(template.bits);
    this.networkDifficulty = u.difficultyFromTarget(this.networkTarget);
    this.coinbaseValue = template.coinbasevalue;

    this.prevHashInternal = u.reverseBuffer(
      Buffer.from(template.previousblockhash, 'hex')
    );
    this.prevHashStratum = u
      .reverseByteOrder(Buffer.from(template.previousblockhash, 'hex'))
      .toString('hex');

    this.transactions = (template.transactions || []).map((t) => t.data);
    const txHashes = (template.transactions || []).map((t) =>
      // getblocktemplate reports txid in display (big-endian) order; the merkle
      // tree works on internal order.
      u.reverseBuffer(Buffer.from(t.txid || t.hash, 'hex'))
    );
    this.merkleSteps = u.merkleSteps(txHashes);
    this.merkleStepsHex = this.merkleSteps.map((s) => s.toString('hex'));

    this._buildCoinbase(payoutScript, tag);
  }

  _buildCoinbase(payoutScript, tag) {
    // BIP34: the coinbase scriptSig must begin with a push of the block height.
    const heightPush = u.coinbaseHeightScript(this.height);
    const auxFlags = Buffer.from(
      (this.template.coinbaseaux && this.template.coinbaseaux.flags) || '',
      'hex'
    );
    const tagBytes = Buffer.from(tag, 'utf8');

    const scriptSigLength =
      heightPush.length +
      auxFlags.length +
      EXTRANONCE1_SIZE +
      EXTRANONCE2_SIZE +
      tagBytes.length;

    // Consensus bounds. Falling outside them makes every block we ever mine
    // invalid, so refuse loudly at startup rather than quietly at payday.
    if (scriptSigLength < 2 || scriptSigLength > 100) {
      throw new Error(
        `coinbase scriptSig would be ${scriptSigLength} bytes; must be 2..100`
      );
    }

    this.coinb1 = Buffer.concat([
      Buffer.from('01000000', 'hex'), // tx version
      u.varIntBuffer(1), // input count
      Buffer.alloc(32), // null prevout hash
      Buffer.from('ffffffff', 'hex'), // null prevout index
      u.varIntBuffer(scriptSigLength),
      heightPush,
      auxFlags,
      // extranonce1 + extranonce2 are spliced in here by the miner
    ]);

    const outputs = Buffer.concat([
      (() => {
        const v = Buffer.alloc(8);
        v.writeBigUInt64LE(BigInt(this.coinbaseValue));
        return v;
      })(),
      u.varIntBuffer(payoutScript.length),
      payoutScript,
    ]);

    this.coinb2 = Buffer.concat([
      tagBytes,
      Buffer.from('ffffffff', 'hex'), // sequence
      u.varIntBuffer(1), // output count
      outputs,
      Buffer.from('00000000', 'hex'), // locktime
    ]);
  }

  /** Parameters for mining.notify. */
  notifyParams(cleanJobs) {
    return [
      this.id,
      this.prevHashStratum,
      this.coinb1.toString('hex'),
      this.coinb2.toString('hex'),
      this.merkleStepsHex,
      toHex32(this.version),
      this.bits,
      toHex32(this.curtime),
      cleanJobs,
    ];
  }

  buildCoinbase(extranonce1, extranonce2) {
    return Buffer.concat([this.coinb1, extranonce1, extranonce2, this.coinb2]);
  }

  buildHeader(merkleRoot, ntime, nonce) {
    const header = Buffer.alloc(80);
    header.writeInt32LE(this.version, 0);
    this.prevHashInternal.copy(header, 4);
    merkleRoot.copy(header, 36);
    header.writeUInt32LE(ntime, 68);
    header.writeUInt32LE(parseInt(this.bits, 16), 72);
    header.writeUInt32LE(nonce, 76);
    return header;
  }

  /** Full serialised block, ready for submitblock. */
  serializeBlock(header, coinbase) {
    return Buffer.concat([
      header,
      u.varIntBuffer(this.transactions.length + 1),
      coinbase,
      ...this.transactions.map((t) => Buffer.from(t, 'hex')),
    ]).toString('hex');
  }
}

function toHex32(n) {
  return (n >>> 0).toString(16).padStart(8, '0');
}

/**
 * Validate a submitted share.
 *
 * Returns {ok:false, reason} for a rejected share, or
 * {ok:true, shareDiff, isBlockCandidate, blockHex, blockHash, header}.
 *
 * Deliberately strict: every rejection reason is distinct so a misconfigured
 * miner is diagnosable from the dashboard rather than showing up as a silent
 * hashrate shortfall.
 */
// Everything up to the proof-of-work hash. Split out so the synchronous and
// asynchronous entry points cannot drift apart.
function prepareShare(job, {
  extranonce1,
  extranonce2Hex,
  ntimeHex,
  nonceHex,
}) {
  if (typeof extranonce2Hex !== 'string' ||
      extranonce2Hex.length !== EXTRANONCE2_SIZE * 2 ||
      !/^[0-9a-fA-F]+$/.test(extranonce2Hex)) {
    return { ok: false, reason: 'malformed extranonce2' };
  }
  if (typeof ntimeHex !== 'string' || !/^[0-9a-fA-F]{8}$/.test(ntimeHex)) {
    return { ok: false, reason: 'malformed ntime' };
  }
  if (typeof nonceHex !== 'string' || !/^[0-9a-fA-F]{8}$/.test(nonceHex)) {
    return { ok: false, reason: 'malformed nonce' };
  }

  const ntime = parseInt(ntimeHex, 16);
  if (ntime < job.mintime) {
    return { ok: false, reason: 'ntime below mintime' };
  }
  // Bound this at the CONSENSUS limit — two hours ahead of now — and not at
  // something tighter like the template's curtime plus a few minutes.
  //
  // A tighter rule silently throws away winning blocks. If the node stops
  // answering, the template freezes while miners keep rolling ntime against
  // their own clocks; after a few minutes every share is refused locally,
  // including one that met the network target. Outside these bounds the block
  // really would be invalid, so nothing valid can be lost here.
  //
  // Note this is checked against OUR wall clock, which is why it does not
  // reject outright: the flag is carried through and only applied in
  // judgeShare, after the proof of work is known. A container whose clock runs
  // behind the miner's would otherwise discard a share that consensus accepts
  // — and if that share met the network target, the block would be gone
  // without ever having been hashed.
  const ntimeTooFarAhead = ntime > Math.floor(Date.now() / 1000) + 7200;

  const nonce = parseInt(nonceHex, 16);
  const dedupeKey = `${extranonce1.toString('hex')}:${extranonce2Hex}:${ntimeHex}:${nonceHex}`;
  if (job.submissions.has(dedupeKey)) {
    return { ok: false, reason: 'duplicate share' };
  }
  // The duplicate-detection set is filled by whoever is connected, so it needs a
  // ceiling or it becomes an unbounded allocation any LAN client can drive.
  // Well past what honest miners produce for one job; beyond it we stop
  // recording rather than stop working, accepting that a replay could slip
  // through — which costs nothing, since a duplicate share earns nothing.
  if (job.submissions.size < MAX_SUBMISSIONS_PER_JOB) {
    job.submissions.add(dedupeKey);
  }

  const coinbase = job.buildCoinbase(
    extranonce1,
    Buffer.from(extranonce2Hex, 'hex')
  );
  const coinbaseHash = u.sha256d(coinbase);
  const merkleRoot = u.merkleRootFromSteps(coinbaseHash, job.merkleSteps);
  const header = job.buildHeader(merkleRoot, ntime, nonce);

  return { ok: true, coinbase, header, ntimeTooFarAhead };
}

// Turn a proof-of-work hash into a verdict. `shareTargets` may hold more than
// one acceptable target so a difficulty increase does not reject work the miner
// had already been handed.
function judgeShare(job, prepared, powHash, shareTargets) {
  const { header, coinbase } = prepared;
  // Hashes are compared as little-endian integers.
  const powValue = u.bufferToBigInt(u.reverseBuffer(powHash));
  const shareDiff = u.difficultyFromTarget(powValue === 0n ? 1n : powValue);

  const isBlockCandidate = powValue <= job.networkTarget;
  // Merged mining: the same hash is judged against the aux chain's target as
  // well, and the two are independent — Dogecoin's is usually the harder one,
  // but which one a given share meets is decided per share, not per job.
  // Undefined outside merged mode, so this is dead weight in the Dogecoin-only
  // path rather than a change to it.
  const isAuxCandidate = job.auxTarget != null && powValue <= job.auxTarget;
  // Further aux chains merge-mined beside Dogecoin (MergedJob.extraAux), each
  // against its own target. An empty list everywhere else, so every check
  // below reads exactly as it did with Dogecoin alone.
  const extraAuxCandidates =
    job.extraAux && job.extraAux.length ? job.extraAuxCandidates(powValue) : [];
  const isAnyAuxCandidate = isAuxCandidate || extraAuxCandidates.length > 0;
  const targets = Array.isArray(shareTargets) ? shareTargets : [shareTargets];
  const meetsShareTarget = targets.some((t) => t != null && powValue <= t);

  // The ntime bound is applied HERE, after the work is known, and never to a
  // block candidate. If the hash meets the network target, the node is the
  // right authority on whether the timestamp is acceptable — not this
  // container's clock, which may simply be running behind the miner's.
  // Anything else risks throwing a real block away over a few seconds of drift.
  if (prepared.ntimeTooFarAhead && !isBlockCandidate && !isAnyAuxCandidate) {
    return { ok: false, reason: 'ntime beyond the 2-hour consensus limit', shareDiff };
  }

  if (!isBlockCandidate && !isAnyAuxCandidate && !meetsShareTarget) {
    return { ok: false, reason: 'low difficulty share', shareDiff };
  }

  return {
    ok: true,
    shareDiff,
    isBlockCandidate,
    isAuxCandidate,
    extraAuxCandidates,
    header,
    // The parent coinbase, needed to assemble the auxpow proof. Carried only
    // when something is going to be submitted; a share is a hot path and this
    // is a live reference into the buffers the validator just built.
    coinbase: isBlockCandidate || isAnyAuxCandidate ? coinbase : null,
    blockHex: isBlockCandidate ? job.serializeBlock(header, coinbase) : null,
    blockHash: u.reverseBuffer(u.sha256d(header)).toString('hex'),
  };
}

/** Synchronous validation. Convenient for tests; the server uses the async form. */
function validateShare(job, params) {
  const prepared = prepareShare(job, params);
  if (!prepared.ok) return prepared;
  return judgeShare(job, prepared, u.scryptHash(prepared.header), params.shareTarget);
}

/** Validation with the scrypt hash on the thread pool instead of the event loop. */
async function validateShareAsync(job, params) {
  const prepared = prepareShare(job, params);
  if (!prepared.ok) return prepared;
  const powHash = await u.scryptHashAsync(prepared.header);
  return judgeShare(job, prepared, powHash, params.shareTarget);
}

module.exports = {
  Job,
  validateShare,
  validateShareAsync,
  // Exported so the verdict logic can be tested directly: the branch that
  // decides whether a block candidate survives an out-of-bounds ntime is not
  // reachable through a real miner without a wrong clock.
  prepareShare,
  judgeShare,
  EXTRANONCE1_SIZE,
  EXTRANONCE2_SIZE,
};
