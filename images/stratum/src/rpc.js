'use strict';
//
// Minimal JSON-RPC client for dogecoind. No dependencies, no retry magic —
// callers decide what a failure means, because "template fetch failed" and
// "block submission failed" need very different responses.
//

const http = require('node:http');
const dns = require('node:dns');
const net = require('node:net');

// For hosts on umbrelOS's shared docker network. Every app's containers sit on
// that one network, and a name or alias that answers with MORE than one
// address means another container claims the same name — and would receive
// the password and the calls meant for this node. Such a name is refused, not
// guessed at. IPv4 only: container names have no other kind.
function singleAddressLookup(hostname, options, callback) {
  const family = net.isIP(hostname);
  if (family) {
    return options && options.all ? callback(null, [{ address: hostname, family }]) : callback(null, hostname, family);
  }
  dns.lookup(hostname, { all: true, family: 4 }, (err, addrs) => {
    if (err) return callback(err);
    const unique = [...new Set(addrs.map((a) => a.address))];
    if (unique.length !== 1) {
      const e = new Error(
        `${hostname} answers with ${unique.length} addresses (${unique.join(', ')}); refusing it, ` +
          'because another container may be using the same name'
      );
      e.code = 'EMULTIADDR';
      return callback(e);
    }
    return options && options.all ? callback(null, [{ address: unique[0], family: 4 }]) : callback(null, unique[0], 4);
  });
}

class RpcError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

class RpcClient {
  // `deadline` (ms) bounds a whole call, unlike `timeout`, which only fires
  // after a silence: a node trickling bytes would otherwise hold a call open
  // for ever. `singleAddress` refuses a host name that resolves to more than
  // one address (see singleAddressLookup). Both off unless asked for.
  constructor({ host, port, user, password, timeout = 15000, deadline = 0, singleAddress = false }) {
    this.host = host;
    this.port = port;
    this.auth =
      user || password
        ? Buffer.from(`${user || ''}:${password || ''}`).toString('base64')
        : null;
    this.timeout = timeout;
    this.deadline = deadline;
    this.singleAddress = singleAddress;
    this.nextId = 1;
  }

  call(method, params = []) {
    const body = JSON.stringify({
      jsonrpc: '1.0',
      id: this.nextId++,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      };
      if (this.auth) headers.Authorization = `Basic ${this.auth}`;

      const opts = { host: this.host, port: this.port, method: 'POST', path: '/', headers };
      if (this.singleAddress) opts.lookup = singleAddressLookup;
      const req = http.request(
        opts,
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            // A block template with a full mempool is large but bounded; this
            // cap stops a wedged or hostile endpoint from exhausting memory.
            if (size > 64 * 1024 * 1024) {
              req.destroy(new Error('RPC response too large'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode === 401) {
              reject(new RpcError('RPC authentication failed', 401));
              return;
            }
            let parsed;
            try {
              parsed = JSON.parse(text);
            } catch {
              reject(
                new RpcError(
                  `RPC returned non-JSON (HTTP ${res.statusCode}): ${text.slice(0, 200)}`,
                  res.statusCode
                )
              );
              return;
            }
            if (parsed.error) {
              reject(
                new RpcError(parsed.error.message || 'RPC error', parsed.error.code)
              );
              return;
            }
            resolve(parsed.result);
          });
        }
      );

      req.setTimeout(this.timeout, () => {
        req.destroy(new RpcError(`RPC ${method} timed out`, 'ETIMEDOUT'));
      });
      if (this.deadline) {
        const timer = setTimeout(() => {
          req.destroy(new RpcError(`RPC ${method} took longer than ${this.deadline} ms`, 'ETIMEDOUT'));
        }, this.deadline);
        req.on('close', () => clearTimeout(timer));
      }
      req.on('error', (err) => reject(err));
      req.end(body);
    });
  }

  getBlockTemplate() {
    // Dogecoin 1.14 accepts an empty request; passing capabilities keeps us
    // explicit about the fact that we build our own coinbase.
    return this.call('getblocktemplate', [
      { capabilities: ['coinbasetxn', 'workid', 'coinbase/append'], rules: [] },
    ]);
  }

  submitBlock(hex) {
    return this.call('submitblock', [hex]);
  }
}

module.exports = { RpcClient, RpcError, singleAddressLookup };
