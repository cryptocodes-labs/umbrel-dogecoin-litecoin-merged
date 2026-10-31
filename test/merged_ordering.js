'use strict';
//
// Template ordering in merged mode.
//
// The poll and the longpoll both refresh the job and neither awaits the other,
// so an RPC that stalls can deliver its answer after a newer one has already
// been applied. onMergedTemplate decides whether a job is new by comparing the
// previous-block hash for INEQUALITY, so a late answer describing the previous
// tip reads as "new block": it would be installed as the current job and
// broadcast with clean_jobs, putting every miner back on an orphaned Litecoin
// parent until the next refresh. Dogecoin submissions would keep working —
// Dogecoin never validates the parent chain — so nothing on the dashboard
// would look wrong while the Litecoin half mined a dead branch.
//
// Moving the poll from 5s to 2s made that window roughly 2.5x more likely,
// which is why the guard exists. These checks drive onMergedTemplate directly
// with hand-built templates, because reproducing the interleaving against a
// real node is timing-dependent and would pass by luck.
//

const { Pool } = require('../images/stratum/src/pool');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const script = Buffer.concat([
  Buffer.from([0x76, 0xa9, 0x14]), Buffer.alloc(20, 7), Buffer.from([0x88, 0xac]),
]);

function template(height, prevHex) {
  return {
    version: 0x20000000,
    previousblockhash: prevHex.repeat(32),
    curtime: 1786000000,
    mintime: 1785999000,
    bits: '207fffff',
    height,
    coinbasevalue: 625000000,
    target: '7fffff' + '00'.repeat(29),
    transactions: [],
  };
}

function auxBlock(height, hashHex) {
  return {
    hash: hashHex.repeat(32),
    chainid: 98,
    bits: '1a01b7d1',
    height,
    coinbasevalue: 1000000000000,
    previousblockhash: 'ef'.repeat(32),
  };
}

// The smallest object onMergedTemplate needs. Using the real prototype method
// rather than a copy of its logic: a test that reimplements the branch it is
// checking cannot catch the branch being deleted.
function makePool() {
  const sent = [];
  return {
    jobs: new Map(),
    // One authorized client, so the broadcast path is actually walked. With an
    // empty map sendJob is never called and a check on what miners received
    // passes no matter what the code does.
    clients: new Map([['c1', { authorized: true }]]),
    currentJob: null,
    jobCounter: 0,
    merged: true,
    ltcPayoutScript: script,
    config: { coinbaseTag: '/t/', jobRebuildMs: 30000 },
    sent,
    log() {},
    recordNetworkDifficulty() {},
    recordChainDifficulties() {},
    sendJob(client, job, isNew) { sent.push({ id: job.id, isNew }); },
    apply(t, a, reason, askedAt) {
      return Pool.prototype.onMergedTemplate.call(this, t, a, reason, askedAt);
    },
  };
}

console.log('\nordering');
{
  const p = makePool();
  // t=1000: the tip is Litecoin 100 / Dogecoin 500.
  p.apply(template(100, 'aa'), auxBlock(500, 'cc'), 'poll', 1000);
  const first = p.currentJob;
  check('the first template is installed', first && first.height === 100,
    first ? String(first.height) : 'no job');

  // t=2000: a newer fetch moves both chains on.
  p.apply(template(101, 'bb'), auxBlock(501, 'dd'), 'longpoll', 2000);
  check('a newer template replaces it', p.currentJob.height === 101, String(p.currentJob.height));

  // A poll that STARTED at t=1500 — before the fetch that produced the current
  // job — finally answers, still describing height 100. This is the race.
  p.apply(template(100, 'aa'), auxBlock(500, 'cc'), 'poll', 1500);
  check('a late answer does not drag the parent back a block',
    p.currentJob.height === 101, `job is at Litecoin height ${p.currentJob.height}`);
  check('and it is not broadcast to miners',
    p.sent.filter((s) => s.isNew).length === 2, `${p.sent.filter((s) => s.isNew).length} new-job sends`);
}

console.log('\nthe aux chain alone can also regress');
{
  const p = makePool();
  p.apply(template(100, 'aa'), auxBlock(500, 'cc'), 'poll', 1000);
  p.apply(template(100, 'aa'), auxBlock(501, 'dd'), 'poll', 2000);
  check('a newer aux block on the same parent is installed',
    p.currentJob.auxHeight === 501, String(p.currentJob.auxHeight));
  p.apply(template(100, 'aa'), auxBlock(500, 'cc'), 'poll', 1500);
  check('a late answer does not drag Dogecoin back a block',
    p.currentJob.auxHeight === 501, `aux height ${p.currentJob.auxHeight}`);
}

console.log('\nwhat must still get through');
{
  const p = makePool();
  p.apply(template(100, 'aa'), auxBlock(500, 'cc'), 'poll', 1000);
  // A real reorg: the chain genuinely moves to a LOWER height, and the answer
  // comes from a fetch started after the current job's. Dropping this would be
  // worse than the bug — the pool would keep mining a chain the network left.
  p.apply(template(99, 'ee'), auxBlock(500, 'cc'), 'longpoll', 3000);
  check('a genuine reorg to a lower height is accepted',
    p.currentJob.height === 99, String(p.currentJob.height));
}
{
  const p = makePool();
  p.apply(template(100, 'aa'), auxBlock(500, 'cc'), 'poll', 1000);
  // Same height, later fetch, more fee income: a rebuild, not a regression.
  const richer = template(100, 'aa');
  richer.coinbasevalue = 625000001;
  p.apply(richer, auxBlock(500, 'cc'), 'poll', 2000);
  check('a same-height rebuild with a higher reward is accepted',
    p.currentJob.coinbaseValue === 625000001, String(p.currentJob.coinbaseValue));
}
{
  const p = makePool();
  p.apply(template(100, 'aa'), auxBlock(500, 'cc'), 'poll', 1000);
  // An out-of-order answer that does NOT regress anything is harmless and must
  // not be dropped — dropping every late answer would throw away work on a
  // chain that has not moved.
  const richer = template(100, 'aa');
  richer.coinbasevalue = 625000002;
  p.apply(richer, auxBlock(500, 'cc'), 'poll', 900);
  check('a late answer at the same height still counts',
    p.currentJob.coinbaseValue === 625000002, String(p.currentJob.coinbaseValue));
}

console.log(failures === 0 ? '\nTEMPLATE ORDERING VERIFIED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
