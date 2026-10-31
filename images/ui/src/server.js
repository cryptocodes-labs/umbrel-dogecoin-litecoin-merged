'use strict';

/**
 * Node dashboard for Umbrel.
 *
 * One image serves every coin in this store: the chain-specific bits are the
 * RPC endpoint, the data directory and a handful of words, all of which come
 * from the environment. Defaults are Dogecoin's, so an app that sets none of
 * the branding variables behaves exactly as this dashboard always has.
 *
 * Node.js standard library only — no npm dependencies, so there is no supply
 * chain to audit beyond Node itself.
 *
 * Everything here is read-only: the process never writes to disk, never shells
 * out except for `du`, and only ever issues a fixed allowlist of RPC methods.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const { execFile } = require('node:child_process');

const PORT = Number(process.env.PORT || 3000);
const RPC_HOST = process.env.RPC_HOST || 'dogecoind';
const RPC_PORT = Number(process.env.RPC_PORT || 22555);
const P2P_PORT = Number(process.env.P2P_PORT || 22556);
const DATA_DIR = process.env.DATA_DIR || '/data';
const CHAIN_DIR = process.env.CHAIN_DIR || path.join(DATA_DIR, '.dogecoin');
const DEVICE_HOST = process.env.DEVICE_DOMAIN_NAME || 'umbrel.local';

// ---------------------------------------------------------------------------
// Branding
//
// These land in HTML text nodes AND inside single-quoted JavaScript string
// literals in the page, so anything that could close either context is
// stripped rather than escaped: an operator typo in a compose file should
// produce an ugly title, never a script injection. The length cap keeps a
// pasted essay from wrecking the header layout.
// ---------------------------------------------------------------------------
function brand(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  const clean = raw.replace(/[<>"'`&\\\r\n]/g, '').slice(0, 48);
  return clean || fallback;
}

// Colours end up inside a CSS rule, where a value like "red;}body{…" would be
// a stylesheet injection, so they are matched against a hex literal instead of
// merely being stripped.
function accent(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(raw) ? raw : fallback;
}

const COIN_NAME = brand('COIN_NAME', 'Dogecoin');
const BRANDING = {
  __COIN_NAME__: COIN_NAME,
  __CORE_NAME__: brand('CORE_NAME', `${COIN_NAME} Core`),
  __DAEMON_NAME__: brand('DAEMON_NAME', 'dogecoind'),
  // Rendered as the coin's logo in the header.
  __COIN_GLYPH__: brand('COIN_GLYPH', 'Ð'),
  __CHAIN_SIZE_HINT__: brand('CHAIN_SIZE_HINT', 'roughly 150 GB'),
  // Shown in the "the node is unreachable" message, so it has to be the
  // container the user would actually run `docker logs` against.
  __DAEMON_CONTAINER__: brand('DAEMON_CONTAINER', 'doge-dogecoin-node_dogecoind_1'),
  // Dogecoin gold, and the two shades the logo gradient and progress bar are
  // built from.
  __ACCENT__: accent('ACCENT', '#c2a633'),
  __ACCENT_SOFT__: accent('ACCENT_SOFT', '#e3c95c'),
  __ACCENT_DEEP__: accent('ACCENT_DEEP', '#8f7a1f'),
};

// Every Umbrel app shares one docker network, so this container is reachable
// from every other installed app. Requests for the RPC password are therefore
// restricted to the peers allowed to ask: our own app_proxy, which is the thing
// that enforces the umbrelOS login. Everything else — including a compromised
// sibling app — gets a 403. Fails closed if nothing resolves.
//
// Comma-separated, because the proxy container answers to both its injected
// container_name and the hostname umbrelOS gives it.
const CREDENTIALS_ALLOW_HOSTS = (process.env.CREDENTIALS_ALLOW_HOST || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

// umbrelOS does `widgetData.refresh = ms(widgetData.refresh)` on every widget
// response, and ms@2 THROWS on undefined. A widget that omits this field is
// therefore permanently broken, not merely un-refreshed. Keep these in sync
// with the `refresh` values in umbrel-app.yml.
const SYNC_REFRESH = '5s';
const STATS_REFRESH = '10s';

// The only RPC methods this process is ever allowed to call.
const ALLOWED_METHODS = new Set([
  'getblockchaininfo',
  'getnetworkinfo',
  'getmempoolinfo',
  'getmininginfo',
  'getpeerinfo',
  'getnettotals',
  // Deliberately no `uptime`: Dogecoin Core 1.14 does not implement it, and
  // this allowlist is shared with the coins that do.
]);

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function readSecret(file, fallback) {
  try {
    return fs.readFileSync(file, 'utf8').trim() || fallback;
  } catch {
    return fallback;
  }
}

function credentials() {
  return {
    user: process.env.RPC_USER || readSecret(path.join(DATA_DIR, 'rpc-user'), 'umbrel'),
    password: process.env.RPC_PASSWORD || readSecret(path.join(DATA_DIR, 'rpc-password'), ''),
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

let rpcId = 0;

function rpc(method, params = []) {
  if (!ALLOWED_METHODS.has(method)) {
    return Promise.reject(new Error(`Refusing to call non-allowlisted RPC method: ${method}`));
  }

  const { user, password } = credentials();
  if (!password) {
    return Promise.reject(new Error('No RPC password available yet'));
  }

  const body = JSON.stringify({ jsonrpc: '1.0', id: `dash-${++rpcId}`, method, params });
  const auth = Buffer.from(`${user}:${password}`).toString('base64');

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: RPC_HOST,
        port: RPC_PORT,
        method: 'POST',
        path: '/',
        timeout: 20000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Basic ${auth}`,
        },
      },
      (res) => {
        let chunks = '';
        let size = 0;
        res.setEncoding('utf8');
        res.on('data', (d) => {
          size += d.length;
          // getpeerinfo on a busy node is the largest response we expect;
          // 16 MB is far beyond it and stops a runaway body eating memory.
          if (size > 16 * 1024 * 1024) {
            req.destroy(new Error('RPC response too large'));
            return;
          }
          chunks += d;
        });
        res.on('end', () => {
          if (res.statusCode === 401) return reject(new Error('RPC authentication failed'));
          let parsed;
          try {
            parsed = JSON.parse(chunks);
          } catch {
            return reject(new Error(`Invalid RPC response (HTTP ${res.statusCode})`));
          }
          if (parsed.error) return reject(new Error(parsed.error.message || 'RPC error'));
          resolve(parsed.result);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('RPC timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function tryRpc(method, params = [], fallback = null) {
  try {
    return await rpc(method, params);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Disk usage — cached, because walking the blocks directory is not free.
// ---------------------------------------------------------------------------

let diskCache = { bytes: null, at: 0 };
let diskInFlight = null;

function refreshChainSize() {
  if (diskInFlight) return;
  diskInFlight = true;
  execFile('du', ['-sk', CHAIN_DIR], { timeout: 120000 }, (err, stdout) => {
    diskInFlight = false;
    // Stamp the cache even on failure, so a `du` that times out on slow storage
    // cannot turn into a re-spawn-every-request loop.
    const kb = err ? NaN : Number(String(stdout).trim().split(/\s+/)[0]);
    diskCache = {
      bytes: Number.isFinite(kb) ? kb * 1024 : diskCache.bytes,
      at: Date.now(),
    };
  });
}

/**
 * Never blocks a request. Returns the last measurement (null until the first
 * one lands) and kicks off a refresh in the background when it is stale.
 * Walking a 150 GB blocks directory can take a while on USB or SD storage, and
 * the dashboard must stay responsive while it does.
 */
function chainSizeBytes() {
  if (diskCache.bytes === null || Date.now() - diskCache.at > 300_000) refreshChainSize();
  return diskCache.bytes;
}

// ---------------------------------------------------------------------------
// Status — cached for a second so that the dashboard, both widgets and any
// extra browser tab together still only produce one round of RPC calls.
// ---------------------------------------------------------------------------

let statusCache = { value: null, at: 0 };
let statusInFlight = null;

async function buildStatus() {
  const chain = await rpc('getblockchaininfo'); // throws when the node is unreachable
  const [network, mempool, mining, peers, nettotals] = await Promise.all([
    tryRpc('getnetworkinfo', [], {}),
    tryRpc('getmempoolinfo', [], {}),
    tryRpc('getmininginfo', [], {}),
    tryRpc('getpeerinfo', [], []),
    tryRpc('getnettotals', [], {}),
  ]);
  const size = chainSizeBytes();

  const peerList = Array.isArray(peers) ? peers : [];
  const inbound = peerList.filter((p) => p.inbound).length;

  const headers = Number(chain.headers) || 0;
  const blocks = Number(chain.blocks) || 0;
  let progress = typeof chain.verificationprogress === 'number' ? chain.verificationprogress : 0;
  progress = Math.max(0, Math.min(1, progress));

  // initialblockdownload is the authoritative signal; the height comparison is
  // a fallback for builds that don't report it.
  const synced =
    chain.initialblockdownload === false ||
    (chain.initialblockdownload === undefined && headers > 0 && blocks >= headers && progress > 0.9999);

  const warnings = [chain.warnings, network.warnings].filter((w) => typeof w === 'string' && w.trim());

  return {
    ok: true,
    synced,
    progress,
    blocks,
    headers,
    bestBlockHash: chain.bestblockhash || null,
    medianTime: chain.mediantime || null,
    difficulty: Number(chain.difficulty) || 0,
    chain: chain.chain || 'main',
    pruned: Boolean(chain.pruned),
    pruneHeight: chain.pruneheight ?? null,
    sizeOnDisk: typeof chain.size_on_disk === 'number' ? chain.size_on_disk : size,
    version: network.subversion ? String(network.subversion).replace(/\//g, '') : 'unknown',
    protocolVersion: network.protocolversion || null,
    traffic: {
      received: Number(nettotals.totalbytesrecv) || 0,
      sent: Number(nettotals.totalbytessent) || 0,
    },
    warnings,
    connections: typeof network.connections === 'number' ? network.connections : peerList.length,
    inbound,
    outbound: peerList.length - inbound,
    torEnabled: Array.isArray(network.networks)
      ? network.networks.some((n) => n.name === 'onion' && n.reachable)
      : false,
    peers: peerList.slice(0, 200).map((p) => ({
      addr: String(p.addr || ''),
      subver: String(p.subver || '').replace(/\//g, ''),
      inbound: Boolean(p.inbound),
      ping: typeof p.pingtime === 'number' ? Math.round(p.pingtime * 1000) : null,
      height: p.synced_blocks ?? p.startingheight ?? null,
    })),
    mempool: {
      size: Number(mempool.size) || 0,
      bytes: Number(mempool.bytes) || 0,
    },
    networkHashps: Number(mining.networkhashps) || 0,
    rpc: {
      // Connection details only. The password lives behind /api/credentials so
      // it is not shipped on every five-second poll.
      serviceHost: RPC_HOST,
      port: RPC_PORT,
      p2pPort: P2P_PORT,
      user: credentials().user,
      lanHost: DEVICE_HOST,
    },
  };
}

function getStatus() {
  const now = Date.now();
  if (statusCache.value && now - statusCache.at < 1000) {
    return Promise.resolve(statusCache.value);
  }
  if (statusInFlight) return statusInFlight;

  statusInFlight = buildStatus()
    .then((value) => {
      statusCache = { value, at: Date.now() };
      statusInFlight = null;
      return value;
    })
    .catch((err) => {
      statusInFlight = null;
      throw err;
    });
  return statusInFlight;
}

// ---------------------------------------------------------------------------
// Formatting helpers shared with the widget endpoints
// ---------------------------------------------------------------------------

function humanBytes(bytes) {
  if (!bytes || bytes < 0) return { value: '0', unit: 'MB' };
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return { value: gb.toFixed(gb >= 100 ? 0 : 1), unit: 'GB' };
  return { value: (bytes / 1024 ** 2).toFixed(0), unit: 'MB' };
}

function humanHashrate(hps) {
  const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];
  let i = 0;
  let v = Number(hps) || 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return { value: v >= 100 ? v.toFixed(0) : v.toFixed(1), unit: units[i] };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=(), usb=()',
  'Cache-Control': 'no-store',
};

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Branding is fixed for the life of the process, so it is baked in once here
// and only the nonce is substituted per request.
const INDEX_TEMPLATE = Object.entries(BRANDING).reduce(
  (html, [token, value]) => html.replaceAll(token, value),
  fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
);

function sendIndex(res) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const html = INDEX_TEMPLATE.replaceAll('__CSP_NONCE__', nonce);
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
  const body = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Security-Policy': csp,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

const NOT_FOUND = (res) => sendJson(res, 404, { ok: false, error: 'Not found' });

// ---------------------------------------------------------------------------
// Who may ask for the RPC password
// ---------------------------------------------------------------------------

let allowedIpCache = { ips: null, at: 0 };

function normaliseIp(addr) {
  if (!addr) return '';
  // Node reports IPv4 peers over a dual-stack socket as ::ffff:10.21.0.5
  return String(addr).replace(/^::ffff:/, '');
}

async function credentialsPeerAllowed(req) {
  const peer = normaliseIp(req.socket.remoteAddress);
  if (peer === '127.0.0.1' || peer === '::1') return true; // healthchecks and local dev
  if (!CREDENTIALS_ALLOW_HOSTS.length) return false;

  // A successful lookup is cached for 30s; a failed one for only 3s, so a
  // dashboard opened before the proxy is resolvable recovers almost at once
  // instead of refusing for half a minute.
  const age = Date.now() - allowedIpCache.at;
  const stale = !allowedIpCache.ips || (allowedIpCache.ips.length ? age > 30_000 : age > 3_000);
  if (stale) {
    const found = [];
    for (const host of CREDENTIALS_ALLOW_HOSTS) {
      try {
        const records = await dns.lookup(host, { all: true });
        const addrs = [...new Set(records.map((r) => normaliseIp(r.address)))];
        // Every umbrelOS app shares one docker network, and any container on
        // it can claim a name or alias. A name that answers with more than one
        // address therefore has an impostor behind it — and the RPC password
        // must not go to either. That name is not trusted at all.
        if (addrs.length !== 1) {
          console.warn(`Not trusting ${host} for /api/credentials: it answers with ${addrs.length} addresses (${addrs.join(', ')})`);
          continue;
        }
        found.push(addrs[0]);
      } catch {
        /* try the next candidate */
      }
    }
    allowedIpCache = { ips: found, at: Date.now() };
  }

  const allowed = allowedIpCache.ips.includes(peer);
  if (!allowed) {
    console.warn(
      `Refused /api/credentials from ${peer}; expected one of ` +
        `${CREDENTIALS_ALLOW_HOSTS.join(', ')} (${allowedIpCache.ips.join(', ') || 'unresolved'})`
    );
  }
  return allowed;
}

const server = http.createServer(async (req, res) => {
  // Read-only service: nothing here should ever be reached by a write verb.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' });
    return res.end();
  }

  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return NOT_FOUND(res);
  }

  try {
    switch (pathname) {
      case '/':
      case '/index.html':
        return sendIndex(res);

      case '/health':
        return sendJson(res, 200, { ok: true });

      case '/favicon.ico':
        res.writeHead(204, SECURITY_HEADERS);
        return res.end();

      case '/api/status':
        return sendJson(res, 200, await getStatus());

      case '/api/credentials': {
        if (!(await credentialsPeerAllowed(req))) {
          return sendJson(res, 403, {
            ok: false,
            error: 'Credentials are only served to the Umbrel app proxy.',
          });
        }
        const { user, password } = credentials();
        return sendJson(res, 200, {
          ok: Boolean(password),
          user,
          password,
          port: RPC_PORT,
          p2pPort: P2P_PORT,
          serviceHost: RPC_HOST,
          lanHost: DEVICE_HOST,
        });
      }

      case '/api/widget/stats': {
        const s = await getStatus().catch(() => null);
        if (!s) {
          return sendJson(res, 200, {
            type: 'four-stats',
            refresh: STATS_REFRESH,
            link: '',
            items: [
              { title: 'Status', text: 'Starting', subtext: '' },
              { title: 'Connections', text: '—', subtext: 'peers' },
              { title: 'Mempool', text: '—', subtext: 'txs' },
              { title: 'Blockchain size', text: '—', subtext: '' },
            ],
          });
        }
        const size = humanBytes(s.sizeOnDisk);
        const hash = humanHashrate(s.networkHashps);
        return sendJson(res, 200, {
          type: 'four-stats',
          refresh: STATS_REFRESH,
          link: '',
          items: [
            { title: 'Connections', text: String(s.connections), subtext: 'peers' },
            { title: 'Mempool', text: String(s.mempool.size), subtext: 'txs' },
            { title: 'Hashrate', text: hash.value, subtext: hash.unit },
            { title: 'Blockchain size', text: size.value, subtext: size.unit },
          ],
        });
      }

      case '/api/widget/sync': {
        const s = await getStatus().catch(() => null);
        if (!s) {
          return sendJson(res, 200, {
            type: 'text-with-progress',
            refresh: SYNC_REFRESH,
            link: '',
            title: 'Blockchain sync',
            text: 'Starting',
            progressLabel: 'Connecting',
            progress: 0,
          });
        }
        // Never round up to 100% while the node still reports initial block download.
        const pct = Math.min(s.synced ? 100 : 99.99, s.progress * 100);
        return sendJson(res, 200, {
          type: 'text-with-progress',
          refresh: SYNC_REFRESH,
          link: '',
          title: 'Blockchain sync',
          text: s.synced ? '100%' : `${pct.toFixed(2)}%`,
          progressLabel: s.synced ? 'Synced' : 'In progress',
          progress: Number((pct / 100).toFixed(4)),
        });
      }

      default:
        return NOT_FOUND(res);
    }
  } catch (err) {
    return sendJson(res, 503, { ok: false, error: err.message || String(err) });
  }
});

server.headersTimeout = 20000;
server.requestTimeout = 30000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`${COIN_NAME} dashboard listening on :${PORT} (RPC ${RPC_HOST}:${RPC_PORT})`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

module.exports = { server, humanBytes, humanHashrate };
