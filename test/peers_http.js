'use strict';
//
// PEER_POOLS: this app reading the other pool containers on the same Umbrel,
// so umbrelOS's widgets show every LTC + DOGE port, not only the private one.
//
// Two fake peers stand in for doge-public and doge-public-rental: one answers
// like a 1.9.0 pool (with `chains`), one like a 1.8.1 pool (without), and a
// third label points at a port where nothing listens. The app itself runs
// with no node at all, as in health_http.js.
//
// What is checked:
//   * /api/peers lists all three, the dead one as not answering;
//   * only the trimmed figures come through — no worker list, no addresses;
//   * the widgets add the peers up and give the distance per coin;
//   * a peer answering with something hostile (huge, not JSON, markup in the
//     names) costs nothing and injects nothing;
//   * a malformed PEER_POOLS entry is ignored, not followed.
//
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.argv[2] || 23281);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 1.9.0 peer: LTC, DOGE, PEP and SOQ, one worker with an address that must
// not travel any further than this server.
const NEW_PEER = {
  ok: true,
  totalHashrate: 2.3e9,
  bestShareDiff: 500000,
  bestShareStratum: 500000 * 65536,
  bestShareAt: 1786000000000,
  blocksFound: 2,
  workers: [{ name: 'rig1', payoutAddress: 'DSecretWorkerAddressxxxxxxxxxxxxx', hashrate: 2.3e9 }],
  chains: [
    { name: 'LTC', label: 'Litecoin', height: 3205062, difficulty: 95864124 },
    { name: 'DOGE', label: 'Dogecoin', height: 6438477, difficulty: 49920142 },
    { name: 'PEP', label: 'Pepecoin', height: 1273944, difficulty: 33767025 },
    // Soqucoin with its own best: only the shares made while it was mined.
    { name: 'SOQ', label: '<img src=x onerror=alert(1)>', height: 28722, difficulty: 1785563, best: 100000 },
  ],
};
// A 1.8.1 peer: no `chains`, Dogecoin's difficulty at the top level and
// Litecoin's under `merged`.
const OLD_PEER = {
  ok: true,
  totalHashrate: 1e9,
  bestShareDiff: 2000000,
  bestShareStratum: 2000000 * 65536,
  blocksFound: 1,
  networkDifficulty: 50000000,
  height: 6438477,
  merged: { parentChain: 'LTC', parentHeight: 3205062, parentDifficulty: 100000000 },
  workers: [{ name: 'a' }, { name: 'b' }],
};

let hostile = false;
// A peer that sends headers and then one byte a second, for ever: the socket
// is never silent long enough for a plain socket timeout to fire.
function tricklePeer() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const t = setInterval(() => { if (!res.destroyed) res.write(' '); }, 1000);
    res.on('close', () => clearInterval(t));
  });
}
function peerServer(body) {
  return http.createServer((req, res) => {
    if (req.url !== '/api/status') { res.writeHead(404); res.end(); return; }
    if (hostile) {
      // Four megabytes of something that is not JSON.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('x'.repeat(4 * 1024 * 1024));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
}

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

(async () => {
  const a = peerServer(NEW_PEER);
  const b = peerServer(OLD_PEER);
  const c = tricklePeer();
  const pa = await listen(a);
  const pb = await listen(b);
  const pc = await listen(c);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doge-peers-'));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'images/stratum/src/server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      STRATUM_PORT: String(PORT + 1),
      STATS_PATH: path.join(dir, 'stats.json'),
      PAYOUT_ADDRESS: 'DU4KTk97aC46ZbXjdTpP9tFNYCrmuLZXLd',
      RPC_HOST: '127.0.0.1',
      RPC_PORT: '1',
      STALL_RESTART_MINUTES: '0',
      // Three good entries (one dead) and two that must be ignored: a URL and
      // a host with a path in it.
      PEER_POOLS: `3335=localhost:${pa},3339=localhost:${pb},dead=localhost:1,slow=localhost:${pc},` +
        'evil=http://example.com:80,bad=localhost:80/api',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const stop = () => {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    a.close(); b.close(); c.closeAllConnections(); c.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };

  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { await fetch(`${BASE}/health`); up = true; } catch { await sleep(100); }
  }
  if (!up) { console.log('  FAIL  the dashboard never started'); console.log(log.slice(0, 2000)); stop(); process.exit(1); }

  // The first poll runs at startup; give it the three-second timeout of the
  // dead peer and a little more.
  let peers = [];
  for (let i = 0; i < 50; i++) {
    peers = (await (await fetch(`${BASE}/api/peers`)).json()).peers;
    if (peers.length && peers.every((p) => p.at)) break;
    await sleep(200);
  }

  console.log('\n/api/peers');
  check('four peers configured; the URL and the path entries are ignored',
    peers.map((p) => p.name).join() === '3335,3339,dead,slow', peers.map((p) => p.name).join());
  check('and the log says so', /ignoring "evil=/.test(log) && /ignoring "bad=/.test(log), log.slice(0, 600));
  const [p1, p2, p3] = peers;
  check('the 1.9.0 peer is read with all four coins',
    p1.ok && p1.status.chains.map((c) => c.name).join() === 'LTC,DOGE,PEP,SOQ', JSON.stringify(p1));
  check('the 1.8.1 peer gets LTC and DOGE from its older fields',
    p2.ok && p2.status.chains.map((c) => `${c.name}:${c.difficulty}`).join() === 'LTC:100000000,DOGE:50000000', JSON.stringify(p2));
  check('the dead one is shown as not answering', p3.ok === false && !!p3.error, JSON.stringify(p3));
  const p4 = peers[3];
  check('a peer trickling one byte a second is cut off at the deadline', p4.ok === false && /timed out/.test(p4.error || ''), JSON.stringify(p4));
  const alive = await fetch(`${BASE}/health`).then((r) => r.status).catch(() => 0);
  check('and the process survives it', alive === 200 || alive === 503, String(alive));
  check('worker lists and addresses stay behind', !JSON.stringify(peers).includes('DSecretWorkerAddress') &&
    p1.status.workerCount === 1 && p2.status.workerCount === 2);

  console.log('\nwidgets add the ports up');
  const hrw = await (await fetch(`${BASE}/api/widget/hashrate`)).json();
  check('the title says all ports', hrw.title === 'Hashrate, all ports', hrw.title);
  check('hashrate is the sum: 3.3 GH/s', hrw.text === '3.30 GH/s', hrw.text);
  check('the label gives a distance for every coin',
    /^LTC .+ · DOGE .+ · PEP .+ · SOQ .+$/.test(hrw.progressLabel), hrw.progressLabel);
  check('measured from the best share of all ports (2M of DOGE 49.9M = 4.0%)',
    hrw.progressLabel.includes('DOGE 4.0%'), hrw.progressLabel);
  check('SOQ counts only shares made while SOQ was mined (100k of 1.79M), not the pool best or a non-SOQ port',
    hrw.progressLabel.includes('SOQ 5.6%'), hrw.progressLabel);
  check('PEP has no own figure here, so the pool best of the one port that mines it (500k of 33.8M)',
    hrw.progressLabel.includes('PEP 1.5%'), hrw.progressLabel);
  check('progress is a number between 0 and 1', typeof hrw.progress === 'number' && hrw.progress > 0 && hrw.progress <= 1);
  check('refresh is set (umbrelOS needs it)', typeof hrw.refresh === 'string');
  const st = await (await fetch(`${BASE}/api/widget/stats`)).json();
  const item = (t) => st.items.find((x) => x.title === t);
  check('workers: 3 across the ports', item('Workers').text === '3' && item('Workers').subtext === 'all ports', JSON.stringify(item('Workers')));
  check('blocks: 3 across the ports', item('Blocks').text === '3', JSON.stringify(item('Blocks')));
  check('best share: the largest, in stratum units', item('Best share').text === '131.1G', JSON.stringify(item('Best share')));

  console.log('\na hostile peer');
  check('markup in a peer label is passed as text, for the page to escape',
    p1.status.chains[3].label.length <= 24, p1.status.chains[3].label);
  hostile = true;
  let after = [];
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    after = (await (await fetch(`${BASE}/api/peers`)).json()).peers;
    if (after[0] && after[0].ok === false) break;
  }
  check('four megabytes of garbage are refused, not parsed', after[0] && after[0].ok === false &&
    /too large|not a pool status/.test(after[0].error), JSON.stringify(after[0]));
  const health = await fetch(`${BASE}/health`);
  check('and the server is still answering', health.status === 200 || health.status === 503, String(health.status));

  const html = await (await fetch(`${BASE}/`)).text();
  check('the page escapes peer names before using them', /function esc\(/.test(html) && html.includes("esc(c.label || c.name)"));

  stop();
  console.log(failures === 0 ? '\nPEER POOLS VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
