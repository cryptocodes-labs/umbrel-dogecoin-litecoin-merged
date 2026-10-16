'use strict';
//
// Pure-function checks for public merged mining — no daemon needed, so these
// run in CI. The daemon-backed proofs are test/public_aux_regtest.js,
// test/public_merged_pool.js and test/public_coexist.js.
//
// Usage: node test/public_unit.js
//

const u = require('../images/stratum/src/util');
const pm = require('../images/stratum/src/public-merged');
const { MergedJob } = require('../images/stratum/src/merged');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

console.log('\nthe fee split');
for (const v of [1, 99, 100, 101, 625000000, 1000000000000, 50000000000000]) {
  const s = pm.splitReward(v, 1);
  check(`${v}: miner + fee is exactly the value`, s.miner + s.fee === BigInt(v));
  check(`${v}: the fee is 1% rounded down`, s.fee === BigInt(v) / 100n, String(s.fee));
}
check('0% takes nothing', pm.splitReward(12345, 0).fee === 0n);
check('1.25% is exact in hundredths', pm.splitReward(10000, 1.25).fee === 125n);
check('a negative fee is refused', throwsWith(() => pm.splitReward(1, -1), /outside/));

console.log('\npublic usernames (mainnet)');
const LTC = 'LdAEjWgrrUjyV6Cy3DTKZ3uBNmG3FQhXsj';
const LTC_BECH = 'ltc1qg42tkwuuxefutzxezdkdel39gfstuap288mfea';
const DOGE = 'DFabbT3ZNZpm8UjtJkNBFbtcFvrb1kSzx9';
const p = pm.parsePublicUsername(`${LTC}.${DOGE}.rig.one`, 'ltc-main', 'main');
check('LTC.DOGE.worker parses', p.ok && p.ltcAddress === LTC && p.dogeAddress === DOGE && p.workerName === 'rig.one');
check('a bech32 LTC address is accepted', pm.parsePublicUsername(`${LTC_BECH}.${DOGE}`, 'ltc-main', 'main').ok);
check('only an LTC address is refused', !pm.parsePublicUsername(LTC, 'ltc-main', 'main').ok);
check('swapped addresses are refused', !pm.parsePublicUsername(`${DOGE}.${LTC}`, 'ltc-main', 'main').ok);
check('a typo in the DOGE address is refused',
  !pm.parsePublicUsername(`${LTC}.${DOGE.slice(0, -1)}y`, 'ltc-main', 'main').ok);

console.log('\nbech32');
check('ltc1q… decodes to P2WPKH', u.addressToScript(LTC_BECH, 'ltc-main').toString('hex') ===
  '00144554bb3b9c3653c588d9136cdcfe254260be742a');
check('upper case is the same address', u.addressToScript(LTC_BECH.toUpperCase(), 'ltc-main')
  .equals(u.addressToScript(LTC_BECH, 'ltc-main')));
check('a checksum typo is refused', throwsWith(() => u.addressToScript(LTC_BECH.slice(0, -1) + 'q', 'ltc-main'), /checksum|bech32/));
check('mixed case is refused', throwsWith(() => u.addressToScript('ltc1Qg42tkwuuxefutzxezdkdel39gfstuap288mfea', 'ltc-main'), /mixes/));
check('a Bitcoin bech32 address is not a Litecoin one', throwsWith(() =>
  u.addressToScript('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'ltc-main'), /./));
check('bech32 is never decoded on the Dogecoin chain', throwsWith(() => u.addressToScript(LTC_BECH, 'main'), /base58/));

console.log('\nthe Dogecoin aux block');
const template = {
  version: 0x620004, previousblockhash: '11'.repeat(32), height: 5000000, bits: '1a01cd2d',
  curtime: 1790000000, coinbasevalue: 1000000000000, coinbaseaux: { flags: '' },
  transactions: [{ data: '00', txid: '22'.repeat(32) }, { data: '01', txid: '33'.repeat(32) }],
};
const miner = u.addressToScript(DOGE, 'main');
const fee = u.addressToScript('D8j25uHwZgyNYiSAG3UXNHyDu1coFAxxDf', 'main');
const a1 = pm.buildAuxBlock(template, miner, fee, 1, '/t/');
const a2 = pm.buildAuxBlock(template, miner, fee, 1, '/t/');
check('it is deterministic for the same template (no needless clean_jobs)', a1.hash === a2.hash);
check('a different miner gets a different block', pm.buildAuxBlock(template, fee, fee, 1, '/t/').hash !== a1.hash);
check('the version carries the auxpow flag and chain 98', a1.header.readUInt32LE(0) === 0x620104);
check('the coinbase pays 99% then 1%', a1.minerValue === 990000000000n && a1.feeValue === 10000000000n);
check('a template without chain 98 is refused', throwsWith(() =>
  pm.buildAuxBlock({ ...template, version: 4 }, miner, fee, 1, '/t/'), /chain id/));

console.log('\nthe Litecoin coinbase');
const ltcTemplate = {
  version: 0x20000000, previousblockhash: '44'.repeat(32), height: 3000000, bits: '1a01cd2d',
  curtime: 1790000000, mintime: 1, coinbasevalue: 625000000, coinbaseaux: { flags: '' }, transactions: [],
};
const ltcMiner = u.addressToScript(LTC, 'ltc-main');
const privJob = new MergedJob('01', ltcTemplate, ltcMiner, '/t/', a1);
const privOut = Buffer.concat([Buffer.from('40be402500000000', 'hex'), Buffer.from([ltcMiner.length]), ltcMiner]);
check('without a fee the coinbase has the single output it always had',
  privJob.coinb2.toString('hex').includes(`01${privOut.toString('hex')}00000000`));
const pubJob = new MergedJob('01', ltcTemplate, ltcMiner, '/t/', a1, { fee: { script: fee, percent: 1 } });
check('with a fee it pays the miner 99%', pubJob.minerValue === 618750000n);
check('and the pool 1%', pubJob.feeValue === 6250000n);
check('the fee output is in the coinbase', pubJob.coinb2.toString('hex').includes(fee.toString('hex')));

console.log(failures === 0 ? '\nPUBLIC UNIT VERIFIED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
