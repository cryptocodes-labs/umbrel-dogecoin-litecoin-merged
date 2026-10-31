'use strict';
//
// The node dashboard (images/ui) hands its RPC password only to the umbrelOS
// app_proxy, which it recognises by the addresses of CREDENTIALS_ALLOW_HOST.
// Every app shares one docker network, and any container can claim a name or
// alias there; a name that answers with more than one address therefore has
// an impostor behind it and must not be trusted at all.
//
// DNS is replaced in the dashboard process by a preload, so the test needs no
// docker network: "proxy-ok" answers with this host's own address, "proxy-
// twice" with this host's address AND another one, as a hijacked name would.
// The request then comes from this host's non-loopback address.
//
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hostIp = Object.values(os.networkInterfaces()).flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal);
if (!hostIp) {
  console.log('  skip  no non-loopback IPv4 address on this host');
  process.exit(0);
}
const IP = hostIp.address;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-creds-'));
const preload = path.join(dir, 'fake-dns.js');
fs.writeFileSync(preload, `
const dns = require('node:dns');
const table = { 'proxy-ok': ['${IP}'], 'proxy-twice': ['${IP}', '10.99.99.99'] };
dns.promises.lookup = async (host, opts) => {
  const addrs = table[host];
  if (!addrs) { const e = new Error('ENOTFOUND ' + host); e.code = 'ENOTFOUND'; throw e; }
  return opts && opts.all ? addrs.map((address) => ({ address, family: 4 })) : { address: addrs[0], family: 4 };
};
`);

async function run(allowHost, port) {
  const child = spawn(process.execPath, ['--require', preload, path.join(__dirname, '..', 'images/ui/src/server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      RPC_HOST: '127.0.0.1',
      RPC_PORT: '1',
      RPC_USER: 'umbrel',
      RPC_PASSWORD: 'the-node-password',
      DATA_DIR: dir,
      CREDENTIALS_ALLOW_HOST: allowHost,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await sleep(100); }
  }
  const res = await fetch(`http://${IP}:${port}/api/credentials`).catch((e) => ({ status: 0, text: async () => String(e) }));
  const body = await res.text();
  child.kill('SIGKILL');
  return { status: res.status, body, log };
}

(async () => {
  console.log(`\nthe dashboard's credentials gate (requests from ${IP})`);
  const ok = await run('proxy-ok', 23411);
  check('the app proxy, by a name with one address, gets the password', ok.status === 200 && ok.body.includes('the-node-password'),
    `${ok.status} ${ok.body.slice(0, 120)}`);
  const twice = await run('proxy-twice', 23412);
  check('a name that answers with two addresses is not trusted', twice.status === 403 && !twice.body.includes('the-node-password'),
    `${twice.status} ${twice.body.slice(0, 120)}`);
  check('and the log says why', /answers with 2 addresses/.test(twice.log), twice.log.slice(0, 300));
  const both = await run('proxy-twice,proxy-ok', 23413);
  check('a hijacked name next to a good one: the good one still works', both.status === 200, `${both.status}`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nCREDENTIALS GATE VERIFIED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
