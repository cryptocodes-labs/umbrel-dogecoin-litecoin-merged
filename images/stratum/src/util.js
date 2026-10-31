'use strict';
//
// Low-level Bitcoin/Dogecoin serialisation helpers.
//
// Everything here is deliberately dependency-free and side-effect-free so it can
// be unit-tested in isolation, which matters more than usual: a one-byte mistake
// in any of these functions produces a block the network silently rejects, and
// you only find out on the day you actually win one.
//

const crypto = require('node:crypto');

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// --------------------------------------------------------------------------
// hashing
// --------------------------------------------------------------------------

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function sha256d(buf) {
  return sha256(sha256(buf));
}

// Litecoin/Dogecoin proof-of-work: scrypt(N=1024, r=1, p=1), with the 80-byte
// header used as BOTH password and salt, producing 32 bytes.
//
// Node's built-in crypto does exactly this, so we need no native module. The
// default maxmem (32 MB) is comfortably above the 128 * N * r = 128 KiB this
// needs, but we set it explicitly so a future Node default can't break us.
const SCRYPT_PARAMS = { N: 1024, r: 1, p: 1, maxmem: 1024 * 1024 };

function scryptHash(header) {
  return crypto.scryptSync(header, header, 32, SCRYPT_PARAMS);
}

// The asynchronous form runs on libuv's thread pool instead of the event loop.
// Share verification is deliberately expensive, and anyone who can reach the
// stratum port can ask for it: on the main thread that same thread is what
// dispatches submitblock when a real block turns up.
function scryptHashAsync(header) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(header, header, 32, SCRYPT_PARAMS, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

// --------------------------------------------------------------------------
// byte order
// --------------------------------------------------------------------------

function reverseBuffer(buf) {
  return Buffer.from(buf).reverse();
}

function reverseHex(hex) {
  return reverseBuffer(Buffer.from(hex, 'hex')).toString('hex');
}

// Stratum sends prevhash as the 32-byte hash with each 4-byte word byte-swapped
// and then the whole thing reversed. This is not a sane format; it is simply
// the format every miner in existence expects, inherited from the original
// pool implementations.
function reverseByteOrder(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i < 8; i++) {
    out.writeUInt32LE(out.readUInt32BE(i * 4), i * 4);
  }
  return reverseBuffer(out);
}

// --------------------------------------------------------------------------
// varint / varstring
// --------------------------------------------------------------------------

function varIntBuffer(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  if (n <= 0xffffffff) {
    const b = Buffer.alloc(5);
    b[0] = 0xfe;
    b.writeUInt32LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0xff;
  b.writeBigUInt64LE(BigInt(n), 1);
  return b;
}

// Minimally-encoded signed script number, as the coinbase height push (BIP34)
// requires. The high-bit rule matters: a height whose top byte is >= 0x80 needs
// an extra zero byte or the script reads it as negative and the block is
// invalid. Dogecoin passed that threshold long ago, so this path is live, not
// theoretical.
function serializeScriptNumber(n) {
  if (n === 0) return Buffer.alloc(0);
  const bytes = [];
  let v = Math.abs(n);
  while (v > 0) {
    bytes.push(v & 0xff);
    v = Math.floor(v / 256);
  }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00);
  return Buffer.from(bytes);
}

// The BIP34 coinbase height, encoded exactly as Dogecoin Core writes it.
//
// Verified against the consensus check itself. src/validation.cpp builds the
// expected prefix as `CScript expect = CScript() << nHeight;` and requires the
// coinbase scriptSig to start with those exact bytes; src/script/script.h
// push_int64() emits a SINGLE opcode for small numbers:
//
//     if (n == -1 || (n >= 1 && n <= 16)) push_back(n + (OP_1 - 1));
//     else if (n == 0)                    push_back(OP_0);
//     else                                *this << CScriptNum::serialize(n);
//
// So heights 1..16 are OP_1..OP_16 (0x51..0x60), height 0 is OP_0, and only
// from 17 upwards is it a length-prefixed push. Encoding height 3 as the data
// push `01 03` instead of `OP_3` produces a block Dogecoin rejects with
// bad-cb-height. Mainnet passed 16 in 2013, so this only bites on a fresh
// regtest chain — but it is a consensus rule, and matching it costs three
// lines.
function coinbaseHeightScript(height) {
  if (height === 0) return Buffer.from([0x00]); // OP_0
  if (height >= 1 && height <= 16) return Buffer.from([0x50 + height]); // OP_1..OP_16
  return scriptPush(serializeScriptNumber(height));
}

// A script data push of `buf`, using the smallest legal opcode.
function scriptPush(buf) {
  if (buf.length < 0x4c) return Buffer.concat([Buffer.from([buf.length]), buf]);
  if (buf.length <= 0xff) {
    return Buffer.concat([Buffer.from([0x4c, buf.length]), buf]);
  }
  const len = Buffer.alloc(2);
  len.writeUInt16LE(buf.length, 0);
  return Buffer.concat([Buffer.from([0x4d]), len, buf]);
}

// --------------------------------------------------------------------------
// base58check addresses
// --------------------------------------------------------------------------

function base58Decode(str) {
  if (typeof str !== 'string' || str.length === 0) {
    throw new Error('address is empty');
  }
  let num = 0n;
  for (const ch of str) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`illegal base58 character ${JSON.stringify(ch)}`);
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let bytes = Buffer.from(hex, 'hex');
  // Leading '1' characters encode leading zero bytes, which the bignum loses.
  let leading = 0;
  while (leading < str.length && str[leading] === '1') leading++;
  if (leading > 0) bytes = Buffer.concat([Buffer.alloc(leading), bytes]);
  return bytes;
}

// Version bytes per network. Dogecoin regtest inherits Bitcoin's testnet
// prefixes rather than Dogecoin's own testnet ones — verified empirically
// against dogecoind 1.14.9, not assumed.
const ADDRESS_VERSIONS = {
  // Dogecoin.
  main: { p2pkh: [0x1e], p2sh: [0x16] },
  test: { p2pkh: [0x71], p2sh: [0xc4] },
  regtest: { p2pkh: [0x6f, 0x71], p2sh: [0xc4] },
  // Litecoin, for merged mining: the parent block pays a Litecoin address, and
  // paying it to a Dogecoin-shaped script would make the parent block invalid
  // on its own chain — the half of the reward that is easiest to lose silently.
  // 0x32 is the modern P2SH prefix (M...), 0x05 the legacy one (3...), which
  // Litecoin still accepts.
  'ltc-main': { p2pkh: [0x30], p2sh: [0x32, 0x05] },
  'ltc-test': { p2pkh: [0x6f], p2sh: [0x3a, 0xc4] },
  'ltc-regtest': { p2pkh: [0x6f], p2sh: [0x3a, 0xc4] },
  // Pepecoin, a further aux chain: src/chainparams.cpp (1.1.0) base58Prefixes.
  // 56 is "P" on mainnet; regtest uses 111/196 like Bitcoin's testnet.
  'pep-main': { p2pkh: [0x38], p2sh: [0x16] },
  'pep-test': { p2pkh: [0x71], p2sh: [0xc4] },
  'pep-regtest': { p2pkh: [0x6f], p2sh: [0xc4] },
};

// Litecoin native segwit (BIP173): ltc1… on mainnet. Most Litecoin wallets
// hand these out by default, so a public port that only took L…/M… addresses
// would turn most miners away. Dogecoin has no segwit and no entry here, so the
// Dogecoin path cannot reach the decoder at all.
const BECH32_HRP = { 'ltc-main': 'ltc', 'ltc-test': 'tltc', 'ltc-regtest': 'rltc' };
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

// Witness version 0 only (P2WPKH, P2WSH), with the original bech32 checksum.
// Anything else is refused rather than guessed at: a v1+ output built from a
// mis-decoded program is exactly the unspendable reward this function exists
// to prevent, and a miner with such an address can use another one.
function segwitToScript(address, hrp) {
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) {
    throw new Error('bech32 address mixes upper and lower case');
  }
  const addr = address.toLowerCase();
  const pos = addr.lastIndexOf('1');
  if (pos < 1 || pos + 7 > addr.length || addr.length > 90) throw new Error('bech32 address is malformed');
  if (addr.slice(0, pos) !== hrp) throw new Error(`bech32 prefix ${addr.slice(0, pos)} is not ${hrp}`);
  const data = [];
  for (const ch of addr.slice(pos + 1)) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v < 0) throw new Error(`illegal bech32 character ${JSON.stringify(ch)}`);
    data.push(v);
  }
  const hrpExpand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const check = bech32Polymod(hrpExpand.concat(data));
  const version = data[0];
  if (version !== 0) throw new Error(`segwit version ${version} addresses are not supported, use a v0 (ltc1q…) or legacy address`);
  if (check !== 1) throw new Error('bech32 checksum is wrong (typo?)');
  // 5-bit groups back to bytes, strict: no leftover bits beyond padding.
  let acc = 0; let bits = 0; const prog = [];
  for (const v of data.slice(1, -6)) {
    acc = (acc << 5) | v; bits += 5;
    while (bits >= 8) { bits -= 8; prog.push((acc >> bits) & 0xff); }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff)) throw new Error('bech32 address has invalid padding');
  if (prog.length !== 20 && prog.length !== 32) throw new Error(`witness program is ${prog.length} bytes, expected 20 or 32`);
  return Buffer.concat([Buffer.from([0x00, prog.length]), Buffer.from(prog)]);
}

// Soqucoin: Bech32m (BIP350), witness version 1, a 32-byte program — sq1p… on
// mainnet, testnet and regtest alike, ssq1p… on stagenet (soqucoin
// doc/pool-integration.md, "Address Format"). The program is the SHA-256 of an
// ML-DSA-44 public key and the output is OP_1 <32 bytes>. That is the only form
// accepted here, and deliberately so: soqucoind's createauxblock falls back to
// a legacy Base58 address, which the script layer cannot spend — Soqucoin's own
// guide says never to pay one — so this check is what refuses it.
const SOQ_HRP = { 'soq-main': 'sq', 'soq-test': 'sq', 'soq-regtest': 'sq', 'soq-stagenet': 'ssq' };
const BECH32M_CONST = 0x2bc830a3;

function soqAddressToScript(address, hrp) {
  if (typeof address !== 'string') throw new Error('a Soqucoin address must be a string');
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) {
    throw new Error('bech32m address mixes upper and lower case');
  }
  const addr = address.toLowerCase();
  const pos = addr.lastIndexOf('1');
  if (pos < 1 || pos + 7 > addr.length || addr.length > 90) throw new Error('not a bech32m address (sq1p…)');
  if (addr.slice(0, pos) !== hrp) throw new Error(`bech32m prefix ${addr.slice(0, pos)} is not ${hrp}`);
  const data = [];
  for (const ch of addr.slice(pos + 1)) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v < 0) throw new Error(`illegal bech32m character ${JSON.stringify(ch)}`);
    data.push(v);
  }
  const hrpExpand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  if (bech32Polymod(hrpExpand.concat(data)) !== BECH32M_CONST) throw new Error('bech32m checksum is wrong (typo?)');
  if (data[0] !== 1) throw new Error(`witness version ${data[0]} is not a Soqucoin payment address; use an ${hrp}1p… address`);
  let acc = 0; let bits = 0; const prog = [];
  for (const v of data.slice(1, -6)) {
    acc = (acc << 5) | v; bits += 5;
    while (bits >= 8) { bits -= 8; prog.push((acc >> bits) & 0xff); }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff)) throw new Error('bech32m address has invalid padding');
  if (prog.length !== 32) throw new Error(`witness program is ${prog.length} bytes, expected 32`);
  return Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.from(prog)]);
}

// Returns the scriptPubKey that a coinbase output must carry to pay `address`.
// Throws with a human-readable reason on anything suspicious — this function is
// the last line of defence against mining a block whose reward is unspendable.
function addressToScript(address, chain = 'main') {
  if (SOQ_HRP[chain]) return soqAddressToScript(address, SOQ_HRP[chain]);
  const hrp = BECH32_HRP[chain];
  if (hrp && typeof address === 'string' && address.toLowerCase().startsWith(`${hrp}1`)) {
    return segwitToScript(address, hrp);
  }
  const versions = ADDRESS_VERSIONS[chain] || ADDRESS_VERSIONS.main;
  const decoded = base58Decode(address);
  if (decoded.length !== 25) {
    throw new Error(`address decodes to ${decoded.length} bytes, expected 25`);
  }
  const body = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const expected = sha256d(body).subarray(0, 4);
  if (!checksum.equals(expected)) {
    throw new Error('address checksum is wrong (typo?)');
  }
  const version = body[0];
  const hash160 = body.subarray(1);

  if (versions.p2pkh.includes(version)) {
    // OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
    return Buffer.concat([
      Buffer.from([0x76, 0xa9, 0x14]),
      hash160,
      Buffer.from([0x88, 0xac]),
    ]);
  }
  if (versions.p2sh.includes(version)) {
    // OP_HASH160 <20 bytes> OP_EQUAL
    return Buffer.concat([
      Buffer.from([0xa9, 0x14]),
      hash160,
      Buffer.from([0x87]),
    ]);
  }
  throw new Error(
    `address version byte 0x${version.toString(16)} is not valid on ${chain}`
  );
}

// --------------------------------------------------------------------------
// merkle
// --------------------------------------------------------------------------

// The stratum merkle branch: the sibling hashes a miner needs in order to
// recompute the root from its own coinbase. Input txids must already be in
// internal (little-endian) byte order.
function merkleSteps(txHashes) {
  const steps = [];
  // A placeholder for the coinbase, whose hash the miner supplies.
  let layer = [null, ...txHashes];
  while (layer.length > 1) {
    steps.push(layer[1]);
    const next = [];
    // Start at index 0 with the placeholder; pair up the rest.
    for (let i = 0; i < layer.length; i += 2) {
      if (i === 0) {
        next.push(null);
        continue;
      }
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : left;
      next.push(sha256d(Buffer.concat([left, right])));
    }
    layer = next;
  }
  return steps;
}

function merkleRootFromSteps(coinbaseHash, steps) {
  let root = coinbaseHash;
  for (const step of steps) {
    root = sha256d(Buffer.concat([root, step]));
  }
  return root;
}

// --------------------------------------------------------------------------
// difficulty / targets
// --------------------------------------------------------------------------

// Consensus difficulty-1 target. Dogecoin, like Litecoin, reports network
// difficulty against the same constant Bitcoin uses, so nBits and
// getdifficulty live in this space.
const DIFF1 = 0xffffn * (1n << 208n);

// Stratum share difficulty for scrypt does NOT live in that space. Every piece
// of scrypt mining software applies a factor of 2^16, so "difficulty 1" on the
// wire means a target 65536x easier than Bitcoin's difficulty 1. Verified in
// the original sources rather than assumed:
//
//   cgminer v3.7.2, set_target():        if (opt_scrypt) d64 *= (double)65536;
//   pooler/cpuminer, stratum_gen_work(): diff_to_target(work->target,
//                                            sctx->job.diff / 65536.0);
//   node-stratum-pool algoProperties:    scrypt: { multiplier: Math.pow(2,16) }
//   Miningcore coins.json (litecoin,
//     dogecoin):                         "shareMultiplier": 65536
//   p2pool litecoin.py:                  DUMB_SCRYPT_DIFF = 2**16
//
// Getting this wrong does not fail loudly: miners connect, hash correctly, and
// submit shares 65536x less often than they should.
const SCRYPT_SHARE_MULTIPLIER = 65536n;

function targetFromBits(bitsHex) {
  const bits = parseInt(bitsHex, 16);
  const exponent = bits >>> 24;
  const mantissa = BigInt(bits & 0x00ffffff);
  return mantissa * (1n << BigInt(8 * (exponent - 3)));
}

// Consensus-space difficulty -> target. Used for network difficulty only.
function targetFromDifficulty(difficulty) {
  if (!(difficulty > 0)) throw new Error('difficulty must be positive');
  // Scale first so fractional difficulties survive the integer division.
  const scaled = BigInt(Math.round(difficulty * 4294967296));
  return (DIFF1 * 4294967296n) / scaled;
}

// Stratum-space share difficulty -> target, for scrypt.
function targetFromShareDifficulty(difficulty) {
  if (!(difficulty > 0)) throw new Error('share difficulty must be positive');
  const scaled = BigInt(Math.round(difficulty * 4294967296));
  return (DIFF1 * SCRYPT_SHARE_MULTIPLIER * 4294967296n) / scaled;
}

// Expected hashes to find one share at a given stratum difficulty. With the
// 2^16 multiplier this is D * 2^16, not D * 2^32 — the difference between a
// plausible hashrate reading and one that is off by four orders of magnitude.
const HASHES_PER_SHARE_UNIT = 65536;

function difficultyFromTarget(target) {
  if (target <= 0n) return Infinity;
  // Scale by 10^18 before the integer division. 10^6 is not enough: a target
  // easier than difficulty 1 — regtest's, and every share target — truncates
  // to zero, which then reads as "no difficulty" all the way up into the UI.
  return Number((DIFF1 * 1000000000000000000n) / target) / 1e18;
}

function bufferToBigInt(buf) {
  return BigInt('0x' + buf.toString('hex'));
}

module.exports = {
  sha256,
  sha256d,
  scryptHash,
  scryptHashAsync,
  reverseBuffer,
  reverseHex,
  reverseByteOrder,
  varIntBuffer,
  serializeScriptNumber,
  coinbaseHeightScript,
  scriptPush,
  base58Decode,
  addressToScript,
  merkleSteps,
  merkleRootFromSteps,
  targetFromBits,
  targetFromDifficulty,
  targetFromShareDifficulty,
  difficultyFromTarget,
  bufferToBigInt,
  DIFF1,
  SCRYPT_SHARE_MULTIPLIER,
  HASHES_PER_SHARE_UNIT,
  ADDRESS_VERSIONS,
  SOQ_HRP,
};
