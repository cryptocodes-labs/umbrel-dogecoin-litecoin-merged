'use strict';
//
// The solo pool: template management plus a stratum v1 server.
//
// "Solo" changes the design in one important way. A real pool must account for
// every share because shares determine who gets paid. Here shares are only a
// progress indicator — the block reward goes straight to a coinbase address.
// So there is no database, no payout logic, and no share ledger to corrupt.
// What must be right is the block construction and the moment of submission.
//

const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { RpcClient } = require('./rpc');
const { Job, validateShareAsync, EXTRANONCE1_SIZE, EXTRANONCE2_SIZE } = require('./job');
const { MergedJob, LTC_RULES, DOGE_CHAIN_ID, PEP_CHAIN_ID, SOQ_CHAIN_ID } = require('./merged');
const pm = require('./public-merged');
const u = require('./util');

const MAX_LINE_BYTES = 16 * 1024;
// How many jobs stay valid. This is not about new blocks — those arrive by
// longpoll and are announced with clean_jobs — but about REBUILDS: the template
// is rebuilt whenever the coinbase value rises, which on a busy mempool is
// every few seconds. At six, a job expired about thirty seconds after it was
// issued, while the pool was still telling miners the older jobs were valid
// (clean_jobs false). Work returning from a proxy or a rented aggregator is
// routinely older than that, and such a share was rejected as "job not found"
// WITHOUT ever being hashed — so a block-winning share would have been thrown
// away unexamined.
//
// Sixty covered ten minutes when the template was polled every five seconds.
// The merged-mining poll now runs every two, which is fast enough to observe
// essentially every rebuild litecoind produces — Core regenerates its template
// at most once every five seconds, so about twelve a minute — and sixty jobs
// would be five minutes again. A hundred and twenty restores the ten.
const JOB_HISTORY = 120;
// How many superseded difficulty targets a client's in-flight work may still be
// judged against.
const RECENT_TARGETS = 4;
// Connection-churn log lines allowed per minute before they are summarised.
const CHURN_LOG_PER_MINUTE = 20;
// How many aux longpolls may time out in a row before the loop gives up.
// Each timeout leaves a worker thread parked inside dogecoind until its tip
// moves — see the catch in auxLongPollLoop — and the node has eight.
const AUX_LONGPOLL_MAX_TIMEOUTS = 3;
// How long to wait after one, so the leak rate is bounded even below that cap.
const AUX_LONGPOLL_TIMEOUT_BACKOFF_MS = 30000;

// Safety limits get defaults here rather than only in the caller. A limit that
// silently becomes `undefined` compares false against everything, which turns
// every ceiling below into no ceiling at all.
const DEFAULT_LIMITS = {
  maxConnections: 64,
  maxConnectionsPerIp: 8,
  maxMessagesPer10s: 300,
  maxPayoutVariants: 16,
  minLongpollIntervalMs: 250,
  handshakeTimeoutMs: 30000,
  pingIntervalMs: 60000,
  difficultyGraceMs: 60000,
  lockPayoutAddress: false,
};

class Pool extends EventEmitter {
  constructor(config, store = null) {
    super();
    this.config = { ...DEFAULT_LIMITS, ...config };
    config = this.config;

    // Two independent regimes can listen at once — see onConnection and the
    // rented port in start(). The PRIMARY port deliberately has no limits
    // object of its own: `this.config` already carries its ten numbers, and
    // is exactly the object the dashboard's live profile switch (see
    // server.js's applyMiningProfile) mutates in place — so a primary client
    // whose `limits` is `this.config`, by reference rather than by copy,
    // keeps seeing a switch made after it connected, precisely matching the
    // "applies live, to workers already connected too" behaviour that switch
    // was built for. `rentedPortLimits` is a genuinely separate, frozen copy:
    // there is no live-switch mechanism for it, and it must never be moved by
    // a mutation aimed at the primary port. Stays null unless server.js
    // actually configured a second port, which is the common case: one port,
    // one set of limits, exactly as before this existed.
    this.rentedPortLimits = config.rentedPortLimits
      ? { ...DEFAULT_LIMITS, ...config.rentedPortLimits }
      : null;

    // Optional durable history. Everything below works without it; the pool
    // simply forgets on restart.
    this.store = store;
    // Every node connection refuses a host name that answers with more than
    // one address: on umbrelOS's shared docker network that means another
    // container claims the node's name, and would receive its password, its
    // templates and our blocks (see singleAddressLookup in rpc.js).
    this.rpc = new RpcClient({ ...config.rpc, singleAddress: true });
    // A second client for longpoll: those requests block for up to a minute and
    // must not sit in front of an urgent submitblock.
    this.longpollRpc = new RpcClient({ ...config.rpc, timeout: 120000, singleAddress: true });
    // A third for block submission. submitblock fully validates the block
    // before answering, which on a slow disk can take far longer than the
    // 15 seconds that is generous for every other call — and a timeout there
    // would look like a failure when the node is actually accepting it.
    this.submitRpc = new RpcClient({ ...config.rpc, timeout: 180000, singleAddress: true });

    // Merged mining, off unless asked for. Everything below this line that
    // reads `this.merged` is dead code in Dogecoin-only mode, which is what
    // this app runs in production: the parent-chain paths are additions beside
    // the existing ones, not modifications of them.
    //
    // In merged mode the roles swap: `this.rpc` (Dogecoin) stops serving
    // templates and only does createauxblock/submitauxblock, while the
    // Litecoin clients below carry the getblocktemplate/longpoll/submitblock
    // traffic — with the same three-client split and for the same reasons.
    this.merged = !!config.mergedMining;
    // Public merged mining: a port meant for strangers. Each miner is paid on
    // both chains at the two addresses in its username, and the configured
    // addresses receive the pool fee instead of the block. Only meaningful on
    // top of merged mode; the private merged path below is untouched by it.
    this.publicMerged = this.merged && !!config.publicMerged;
    if (this.merged) {
      if (!config.ltcRpc) throw new Error('merged mining needs ltcRpc connection details');
      this.ltcRpc = new RpcClient({ ...config.ltcRpc, singleAddress: true });
      this.ltcLongpollRpc = new RpcClient({ ...config.ltcRpc, timeout: 120000, singleAddress: true });
      this.ltcSubmitRpc = new RpcClient({ ...config.ltcRpc, timeout: 180000, singleAddress: true });
    }

    // Pepecoin: a further aux chain merge-mined beside Dogecoin, under the same
    // Litecoin parent (PEP_RPC_HOST + PEP_PAYOUT_ADDRESS). Optional in the
    // strongest sense, unlike Dogecoin: it can never stop or slow the pool.
    // pepecoind is polled on its own timer with a short timeout, and every job
    // is built from whatever Pepecoin block is current at that moment — none
    // if the node is down, in which case the commitment is exactly the
    // Dogecoin-only one and nothing else changes. Off when not configured.
    this.pep = null;
    if (this.merged && config.pep && config.pep.rpc && config.pep.payoutAddress) {
      this.pep = {
        name: 'PEP',
        label: 'Pepecoin',
        rpc: new RpcClient({ ...config.pep.rpc, timeout: 5000, singleAddress: true }),
        submitRpc: new RpcClient({ ...config.pep.rpc, timeout: 180000, singleAddress: true }),
        payoutAddress: config.pep.payoutAddress,
        block: null,
        unavailableSince: null,
        error: null,
        polling: false,
      };
    }

    // Soqucoin: a third aux chain beside Dogecoin and Pepecoin, under the same
    // Litecoin parent, optional in exactly the same way (its own timer, a
    // five-second timeout, left out of the jobs while soqucoind is away).
    //
    // PRIVATE merged mode only. There soqucoind builds the whole Soqucoin block
    // with createauxblock, including the PAT block attestation that a coinbase
    // built from getblocktemplate would have to copy over by hand (soqucoin
    // doc/pool-integration.md, "Block attestation (PAT)"). A public port that
    // pays every miner at its own SOQ address needs that copy and is not built,
    // so SOQ_* is ignored there — said at startup, never silently.
    this.soq = null;
    this.soqIgnored = null;
    if (this.merged && config.soq && config.soq.rpc && config.soq.payoutAddress) {
      if (this.publicMerged) {
        this.soqIgnored = 'Soqucoin is merge-mined on the private port only; SOQ_* is ignored with PUBLIC_MERGED=1';
      } else {
        this.soq = {
          name: 'SOQ',
          label: 'Soqucoin',
          // A hard deadline, not only a silence timeout: a node trickling
          // bytes must not stall a poll (or the pool's start, which waits for
          // the first one). And a host name that answers with more than one
          // address on the shared docker network is refused (see rpc.js).
          rpc: new RpcClient({ ...config.soq.rpc, timeout: 5000, deadline: 5000, singleAddress: true }),
          submitRpc: new RpcClient({ ...config.soq.rpc, timeout: 180000, singleAddress: true }),
          payoutAddress: config.soq.payoutAddress,
          // Set once soqucoind has said which network it is on (see fetchSoqBlock).
          networkChecked: false,
          block: null,
          unavailableSince: null,
          error: null,
          polling: false,
        };
      }
    }

    this.jobs = new Map();
    this.jobCounter = 0;
    this.currentJob = null;
    this.clients = new Map();
    this.clientCounter = 0;
    this.extranonceCounter = crypto.randomBytes(4).readUInt32BE(0);
    this.pingCounter = 0;
    this.nodeLatency = [];
    this.difficultyHistory = [];

    this.chain = 'main';
    this.payoutScript = null;

    this.stats = {
      startedAt: Date.now(),
      accepted: 0,
      rejected: 0,
      blocksFound: 0,
      bestShareDiff: 0,
      bestShareAt: null,
      lastBlock: null,
      lastTemplateAt: null,
      rejectReasons: {},
      blocks: [],
      templateError: null,
      templateErrorKind: null,
      // Dogecoin blocks we solved but could not hand in, because dogecoind had
      // already discarded the aux block by the time the proof arrived. This is
      // the cost of polling the aux tip instead of following it, so it is
      // counted rather than merely logged: it is the only honest measure of
      // whether the aux longpoll below is earning its keep.
      auxTipMissed: 0,
      auxTipMissedAt: null,
      // The same for Pepecoin and Soqucoin, which are polled only.
      pepTipMissed: 0,
      pepTipMissedAt: null,
      soqTipMissed: 0,
      soqTipMissedAt: null,
      // The best share per further aux chain (PEP, SOQ), counted only while
      // that chain was in the job the share was for: a share from before
      // Soqucoin was configured, or from while its node was down, could never
      // have been a Soqucoin block. In memory, so it starts again at a restart;
      // Litecoin and Dogecoin are in every merged job and use bestShareDiff.
      chainBest: {},
    };
    // How often dogecoind's longpoll came back, and how often that was actually
    // a new tip rather than a mempool update. Both are surfaced: zero tip moves
    // on a running merged pool means the loop is not doing its job, which
    // otherwise looks exactly like a quiet chain.
    this.auxLongpollSignals = 0;
    this.auxTipMoves = 0;
    this.lastAuxTip = null;
    // Set to a reason if the loop gave itself up; see auxLongPollLoop.
    this.auxLongpollDisabled = null;
    // Fields rather than bare constants so a test can drive the give-up path
    // without waiting two minutes per timeout for a real one. Nothing in the
    // app changes them.
    this.auxLongpollMaxTimeouts = AUX_LONGPOLL_MAX_TIMEOUTS;
    this.auxLongpollBackoffMs = AUX_LONGPOLL_TIMEOUT_BACKOFF_MS;

    // Seed the live counters from the durable history, so the dashboard shows
    // a continuous story across restarts rather than starting from zero.
    if (this.store) {
      const s = this.store.state;
      this.stats.accepted = s.accepted;
      this.stats.rejected = s.rejected;
      this.stats.rejectReasons = { ...s.rejectReasons };
      this.stats.blocksFound = this.store.blocksFound();
      this.stats.blocks = s.blocks.slice();
      this.stats.bestShareDiff = s.bestShareDiff;
      this.stats.bestShareAt = s.bestShareAt;
      this.stats.firstStartedAt = s.firstStartedAt;
      // Carried across restarts with everything else it labels. Without this a
      // reboot would present freshly reset counters as lifetime totals again.
      this.stats.resetAt = s.resetAt || null;
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    const info = await this.rpc.call('getblockchaininfo');
    this.chain = info.chain === 'test' ? 'test' : info.chain === 'regtest' ? 'regtest' : 'main';

    // Validate the payout address once, loudly, at startup. Discovering a typo
    // after mining a block is not a recoverable situation.
    this.payoutScript = u.addressToScript(this.config.payoutAddress, this.chain);
    this.log(
      `payout address ${this.config.payoutAddress} accepted on ${this.chain} ` +
        `(script ${this.payoutScript.toString('hex')})`
    );

    if (this.merged) await this.startMerged();

    // Guard against a second start() on the same instance. The caller retries
    // on failure, and without this each retry would leave behind another poll
    // timer and another longpoll loop — all of them competing for the node's
    // handful of RPC threads, which is the very thing that makes a submitblock
    // fail later.
    if (this.started) throw new Error('pool already started');
    // stop() sets this; without clearing it here, a Pool that was stopped and
    // started again would have a longpoll loop that exits immediately.
    this.stopped = false;
    // Which run of this Pool the background loops belong to.
    //
    // Clearing `stopped` is not enough on its own. stop() cannot interrupt a
    // longpoll that is already blocked in an RPC call for up to two minutes;
    // when that call finally resolves, the old loop re-reads `stopped`, finds
    // it false again, and carries on beside the new one — two loops, each
    // holding a worker thread of a node that has eight. A generation stamp is
    // the one thing an in-flight loop cannot mistake for its own.
    this.generation = (this.generation || 0) + 1;

    // The first job carries Pepecoin if pepecoind answers within its timeout;
    // otherwise the pool starts on Litecoin and Dogecoin and picks Pepecoin up
    // on a later poll. pollPep never throws.
    if (this.pep) await this.pollPep();
    // Soqucoin likewise.
    if (this.soq) await this.pollSoq();
    await this.refreshTemplate('startup');
    await this.reconcileBlocks();

    // Bind the socket BEFORE arming any background work, so a port clash
    // cannot leave timers running behind a failed start.
    this.server = net.createServer((socket) => this.onConnection(socket));
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        this.server.once('error', onError);
        this.server.listen(this.config.stratumPort, '0.0.0.0', () => {
          this.server.removeListener('error', onError);
          resolve();
        });
      });
    } catch (err) {
      this.server.close();
      this.server = null;
      throw err;
    }

    // Attach the long-lived error handler only once the socket is bound. An
    // EADDRINUSE re-emitted as an 'error' event on an EventEmitter with no
    // listener is thrown, which turns a recoverable port clash into a crash.
    // emitSafely covers the same hazard for later errors.
    this.server.on('error', (err) => this.emitSafely('error', err));

    // The rented-capacity port, if server.js configured one. Deliberately NOT
    // fatal on failure the way the primary bind above is: the home miners on
    // the primary port did nothing wrong, and losing them because a second,
    // optional port could not bind — a stale container from a crashed
    // previous run, a typo'd port number already taken by something else —
    // would be a worse outcome than simply not having that port this run.
    if (this.rentedPortLimits) {
      this.rentedServer = net.createServer((socket) => this.onConnection(socket, 'rented'));
      try {
        await new Promise((resolve, reject) => {
          const onError = (err) => reject(err);
          this.rentedServer.once('error', onError);
          this.rentedServer.listen(this.config.rentedStratumPort, '0.0.0.0', () => {
            this.rentedServer.removeListener('error', onError);
            resolve();
          });
        });
        this.rentedServer.on('error', (err) => this.emitSafely('error', err));
        this.log(`rented-capacity stratum listening on 0.0.0.0:${this.config.rentedStratumPort}`);
      } catch (err) {
        this.log(
          `could not bind the rented-capacity port ${this.config.rentedStratumPort} (${err.message}); ` +
            'continuing with the primary port only'
        );
        // Only the SERVER goes away here. `rentedPortLimits` deliberately
        // stays set: nothing calls onConnection with entry 'rented' once
        // this.rentedServer is null, so it is never used to accept a
        // connection — but snapshot() still needs it to tell "configured,
        // failed to bind" apart from "never configured" (see rentedServer vs
        // rentedStratumPort there), and a wrongly-nulled value here used to
        // collapse those into the same, silent, dashboard-invisible state.
        this.rentedServer = null;
      }
    }

    this.started = true;

    // Sample the combined hashrate once a minute. This is what the dashboard's
    // history charts are drawn from, and it is the only way to see that a
    // miner dropped out at three in the morning.
    this.sampleTimer = setInterval(() => {
      if (!this.store) return;
      let total = 0;
      // Per worker as well, so one board dropping out is visible on its own
      // line instead of as a dip in a combined figure that two other miners
      // are still holding up. Same name key the store uses everywhere else.
      const perWorker = new Map();
      for (const c of this.clients.values()) {
        if (!c.authorized) continue;
        const hr = this.clientHashrate(c);
        total += hr;
        perWorker.set(c.worker, (perWorker.get(c.worker) || 0) + hr);
      }
      const at = Date.now();
      this.store.recordSample(at, total);
      this.store.recordWorkerSamples(at, perWorker);
    }, 60000);
    this.sampleTimer.unref();

    // Every five minutes, not every thirty seconds: the whole file is rewritten
    // each time, and at 30s that is hundreds of megabytes of writes per day for
    // history nobody loses anyway — a block, a clean shutdown and a crash all
    // force an immediate save.
    this.saveTimer = setInterval(() => {
      if (this.store) this.store.save();
    }, 300000);
    this.saveTimer.unref();

    this.pingTimer = setInterval(() => {
      for (const c of this.clients.values()) if (c.entry !== 'rented') this.pingClient(c);
    }, this.config.pingIntervalMs);
    this.pingTimer.unref();

    // A second timer at the rented profile's own — much longer — interval. A
    // connection at rented difficulty is legitimately quiet for minutes, and
    // pinging it every 60s like a home ASIC would just be noise on a link
    // that is fine.
    if (this.rentedPortLimits) {
      this.rentedPingTimer = setInterval(() => {
        for (const c of this.clients.values()) if (c.entry === 'rented') this.pingClient(c);
      }, this.rentedPortLimits.pingIntervalMs);
      this.rentedPingTimer.unref();
    }

    // Skipped while a refresh is still in flight. Without this, a poll every
    // two seconds against a node whose getblocktemplate occasionally takes
    // longer than that stacks refreshes on top of each other, and it is the
    // overlap — not the frequency — that lets an older result land after a
    // newer one (see the ordering guard in onMergedTemplate).
    this.pollTimer = setInterval(() => {
      if (this.refreshInFlight) return;
      this.refreshInFlight = true;
      this.refreshTemplate('poll')
        .catch(() => {})
        .finally(() => { this.refreshInFlight = false; });
    }, this.config.pollIntervalMs);
    this.pollTimer.unref();
    if (this.pep) {
      this.pepTimer = setInterval(() => this.pollPep(), this.config.pepPollMs || 2000);
      this.pepTimer.unref();
    }
    if (this.soq) {
      this.soqTimer = setInterval(() => this.pollSoq(), this.config.soqPollMs || 1000);
      this.soqTimer.unref();
    }
    this.longPollLoop();
    if (this.wantsAuxLongpoll()) this.auxLongPollLoop();
    this.log(`stratum listening on 0.0.0.0:${this.config.stratumPort}`);
  }

  // The parent chain's half of startup: reachable node, real address, and a
  // Dogecoin daemon that actually speaks the aux RPCs.
  //
  // Every check here refuses to start rather than degrading. A merged pool that
  // silently falls back to one chain looks identical to a working one on the
  // dashboard while half the reward it was configured for is never claimed.
  async startMerged() {
    const info = await this.ltcRpc.call('getblockchaininfo');
    this.ltcChain =
      info.chain === 'regtest' ? 'ltc-regtest' : info.chain === 'test' ? 'ltc-test' : 'ltc-main';

    if (!this.config.ltcPayoutAddress) {
      throw new Error(
        'merged mining is on but LTC_PAYOUT_ADDRESS is not set; the Litecoin block reward has nowhere to go'
      );
    }
    // Deliberately checked against the LITECOIN version bytes. A Dogecoin
    // address decodes cleanly as base58check and would produce a perfectly
    // well-formed script — paying a hash160 nobody on Litecoin has the key
    // for. This is the quietest way to lose a whole block reward.
    this.ltcPayoutScript = u.addressToScript(this.config.ltcPayoutAddress, this.ltcChain);
    this.log(
      `merged mining: parent ${this.ltcChain} paying ${this.config.ltcPayoutAddress} ` +
        `(script ${this.ltcPayoutScript.toString('hex')}), aux Dogecoin paying ${this.config.payoutAddress}`
    );

    if (this.pep) {
      // Pepecoin's network follows Dogecoin's: a regtest pool merge-mines a
      // regtest Pepecoin. Derived here, not asked of pepecoind, so a Pepecoin
      // node that is down at startup costs nothing — not even the ability to
      // read a miner's Pepecoin address.
      this.pepChain = `pep-${this.chain}`;
      try {
        this.pepPayoutScript = u.addressToScript(this.pep.payoutAddress, this.pepChain);
        this.log(
          `merged mining: aux Pepecoin paying ${this.pep.payoutAddress} — optional: while pepecoind ` +
            'is unreachable, jobs carry Litecoin and Dogecoin only'
        );
      } catch (err) {
        // Optional chain, so a bad address switches Pepecoin off loudly
        // instead of refusing to start the Litecoin and Dogecoin pool.
        this.log(`Pepecoin DISABLED: PEP_PAYOUT_ADDRESS is not a ${this.pepChain} address (${err.message})`);
        this.pep = null;
      }
    }

    if (this.soqIgnored) this.log(this.soqIgnored);
    if (this.soq) {
      // Soqucoin follows Dogecoin's network too (regtest: sq1p…, the same
      // prefix as mainnet). Checked here, not by soqucoind: its createauxblock
      // would take a Base58 address and mine to an output nobody can spend.
      this.soqChain = `soq-${this.chain}`;
      try {
        this.soqPayoutScript = u.addressToScript(this.soq.payoutAddress, this.soqChain);
        this.log(
          `merged mining: aux Soqucoin paying ${this.soq.payoutAddress} — optional: while soqucoind ` +
            'is unreachable, jobs carry the other chains only'
        );
      } catch (err) {
        this.log(`Soqucoin DISABLED: SOQ_PAYOUT_ADDRESS is not a ${this.soqChain} address (${err.message})`);
        this.soq = null;
      }
    }

    if (this.publicMerged) {
      await this.startPublicMerged();
      return;
    }

    // Fail now if dogecoind cannot serve aux blocks — an old build, or one
    // without the wallet — instead of at the first template refresh.
    const probe = await this.rpc.call('createauxblock', [this.config.payoutAddress]);
    if (!probe || !/^[0-9a-f]{64}$/.test(String(probe.hash))) {
      throw new Error('createauxblock did not return an aux block hash');
    }
    // The chain ID the proof is checked against is a constant in merged.js;
    // if the daemon on the other end of this socket is not the chain that
    // constant describes, every proof we build is rejected.
    if (probe.chainid !== DOGE_CHAIN_ID) {
      throw new Error(
        `the aux node reports chain id ${probe.chainid}, not Dogecoin's ${DOGE_CHAIN_ID}`
      );
    }

    // A worker's username address cannot be honoured here. The parent coinbase
    // pays a LITECOIN script, and the aux coinbase is built by dogecoind from
    // the address given to createauxblock — so a Dogecoin address in a username
    // would either be pasted into a Litecoin block or ignored. Lock it, and say
    // so, rather than let the dashboard report a payout that is not happening.
    if (!this.config.lockPayoutAddress) {
      this.config.lockPayoutAddress = true;
      this.log('merged mining: per-worker payout addresses are disabled; both rewards go to the configured addresses');
    }
  }

  // Public merged startup. The Dogecoin block is built from dogecoind's
  // getblocktemplate (see public-merged.js), so that is what is probed — and
  // the probe builds a real aux block, so a template this code cannot turn into
  // a Dogecoin block refuses to start instead of failing at the first share.
  async startPublicMerged() {
    const pct = Number(this.config.poolFeePercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 10) {
      throw new Error(`POOL_FEE_PERCENT must be between 0 and 10, got ${this.config.poolFeePercent}`);
    }
    if (this.config.lockPayoutAddress) {
      throw new Error('PUBLIC_MERGED=1 pays every miner at its own addresses; it cannot run with LOCK_PAYOUT_ADDRESS=1');
    }
    this.poolFeePercent = pct;
    const probe = pm.buildAuxBlock(
      await this.rpc.call('getblocktemplate'),
      this.payoutScript, this.payoutScript, pct, this.config.coinbaseTag
    );
    if (probe.chainid !== DOGE_CHAIN_ID) {
      throw new Error(`the aux node does not describe chain ${DOGE_CHAIN_ID}`);
    }
    this.log(
      `PUBLIC merged mining: each miner is paid at the LTC and DOGE addresses in its username; ` +
        `pool fee ${pct}% to ${this.config.ltcPayoutAddress} (LTC) and ${this.config.payoutAddress} (DOGE)`
    );
  }

  // The Dogecoin half of a merged refresh. Private mode: dogecoind's own aux
  // block, exactly as before. Public mode: a Dogecoin template that the pool
  // builds one block per miner from.
  //
  // The template is REUSED until the Dogecoin tip moves, or its fees grew and
  // the job is due a rebuild anyway. A fresh getblocktemplate carries a new
  // curtime, hence a new aux hash; treating that as a new block would send
  // every miner clean_jobs every poll and throw their work away. This is the
  // same caching dogecoind itself applies to createauxblock.
  async fetchAuxBlock() {
    if (!this.publicMerged) {
      return this.rpc.call('createauxblock', [this.config.payoutAddress]);
    }
    const fresh = await this.rpc.call('getblocktemplate');
    const cur = this.currentJob && this.currentJob.dogeTemplate;
    let template = fresh;
    if (cur && cur.previousblockhash === fresh.previousblockhash) {
      const age = Date.now() - (this.currentJob.createdAt || 0);
      const worthIt = fresh.coinbasevalue > cur.coinbasevalue && age >= this.config.jobRebuildMs;
      if (!worthIt) template = cur;
    }
    // The pool's own view of the block: miner and fee both at the pool's
    // address. Only the hash, height and bits of it are used — for change
    // detection and the dashboard. Every miner is handed its own variant.
    const base = pm.buildAuxBlock(
      template, this.payoutScript, this.payoutScript, this.poolFeePercent, this.config.coinbaseTag
    );
    base.dogeTemplate = template;
    return base;
  }

  // Pepecoin's aux block, on its own timer. Never throws, never blocks the
  // Litecoin/Dogecoin path: every outcome is recorded on this.pep and the next
  // job is built from it.
  //
  // Private mode asks pepecoind for the block with createauxblock, exactly as
  // Dogecoin's is asked for. A changed hash rebuilds the job so the new block is
  // what miners commit to — without clean_jobs, because their Litecoin and
  // Dogecoin work is still good (see onMergedTemplate). The node going away
  // drops Pepecoin from the next job rather than carrying a stale block: an aux
  // block pepecoind no longer holds can never be submitted.
  async pollPep() {
    const pep = this.pep;
    if (!pep || pep.polling) return;
    pep.polling = true;
    const had = pep.block ? pep.block.hash : null;
    try {
      const block = await this.fetchPepBlock();
      if (pep.unavailableSince) {
        this.log(`the Pepecoin node is answering again after ${
          Math.round((Date.now() - pep.unavailableSince) / 1000)
        }s`);
      }
      pep.unavailableSince = null;
      pep.error = null;
      pep.block = block;
    } catch (err) {
      if (!pep.unavailableSince) {
        pep.unavailableSince = Date.now();
        this.log(`Pepecoin left out of new jobs: ${err.message}. Litecoin and Dogecoin mining continue.`);
      }
      pep.error = err.message;
      pep.block = null;
    } finally {
      pep.polling = false;
    }
    const now = pep.block ? pep.block.hash : null;
    if (now !== had && this.currentJob && !this.refreshInFlight) {
      // Under the same flag as the poll timer's refresh, so the two can never
      // overlap and land out of order. A change seen while one is in flight is
      // picked up by the next poll: the job remembers which block it carries.
      this.refreshInFlight = true;
      this.refreshTemplate(now ? 'pepecoin block' : 'pepecoin gone')
        .catch(() => {})
        .finally(() => { this.refreshInFlight = false; });
    }
  }

  async fetchPepBlock() {
    if (this.publicMerged) {
      // Public mode, as for Dogecoin: the pool builds each miner's Pepecoin
      // block itself from getblocktemplate (pm.buildAuxBlock with chain 63).
      // The template is reused until the tip moves, or fees grew and the last
      // one is older than a job rebuild — a fresh template has a new curtime
      // and so a new hash, and treating every poll as a new block would
      // rebuild every miner's job every two seconds.
      const fresh = await this.pep.rpc.call('getblocktemplate');
      const cur = this.pep.block && this.pep.block.pepTemplate;
      let template = fresh;
      if (cur && cur.previousblockhash === fresh.previousblockhash) {
        const age = Date.now() - (this.pep.templateAt || 0);
        const worthIt = fresh.coinbasevalue > cur.coinbasevalue && age >= this.config.jobRebuildMs;
        if (!worthIt) template = cur;
      }
      if (template === fresh) this.pep.templateAt = Date.now();
      // buildAuxBlock refuses a template that does not carry chain id 63.
      const base = pm.buildAuxBlock(
        template, this.pepPayoutScript, this.pepPayoutScript, this.poolFeePercent, this.config.coinbaseTag, PEP_CHAIN_ID
      );
      base.pepTemplate = template;
      return base;
    }
    const block = await this.pep.rpc.call('createauxblock', [this.pep.payoutAddress]);
    if (!block || !/^[0-9a-f]{64}$/.test(String(block.hash))) {
      throw new Error('pepecoind createauxblock did not return an aux block hash');
    }
    this.checkAuxAnswer(block, 'pepecoind');
    // The tree puts each chain at the slot its own id dictates; a daemon that
    // is not Pepecoin would be committed to at the wrong slot and every proof
    // refused. Treated like an outage: left out, said out loud.
    if (block.chainid !== PEP_CHAIN_ID) {
      throw new Error(`the node at PEP_RPC_HOST reports chain id ${block.chainid}, not Pepecoin's ${PEP_CHAIN_ID}`);
    }
    return block;
  }

  // Soqucoin's aux block: pollPep's twin, private mode only (see the
  // constructor), so always createauxblock. A changed hash rebuilds the job
  // without clean_jobs; soqucoind going away drops Soqucoin from the next job.
  async pollSoq() {
    const soq = this.soq;
    if (!soq || soq.polling) return;
    soq.polling = true;
    const had = soq.block ? soq.block.hash : null;
    try {
      const block = await this.fetchSoqBlock();
      if (soq.unavailableSince) {
        this.log(`the Soqucoin node is answering again after ${
          Math.round((Date.now() - soq.unavailableSince) / 1000)
        }s`);
      }
      soq.unavailableSince = null;
      soq.error = null;
      soq.block = block;
    } catch (err) {
      if (!soq.unavailableSince) {
        soq.unavailableSince = Date.now();
        this.log(`Soqucoin left out of new jobs: ${err.message}. The other chains are mined as before.`);
      }
      soq.error = err.message;
      soq.block = null;
      // A node that comes back may be a different one; ask again.
      soq.networkChecked = false;
    } finally {
      soq.polling = false;
    }
    const now = soq.block ? soq.block.hash : null;
    if (now !== had && this.currentJob && !this.refreshInFlight) {
      // See pollPep: one refresh at a time.
      this.refreshInFlight = true;
      this.refreshTemplate(now ? 'soqucoin block' : 'soqucoin gone')
        .catch(() => {})
        .finally(() => { this.refreshInFlight = false; });
    }
  }

  async fetchSoqBlock() {
    // Once per spell of availability: is this soqucoind on the pool's network?
    // Mainnet, testnet and regtest share the sq1 address prefix and the chain
    // id, so nothing else would notice a mainnet pool mining testnet SOQ.
    if (!this.soq.networkChecked) {
      const info = await this.soq.rpc.call('getblockchaininfo');
      if (!info || info.chain !== this.chain) {
        throw new Error(`the node at SOQ_RPC_HOST is on ${info && info.chain}, this pool on ${this.chain}`);
      }
      this.soq.networkChecked = true;
    }
    const block = await this.soq.rpc.call('createauxblock', [this.soq.payoutAddress]);
    if (!block || !/^[0-9a-f]{64}$/.test(String(block.hash))) {
      throw new Error('soqucoind createauxblock did not return an aux block hash');
    }
    if (block.chainid !== SOQ_CHAIN_ID) {
      throw new Error(`the node at SOQ_RPC_HOST reports chain id ${block.chainid}, not Soqucoin's ${SOQ_CHAIN_ID}`);
    }
    this.checkAuxAnswer(block, 'soqucoind');
    return block;
  }

  // The rest of a createauxblock answer, checked before any of it is used. A
  // node that is broken or not what it claims could otherwise hand back a
  // target so easy that every share becomes a block candidate — a submission,
  // a log line, a saved record and a push for each — or a height that ends up
  // in the dashboard. Its target may be no easier than the chain's own
  // minimum difficulty (powLimit ~uint256(0) >> 20 on mainnet and testnet,
  // the same for Dogecoin, Pepecoin and Soqucoin; 0x7fff… on regtest).
  checkAuxAnswer(block, daemon) {
    if (!/^[0-9a-f]{8}$/.test(String(block.bits))) {
      throw new Error(`${daemon} returned bits ${JSON.stringify(block.bits)}, not 8 hex digits`);
    }
    const limit = u.targetFromBits(this.chain === 'regtest' ? '207fffff' : '1e0fffff');
    if (u.targetFromBits(block.bits) > limit) {
      throw new Error(`${daemon} returned a target easier than the chain allows (bits ${block.bits})`);
    }
    if (!Number.isSafeInteger(block.height) || block.height <= 0) {
      throw new Error(`${daemon} returned height ${JSON.stringify(block.height)}`);
    }
    if (!Number.isSafeInteger(block.coinbasevalue) || block.coinbasevalue < 0) {
      throw new Error(`${daemon} returned coinbase value ${JSON.stringify(block.coinbasevalue)}`);
    }
  }

  // Ask the node about every block we recorded but never resolved.
  //
  // A crash, a power cut or a kill during the submit-retry window leaves a
  // record stuck at "submitting", and a submission that exhausted its retries
  // can still end up on the chain via a peer. Without this, blocksFound — which
  // is derived from these records — undercounts a block you actually mined,
  // permanently and silently.
  async reconcileBlocks() {
    if (!this.store) return;
    const unresolved = this.store.state.blocks.filter(
      (b) => b && b.hash && b.accepted !== true
    );
    if (!unresolved.length) return;

    let resolved = 0;
    for (const b of unresolved) {
      // Ask the chain the block belongs to. Records written before merged mode
      // existed carry no `chain` and are Dogecoin's. Asking dogecoind about a
      // Litecoin hash gets an honest "not found", which would rewrite a good
      // block to "the node does not have this block" on every restart.
      const rpc =
        b.chain === 'LTC'
          ? this.ltcRpc
          : b.chain === 'PEP'
            ? this.pep && this.pep.rpc
            : b.chain === 'SOQ'
              ? this.soq && this.soq.rpc
              : this.rpc;
      if (!rpc) continue;
      try {
        const block = await rpc.call('getblock', [b.hash]);
        // confirmations is -1 for a block the node knows but that is not on the
        // main chain, which is exactly the orphaned case.
        if (block && block.confirmations >= 1) {
          this.store.updateBlock(b.hash, { status: 'accepted', accepted: true, error: null });
          resolved++;
          this.log(`block ${b.height} was on the chain after all — ${b.hash}`);
        } else if (b.status === 'submitting') {
          this.store.updateBlock(b.hash, {
            status: 'stale',
            accepted: false,
            error: 'valid, but another block reached this height first',
          });
        }
      } catch {
        // The node does not have it. If we never finished submitting, say so
        // honestly rather than leaving it as "submitting" forever.
        if (b.status === 'submitting') {
          this.store.updateBlock(b.hash, {
            status: 'error',
            accepted: false,
            error: 'submission was interrupted; the node does not have this block',
          });
        }
      }
    }

    this.store.save(true);
    this.stats.blocks = this.store.state.blocks.slice();
    this.stats.blocksFound = this.store.blocksFound();
    if (resolved) this.log(`reconciled ${resolved} block(s) against the node at startup`);
  }

  stop() {
    clearInterval(this.pollTimer);
    clearInterval(this.pepTimer);
    clearInterval(this.soqTimer);
    clearInterval(this.sampleTimer);
    clearInterval(this.saveTimer);
    clearInterval(this.pingTimer);
    clearInterval(this.rentedPingTimer);
    this.pollTimer = null;
    // Force a final write: an update or a reboot must not cost the last half
    // minute of history.
    if (this.store) this.store.save(true);
    // Ends the longpoll loop; without it an abandoned instance keeps polling
    // the node forever.
    this.stopped = true;
    this.started = false;
    if (this.server) this.server.close();
    if (this.rentedServer) this.rentedServer.close();
    for (const c of this.clients.values()) {
      clearTimeout(c.handshakeTimer);
      c.socket.destroy();
    }
  }

  // Stop taking new work, without tearing anything down yet.
  //
  // Order matters at shutdown. Draining while the stratum port is still open
  // means miners keep submitting, the counter never reaches zero, and the drain
  // burns its whole timeout for nothing — after which every share that finishes
  // a moment later is thrown away.
  beginShutdown() {
    this.draining = true;
    if (this.server) {
      try { this.server.close(); } catch { /* already closed */ }
    }
    if (this.rentedServer) {
      try { this.rentedServer.close(); } catch { /* already closed */ }
    }
  }

  // Resolves once nothing is in progress, or after `timeoutMs`.
  //
  // This counts BLOCK SUBMISSIONS as well as share validation. Submission is
  // the slow one — six attempts with backoff, up to about two minutes — and it
  // is the only thing here whose loss actually costs money. Exiting while a
  // submitblock retry is pending means the block never reaches the chain.
  async drain(timeoutMs = 130000) {
    const deadline = Date.now() + timeoutMs;
    while (this.pending() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.pending() === 0;
  }

  pending() {
    return (this.inFlight || 0) + (this.inFlightBlocks || 0);
  }

  // Node throws when an 'error' event has no listener. That is a sensible
  // default for application code and a terrible one for a background service,
  // so errors are logged when nobody is listening rather than fatal.
  recordNodeLatency(ms) {
    if (!this.nodeLatency) this.nodeLatency = [];
    this.nodeLatency.push(ms);
    if (this.nodeLatency.length > 20) this.nodeLatency.shift();
  }

  medianNodeLatency() {
    if (!this.nodeLatency || !this.nodeLatency.length) return null;
    const sorted = [...this.nodeLatency].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  // Round-trip time to a miner. Stratum v1 has no ping, but `client.get_version`
  // is a server-to-client request that firmware answers, which makes it the
  // only honest way to measure the link. Miners that ignore it simply report no
  // latency rather than a made-up number.
  pingClient(client) {
    if (!client.authorized || client.socket.destroyed) return;
    // Random, not sequential: a predictable id lets a client answer a ping it
    // was never sent and report whatever latency flatters it.
    const id = `ping-${crypto.randomBytes(8).toString('hex')}`;
    client.pendingPing = { id, sentAt: Date.now() };
    this.send(client, { id, method: 'client.get_version', params: [] });
    // If the miner never answers, stop claiming we are waiting.
    setTimeout(() => {
      if (client.pendingPing && client.pendingPing.id === id) {
        client.pendingPing = null;
        if (client.supportsGetVersion) {
          // This miner does answer, so silence means the link went quiet —
          // exactly what this number exists to surface. Showing the last good
          // round-trip would hide it.
          client.latencyMs = null;
          client.latencyFrom = null;
        }
        // Firmware that never answers keeps its handshake estimate. Wiping it
        // every 30 seconds is what left this column empty for both of the
        // miners actually connected to this pool.
      }
    }, 15000).unref();
  }

  // Smoothed network difficulty. Dogecoin retargets EVERY block (DigiShield,
  // damped by 1/8), so the instantaneous value swings by tens of percent within
  // minutes. Deriving "expected wait" from a single sample makes that number
  // jump around for no real reason.
  recordNetworkDifficulty(difficulty, prevHash) {
    if (!(difficulty > 0)) return;
    if (!this.difficultyHistory) this.difficultyHistory = [];
    // De-duplicate by tip hash. A reorg swaps the tip back and forth, and
    // without this the same height is sampled twice and skews the mean.
    if (prevHash && this.difficultySeen && this.difficultySeen.has(prevHash)) return;
    if (prevHash) {
      if (!this.difficultySeen) this.difficultySeen = new Set();
      this.difficultySeen.add(prevHash);
      if (this.difficultySeen.size > 200) {
        this.difficultySeen.delete(this.difficultySeen.values().next().value);
      }
    }
    this.difficultyHistory.push(difficulty);
    if (this.difficultyHistory.length > 60) this.difficultyHistory.shift();
  }

  // Null until there is enough history to be worth calling an average. The
  // dashboard falls back to the instantaneous value, which is honest; claiming
  // a "recent average" built from one sample is not.
  smoothedDifficulty() {
    const h = this.difficultyHistory;
    if (!h || h.length < 10) return null;
    return h.reduce((a, b) => a + b, 0) / h.length;
  }

  // Two hazards, not one. Emitting 'error' with no listener THROWS in Node, and
  // a listener that throws propagates into whatever called emit — which on the
  // block path is the code submitting the block. Guarding only the first, which
  // this used to do, left the comments at the call sites promising a protection
  // that did not exist.
  emitSafely(event, payload) {
    if (this.listenerCount(event) === 0) {
      // An unlistened 'error' carries an Error; the block events carry a record.
      // Interpolating an object straight into a template gives "[object
      // Object]", which is exactly the wrong thing to find in a log after a
      // block. Describe what is actually there.
      const detail = payload && payload.message ? payload.message
        : payload && payload.height ? `height ${payload.height} (${payload.hash || 'no hash'})`
        : String(payload);
      this.log(`${event}: ${detail}`);
      return;
    }
    try {
      this.emit(event, payload);
    } catch (err) {
      this.log(`a ${event} listener threw (${err.message}); continuing`);
    }
  }

  log(msg) {
    // eslint-disable-next-line no-console
    console.log(`[pool] ${msg}`);
  }

  // For lines an unauthenticated peer can cause: connections, disconnections,
  // refusals. Connect-and-drop in a loop otherwise writes tens of megabytes a
  // second into the container log, which fills the disk and — worse — pushes
  // out the BLOCK HEX line that is the last resort for recovering a block.
  // Beyond the budget the lines are counted and summarised once a minute.
  churnLog(msg) {
    const now = Date.now();
    if (!this.churnWindowAt || now - this.churnWindowAt >= 60000) {
      if (this.churnSuppressed) {
        this.log(`(${this.churnSuppressed} more connection events in the last minute)`);
      }
      this.churnWindowAt = now;
      this.churnCount = 0;
      this.churnSuppressed = 0;
    }
    if (this.churnCount < CHURN_LOG_PER_MINUTE) {
      this.churnCount++;
      this.log(msg);
    } else {
      this.churnSuppressed = (this.churnSuppressed || 0) + 1;
    }
  }

  // The live half of a statistics reset.
  //
  // The store holds the durable copy, but these counters are seeded from it at
  // startup and then live in memory, and the dashboard reads THESE. Clearing
  // only the file would show a zero for a few seconds and then the old number
  // again on the next poll — which looks exactly like a reset that silently
  // failed.
  //
  // Note what is left alone: `shareTimes`. It is not a statistic, it is the
  // input to the hashrate estimate and to vardiff. Clearing it would drop every
  // worker's hashrate to zero for minutes and hand vardiff a two-sample guess
  // to retune from, so a cosmetic reset would briefly cost real difficulty
  // accuracy. Blocks are untouched here for the reasons given in store.reset.
  resetStats(scope = {}) {
    // Nothing asked for, nothing stamped. A `resetAt` set by a request that
    // cleared nothing would make the dashboard label lifetime totals "since
    // reset" — a label that is worse than no label, because it is believed.
    if (!scope.counters && !scope.best && !scope.history) return false;
    if (scope.counters) {
      this.stats.accepted = 0;
      this.stats.rejected = 0;
      this.stats.rejectReasons = {};
      for (const c of this.clients.values()) {
        c.accepted = 0;
        c.rejected = 0;
        c.rejectReasons = {};
      }
    }
    if (scope.best) {
      this.stats.bestShareDiff = 0;
      this.stats.bestShareAt = null;
      this.stats.chainBest = {};
      for (const c of this.clients.values()) c.bestShareDiff = 0;
    }
    this.stats.resetAt = Date.now();
    return true;
  }

  // ---------------------------------------------------------------- templates

  async refreshTemplate(reason) {
    if (this.merged) return this.refreshMergedTemplate(reason, null);
    try {
      const askedAt = Date.now();
      const template = await this.rpc.getBlockTemplate();
      // How long your node takes to hand over a template. If this climbs, the
      // node is the bottleneck, not the miners — and a slow template means
      // mining on stale work after somebody else finds a block.
      this.recordNodeLatency(Date.now() - askedAt);
      // Log the recovery, not just the failure. For an unattended run this is
      // the pair of lines that explains a gap in the share history.
      if (this.stats.templateError) {
        this.log(`the Dogecoin node is answering again after ${
          Math.round((Date.now() - (this.stats.templateFailedAt || Date.now())) / 1000)
        }s`);
      }
      // The job FIRST, then the "everything is fine" bookkeeping.
      //
      // Written the other way round, a getblocktemplate that answers while job
      // construction throws — a malformed template, an arithmetic edge in the
      // target — would clear templateError and stamp a fresh lastTemplateAt on
      // its way to failing. The pool would then look perfectly healthy while no
      // miner had been given work since the last tip move. Here the throw is
      // caught below and becomes a template error, which is what it is.
      this.onTemplate(template, reason);
      this.stats.templateError = null;
      this.stats.templateErrorKind = null;
      this.stats.templateFailedAt = null;
      this.stats.lastTemplateAt = Date.now();
    } catch (err) {
      // Forget the latency window while the node is unreachable, so the
      // dashboard cannot show a healthy round-trip next to a template error.
      this.nodeLatency = [];
      // Log the FIRST failure of an outage at any severity, then stay quiet so
      // a long outage does not fill the log. Previously a poll failure was
      // silent, so a node that went away left no trace at all.
      if (!this.stats.templateError) {
        this.stats.templateFailedAt = Date.now();
        this.log(`cannot reach the Dogecoin node (${reason}): ${err.message}`);
      }
      this.stats.templateError = err.message;
      throw err;
    }
  }

  // The merged equivalent, kept as a separate function so the Dogecoin-only
  // path above is not made conditional.
  //
  // The two chains are fetched SEPARATELY and fail separately, which matters
  // more than it looks. Litecoin is the chain being hashed: if the parent tip
  // moves and we do not rebuild, every miner keeps working on a header whose
  // previous block is orphaned, and every Litecoin block found in that window
  // is worthless. Dogecoin going away must therefore not stop the parent job
  // from being rebuilt — a stale aux commitment is just opaque bytes to
  // Litecoin, so the last known aux hash is carried forward and only the
  // Dogecoin half is at risk while dogecoind is down.
  //
  // `template` is passed in by the longpoll loop, which has just been handed a
  // fresh one and must not ask for another.
  async refreshMergedTemplate(reason, template) {
    const askedAt = Date.now();
    let parent;
    try {
      parent = template || (await this.ltcRpc.call('getblocktemplate', [{ rules: LTC_RULES }]));
    } catch (err) {
      this.nodeLatency = [];
      this.noteTemplateFailure(`cannot reach the Litecoin node (${reason}): ${err.message}`, err);
      throw err;
    }

    // Polled rather than longpolled: dogecoind has no longpoll for aux blocks.
    // It caches internally and hands back the same block until its own tip or
    // mempool moves, so this is cheap.
    let auxBlock = null;
    try {
      auxBlock = await this.fetchAuxBlock();
      if (this.auxUnavailableSince) {
        this.log(`the Dogecoin node is answering again after ${
          Math.round((Date.now() - this.auxUnavailableSince) / 1000)
        }s`);
      }
      this.auxUnavailableSince = null;
    } catch (err) {
      // Keep mining Litecoin on the last aux commitment we had. A Dogecoin
      // block found now would be refused — dogecoind forgets an aux block once
      // its tip moves — but a Litecoin block found now is worth just as much as
      // ever, and stopping would forfeit both.
      auxBlock = this.currentJob && this.currentJob.auxBlock ? this.currentJob.auxBlock : null;
      if (!this.auxUnavailableSince) {
        this.auxUnavailableSince = Date.now();
        this.log(
          `cannot reach the Dogecoin node (${reason}): ${err.message}` +
            (auxBlock ? '; continuing on Litecoin with the last aux block' : '')
        );
      }
      if (!auxBlock) {
        this.noteTemplateFailure(null, err);
        throw err;
      }
    }

    this.recordNodeLatency(Date.now() - askedAt);

    // 2: the aux chain being unreachable is NOT a template error — the parent
    // job is fine and Litecoin mining continues — but it must not therefore be
    // invisible. The dashboard shows a Dogecoin height that has stopped moving
    // and everything else green; without this the operator has no way to tell
    // that half the app is dead, and the worst case is a node that answers but
    // is in initial download, where its tip IS moving and every Dogecoin share
    // is doomed.
    this.stats.auxError = this.auxUnavailableSince
      ? `the Dogecoin node has been unreachable for ${
          Math.round((Date.now() - this.auxUnavailableSince) / 1000)
        }s — Litecoin mining continues, Dogecoin blocks cannot be submitted`
      : null;

    // Build and broadcast the job BEFORE declaring the pool healthy.
    //
    // This call used to sit outside any try, after templateError had already
    // been cleared and lastTemplateAt already stamped — and every caller
    // swallows what it throws (the poll with `.catch(() => {})`, both longpoll
    // loops with their own catch). So a persistent failure to turn a template
    // into a job — a field the MergedJob constructor cannot read, a target that
    // will not decode, an over-long coinbase — meant miners were never
    // re-notified after a tip move, every share they returned was worthless,
    // and the dashboard, the healthcheck and the alarm all reported a perfectly
    // healthy pool indefinitely. The Dogecoin-only path never had this hole,
    // because onTemplate is inside its try; now neither does this one.
    try {
      this.onMergedTemplate(parent, auxBlock, reason, askedAt);
    } catch (err) {
      this.noteTemplateFailure(
        `the block template could not be turned into a job (${reason}): ${err.message}`,
        err,
        'unusable'
      );
      throw err;
    }

    if (this.stats.templateError) {
      this.log(`the mining nodes are answering again after ${
        Math.round((Date.now() - (this.stats.templateFailedAt || Date.now())) / 1000)
      }s`);
    }
    this.stats.templateError = null;
    this.stats.templateErrorKind = null;
    this.stats.templateFailedAt = null;
    // Cleared on success as well: without this the next failure is compared
    // against a timestamp from the previous outage and suppressed.
    this.templateLoggedAt = null;
    this.templateLoggedMessage = null;
    // Only now is it true that work reached the miners. This timestamp is what
    // the health monitor reads as "the pool is getting work", so it has to mean
    // a job was installed rather than merely that an RPC answered.
    this.stats.lastTemplateAt = Date.now();
  }

  // One place to record a template failure, so the "log it once" rule actually
  // holds. The longpoll loop clears templateError before each attempt, so a
  // guard that only checks templateError logged on every iteration — about
  // thirty lines a minute, forever, which is exactly what pushes the BLOCK HEX
  // recovery line out of a rotating container log.
  noteTemplateFailure(message, err, kind = 'unreachable') {
    const now = Date.now();
    // What KIND of failure this is, so the dashboard and the alarm do not have
    // to guess from the text. "Cannot reach the Litecoin node: merged coinbase
    // scriptSig would be 148 bytes" is a sentence that sends someone to restart
    // a node app that is answering perfectly well.
    this.stats.templateErrorKind = kind;
    // Deduped on the MESSAGE as well as on time. Time alone means a flapping
    // node — fail, recover, fail again within the minute — logs the first
    // failure and then goes quiet, leaving "the mining nodes are answering
    // again" as the last line while the node is down at that moment.
    const same = message === this.templateLoggedMessage;
    if (message && (!same || !this.templateLoggedAt || now - this.templateLoggedAt > 60000)) {
      this.templateLoggedMessage = message;
      this.templateLoggedAt = now;
      this.log(message);
    }
    if (!this.stats.templateFailedAt) this.stats.templateFailedAt = now;
    this.stats.templateError = err.message;
  }

  onMergedTemplate(template, auxBlock, reason, askedAt = Date.now()) {
    // Ordering, not just difference.
    //
    // The poll and the longpoll both call this, neither awaits the other, and
    // an RPC that stalls can deliver its answer after a later one has already
    // been applied. `isNewBlock` below tests INEQUALITY of the previous-block
    // hash, so a late answer describing the PREVIOUS tip reads as "new block"
    // and gets installed and broadcast with clean_jobs — putting every miner
    // back on an orphaned parent until the next refresh. Dogecoin submissions
    // would still succeed (Dogecoin never validates the parent chain), so the
    // dashboard would look perfectly healthy while the Litecoin half mined a
    // dead branch.
    //
    // A result that was requested BEFORE the installed job's request and that
    // would move either chain backwards is therefore dropped. A genuine reorg
    // to a lower height still installs: it arrives on a fetch started after
    // the current job's, so the first condition is false.
    if (
      this.currentJob &&
      askedAt < (this.currentJob.fetchedAt || 0) &&
      (template.height < this.currentJob.height ||
        (auxBlock && auxBlock.height < this.currentJob.auxHeight))
    ) {
      return;
    }
    if (template.longpollid) this.lastLongpollId = template.longpollid;

    // EITHER tip moving invalidates the job. The aux hash covers the Dogecoin
    // side: it changes when Dogecoin's tip moves and also when its mempool
    // does, and continuing to commit to a superseded aux block means every
    // Dogecoin block we find is refused.
    const isNewBlock =
      !this.currentJob ||
      this.currentJob.template.previousblockhash !== template.previousblockhash ||
      this.currentJob.auxHash !== auxBlock.hash;

    // Pepecoin, when it is configured and its node answered: the block current
    // at this moment (pollPep). A new Pepecoin block on its own rebuilds the
    // job but is NOT a new block for the miners — their Litecoin and Dogecoin
    // work is untouched by it — so it goes out without clean_jobs and nothing
    // they are hashing is thrown away.
    const pepBlock = this.pep && this.pep.block ? this.pep.block : null;
    const pepHash = pepBlock ? pepBlock.hash : null;
    const pepChanged = !!this.currentJob && (this.currentJob.pepHash || null) !== pepHash;
    // Soqucoin in the same way (private mode only; this.soq is null otherwise).
    const soqBlock = this.soq && this.soq.block ? this.soq.block : null;
    const soqHash = soqBlock ? soqBlock.hash : null;
    const soqChanged = !!this.currentJob && (this.currentJob.soqHash || null) !== soqHash;

    if (!isNewBlock && !pepChanged && !soqChanged) {
      const ageMs = Date.now() - this.currentJob.createdAt;
      const gainedValue = template.coinbasevalue > this.currentJob.coinbaseValue;
      if (!gainedValue && ageMs < this.config.jobRebuildMs) return;
    }

    const extraAux = pepBlock ? [{ name: 'PEP', chainId: PEP_CHAIN_ID, block: pepBlock }] : [];
    if (soqBlock) extraAux.push({ name: 'SOQ', chainId: SOQ_CHAIN_ID, block: soqBlock });
    const id = (++this.jobCounter).toString(16).padStart(8, '0');
    const job = this.publicMerged
      ? new MergedJob(id, template, this.ltcPayoutScript, this.config.coinbaseTag, auxBlock, {
          fee: { script: this.ltcPayoutScript, percent: this.poolFeePercent },
          extraAux,
        })
      : new MergedJob(id, template, this.ltcPayoutScript, this.config.coinbaseTag, auxBlock, { extraAux });
    job.pepHash = pepHash;
    job.soqHash = soqHash;
    // Public mode: the Dogecoin template every miner's own aux block is built
    // from. Kept on the job so a variant is always built from the same
    // template as the job it belongs to. Pepecoin's likewise.
    if (this.publicMerged) job.dogeTemplate = auxBlock.dogeTemplate;
    if (this.publicMerged && pepBlock) job.pepTemplate = pepBlock.pepTemplate;
    // When this job's data was ASKED for, not when it was built: the ordering
    // guard above compares request times, and a slow RPC would otherwise make
    // a stale answer look newer than the fresh one it overtook.
    job.fetchedAt = askedAt;
    this.jobs.set(id, job);
    this.currentJob = job;
    // Dogecoin's difficulty, keyed on Dogecoin's tip: this is a Dogecoin app,
    // and "expected wait" means the wait for a Dogecoin block.
    if (isNewBlock) this.recordNetworkDifficulty(job.auxDifficulty, auxBlock.previousblockhash);

    while (this.jobs.size > JOB_HISTORY) {
      this.jobs.delete(this.jobs.keys().next().value);
    }

    if (isNewBlock) {
      this.log(
        `new merged job — Dogecoin height ${job.auxHeight} (difficulty ` +
          `${job.auxDifficulty.toFixed(0)}), Litecoin height ${job.height} (difficulty ` +
          `${job.networkDifficulty.toFixed(0)})` +
          (pepBlock ? `, Pepecoin height ${pepBlock.height}` : '') +
          (soqBlock ? `, Soqucoin height ${soqBlock.height}` : '') +
          ` (${reason})`
      );
    }

    for (const client of this.clients.values()) {
      if (client.authorized) this.sendJob(client, job, isNewBlock);
    }
  }

  onTemplate(template, reason) {
    // Always record this, even when we decide not to rebuild the job below.
    if (template.longpollid) this.lastLongpollId = template.longpollid;

    const isNewBlock =
      !this.currentJob ||
      this.currentJob.template.previousblockhash !== template.previousblockhash;

    // Without a new block, only rebuild if there is something to gain: more fees
    // in the template, or the job is getting stale. Rebuilding constantly would
    // reset every miner's nonce search for nothing.
    if (!isNewBlock) {
      const ageMs = Date.now() - this.currentJob.createdAt;
      const gainedValue = template.coinbasevalue > this.currentJob.coinbaseValue;
      if (!gainedValue && ageMs < this.config.jobRebuildMs) return;
    }

    const id = (++this.jobCounter).toString(16).padStart(8, '0');
    const job = new Job(id, template, this.payoutScript, this.config.coinbaseTag);
    this.jobs.set(id, job);
    this.currentJob = job;
    if (isNewBlock) this.recordNetworkDifficulty(job.networkDifficulty, template.previousblockhash);

    // Keep a short history so shares still in flight when a job rotates are not
    // thrown away as "job not found".
    while (this.jobs.size > JOB_HISTORY) {
      this.jobs.delete(this.jobs.keys().next().value);
    }

    if (isNewBlock) {
      this.log(
        `new block on the network — height ${job.height}, ` +
          `network difficulty ${job.networkDifficulty.toFixed(0)} (${reason})`
      );
    }

    for (const client of this.clients.values()) {
      if (client.authorized) this.sendJob(client, job, isNewBlock);
    }
  }

  // The job a specific client must be given. A worker that supplied its own
  // payout address mines its own coinbase, so it must be NOTIFIED with that
  // coinbase too — sending one coinbase and validating against another yields a
  // different merkle root and rejects every share the worker submits.
  clientJob(client, job) {
    if (this.publicMerged) return this.publicJobForClient(job, client);
    return client.payoutScript ? this.jobForClient(job, client) : job;
  }

  // Public merged: the miner's own Litecoin coinbase (99% to it, the fee to
  // the pool) committing to the miner's own Dogecoin block (the same split).
  // Cached per address pair on the job, like jobForClient; the number of pairs
  // is capped at authorize time.
  publicJobForClient(job, client) {
    if (!client.ltcPayoutScript || !client.payoutScript || !job.dogeTemplate) {
      // Unreachable for an authorized public client; refusing is the only
      // safe answer, because the base job pays the pool.
      throw new Error('public merged job requested for a client without both payout addresses');
    }
    const key = this.payoutKey(client.ltcPayoutScript, client.payoutScript, client.pepPayoutScript);
    if (!job.variants) job.variants = new Map();
    const cached = job.variants.get(key);
    if (cached) return cached;
    const auxBlock = pm.buildAuxBlock(
      job.dogeTemplate, client.payoutScript, this.payoutScript, this.poolFeePercent, this.config.coinbaseTag
    );
    // Pepecoin for the miners who gave a Pepecoin address, built the same way:
    // 99% to them, the fee to the pool. A miner without one — or any miner
    // while pepecoind is down — gets the Litecoin + Dogecoin job it always got.
    const extraAux = [];
    if (job.pepTemplate && client.pepPayoutScript) {
      const pepBlock = pm.buildAuxBlock(
        job.pepTemplate, client.pepPayoutScript, this.pepPayoutScript, this.poolFeePercent,
        this.config.coinbaseTag, PEP_CHAIN_ID
      );
      extraAux.push({ name: 'PEP', chainId: PEP_CHAIN_ID, block: pepBlock });
    }
    const variant = new MergedJob(job.id, job.template, client.ltcPayoutScript, this.config.coinbaseTag, auxBlock, {
      fee: { script: this.ltcPayoutScript, percent: this.poolFeePercent },
      extraAux,
    });
    variant.dogeTemplate = job.dogeTemplate;
    variant.pepTemplate = job.pepTemplate || null;
    job.variants.set(key, variant);
    return variant;
  }

  // One payout set, one key: the Litecoin and Dogecoin scripts, plus the
  // Pepecoin one when the miner gave it. Two miners with the same LTC/DOGE pair
  // but different Pepecoin addresses mine different coinbases, so they must not
  // share a cached variant.
  payoutKey(ltcScript, dogeScript, pepScript) {
    const base = `${ltcScript.toString('hex')}:${dogeScript.toString('hex')}`;
    return pepScript ? `${base}:${pepScript.toString('hex')}` : base;
  }

  async longPollLoop() {
    const generation = this.generation;
    while (!this.stopped && this.generation === generation) {
      // Track the longpollid from the LATEST template we received, not from the
      // current job. Those diverge: onTemplate deliberately keeps the existing
      // job when a new template brings nothing worth interrupting miners for.
      // Longpolling with a spent id returns instantly, so reading the id off
      // the job turns this loop into an unthrottled hammer on the node's RPC —
      // which is exactly how you exhaust its four worker threads and make every
      // other caller fail with "Work queue depth exceeded".
      const id = this.lastLongpollId;
      if (!id) {
        await sleep(1000);
        continue;
      }
      const startedAt = Date.now();
      try {
        // In merged mode this longpolls LITECOIN — the parent tip is the one
        // that invalidates the header miners are hashing. Dogecoin's tip is
        // caught by the createauxblock poll instead, which is the only
        // mechanism dogecoind offers.
        const template = await (this.merged ? this.ltcLongpollRpc : this.longpollRpc).call(
          'getblocktemplate',
          [{ longpollid: id, rules: this.merged ? LTC_RULES : [] }]
        );
        // Deliberately NOT stamping lastTemplateAt or clearing templateError
        // here. A longpoll returning means an RPC answered, not that a job
        // reached the miners — and the refresh below is what decides that. The
        // health monitor reads those two fields, so setting them from here made
        // a pool that answers but never installs a job look healthy forever.
        if (this.merged) {
          await this.refreshMergedTemplate('longpoll', template);
        } else {
          this.onTemplate(template, 'longpoll');
          // Stamped after the job exists, for the reason above.
          this.stats.lastTemplateAt = Date.now();
        }
      } catch (err) {
        // A timeout here is normal and expected; anything else deserves a pause
        // so a broken node does not turn into a busy loop.
        if (err.code !== 'ETIMEDOUT') await sleep(2000);
      }
      // Belt and braces: however the call ended, never issue more than a few
      // longpolls per second. A single missed id must not cost the node its
      // RPC capacity.
      const elapsed = Date.now() - startedAt;
      if (elapsed < this.config.minLongpollIntervalMs) {
        await sleep(this.config.minLongpollIntervalMs - elapsed);
      }
    }
  }

  // Should the aux longpoll run at all?
  //
  // A method rather than an inline condition in start(), so it can be asserted
  // from outside. Both halves matter and getting either wrong is quiet: in
  // Dogecoin-only mode the main loop ALREADY longpolls dogecoind, so a second
  // loop would hold a second RPC thread of a node that has eight, for nothing —
  // and switching it off must actually switch it off, or AUX_LONGPOLL=0 is a
  // setting that lies.
  wantsAuxLongpoll() {
    return !!(this.merged && this.config.auxLongpoll);
  }

  // The aux chain's tip, followed instead of polled.
  //
  // dogecoind offers no longpoll for createauxblock — that is why the aux side
  // was polled at all — but it does offer one for getblocktemplate, and what we
  // need from it is not the template. It is the EDGE: the instant its tip
  // moves. Verified in Dogecoin Core 1.14.9, src/rpc/mining.cpp:
  //
  //   * getblocktemplate's longpoll waits on cvBlockChange while
  //     `chainActive.Tip()->GetBlockHash() == hashWatchedChain`, so it returns
  //     the moment the tip changes. If the tip has ALREADY moved past the id we
  //     send, the loop is skipped and it returns immediately — which is why the
  //     id is always taken from the newest answer and why the throttle below is
  //     not optional.
  //   * AuxMiningCreateBlock does `if (pindexPrev != chainActive.Tip()) {
  //     mapNewBlock.clear(); ... }`, and AuxMiningSubmitBlock looks the hash up
  //     in exactly that map, throwing "block hash unknown" when it is gone. So
  //     every aux block issued for the old tip becomes worthless at precisely
  //     the moment this longpoll returns.
  //
  // That is the whole 1.7%: at a two second poll, one second on average of
  // every sixty second Dogecoin block was spent hashing an aux block that could
  // no longer be handed in. Following the tip brings that down to the round
  // trip of one RPC call.
  //
  // The poll stays. It is now a backstop rather than the mechanism, and it is
  // what covers a longpoll that dies quietly.
  async auxLongPollLoop() {
    // Which start() this loop belongs to. stop() cannot interrupt an in-flight
    // 120 second RPC, so a Pool that was stopped and started again would
    // otherwise end up with two of these — each holding a thread of a node that
    // has eight.
    const generation = this.generation;
    let timeouts = 0;
    while (!this.stopped && this.generation === generation) {
      const id = this.lastAuxLongpollId;
      const startedAt = Date.now();
      try {
        // A dedicated client: this request blocks for a minute or more, and it
        // must never be queued in front of a submitauxblock. In merged mode
        // `longpollRpc` — the Dogecoin longpoll client — is otherwise unused,
        // because the parent longpoll runs on the Litecoin one.
        const template = await this.longpollRpc.call('getblocktemplate', [
          id ? { longpollid: id, rules: [] } : { rules: [] },
        ]);
        const nextId = template && template.longpollid;
        if (nextId) this.lastAuxLongpollId = nextId;
        timeouts = 0;
        // The tip is tracked from EVERY answer, including the id-collecting
        // first one. Tracking it only from signalled returns means the first
        // real tip move is the one that establishes the baseline and is
        // therefore never counted — so the counter reads zero for the first
        // Dogecoin block after every restart, which is precisely when someone
        // is looking at it to see whether the loop works.
        const tip = template && template.previousblockhash;
        const moved = !!(tip && this.lastAuxTip && tip !== this.lastAuxTip);
        if (tip) this.lastAuxTip = tip;
        // The very first call carries no id, so it returns at once and says
        // nothing about the tip having moved. Treating it as a signal would
        // fire a redundant refresh at every startup.
        if (id) {
          this.auxLongpollSignals++;
          // A return is not always a tip movement. Dogecoin's longpoll ALSO
          // breaks out after about a minute when the mempool has changed,
          // returning a template for the same tip — verified against the real
          // binary: with one transaction sent and no block generated it
          // returned after 60002ms with the tip unchanged. On mainnet the
          // mempool is rarely quiet for a minute, so counting those as tip
          // movements would roughly double the figure that is supposed to be
          // the evidence this loop is working, and a broken loop would be
          // indistinguishable from a busy mempool.
          if (moved) this.auxTipMoves++;
          // Note what is NOT done here: `auxUnavailableSince` is left alone,
          // even though this call proves dogecoind is answering. That flag and
          // its "answering again after Ns" log line belong to
          // refreshMergedTemplate, which is about to run; clearing it here
          // would delete the recovery message before it was ever printed.
          try {
            // The full merged refresh, so the parent template and the aux block
            // are fetched together and the ordering guard in onMergedTemplate
            // sees a single, correctly stamped fetch. One extra Litecoin
            // getblocktemplate per Dogecoin block is a few milliseconds; a job
            // rebuilt from a stale parent would be a dead branch.
            await this.refreshMergedTemplate('aux-longpoll', null);
          } catch {
            // Already logged and recorded by refreshMergedTemplate. Falling out
            // of this loop would silently return the aux side to polling.
          }
        }
      } catch (err) {
        // Expected, in order of how often they happen: our own timeout on a
        // chain whose tip and mempool both sat still, "Dogecoin is not
        // connected!" and "Dogecoin is downloading blocks..." from
        // AuxMiningCheck's siblings in getblocktemplate. None is worth a log
        // line of its own — refreshMergedTemplate already reports a dogecoind
        // that has gone away — but all deserve a pause, so a node that refuses
        // cannot become a busy loop.
        if (err.code !== 'ETIMEDOUT') {
          await sleep(2000);
        } else {
          // A timeout here is not free, and this is the one hazard this loop
          // adds to the node.
          //
          // dogecoind's longpoll wait has NO overall timeout: it blocks on
          // cvBlockChange until the tip changes or the mempool differs, and it
          // does not notice that our socket has gone. So when we give up, the
          // worker thread on the other side stays parked until the tip finally
          // moves. Re-arming immediately therefore leaks one of the node's
          // eight RPC threads per timeout — measured on a real regtest node
          // with rpcthreads=4: after the fourth abort, every other call,
          // including submitauxblock, timed out too.
          //
          // On mainnet this needs a Dogecoin tip AND mempool that are both
          // still for minutes on end, which is already a sick chain. But the
          // consequence is that a found block cannot be handed in, so it is
          // bounded rather than argued about: back off hard, and after a few
          // in a row give the loop up entirely and go back to the poll, which
          // is correct if slower. Loudly, because a silent fallback is how the
          // 1.7% comes back without anyone noticing.
          timeouts++;
          if (timeouts >= this.auxLongpollMaxTimeouts) {
            this.auxLongpollDisabled =
              `gave up after ${timeouts} longpolls in a row timed out against dogecoind`;
            this.log(
              `the Dogecoin longpoll timed out ${timeouts} times in a row; stopping it so it cannot ` +
                'tie up the node\'s RPC threads, and falling back to polling the aux chain ' +
                `every ${Math.round(this.config.pollIntervalMs / 1000)}s. Restart the app to try again.`
            );
            return;
          }
          await sleep(this.auxLongpollBackoffMs);
        }
      }
      // The same belt and braces as the parent loop. A spent longpollid returns
      // instantly, and an unthrottled retry would eat exactly the RPC capacity
      // that submitauxblock needs at exactly the moment it needs it.
      const elapsed = Date.now() - startedAt;
      if (elapsed < this.config.minLongpollIntervalMs) {
        await sleep(this.config.minLongpollIntervalMs - elapsed);
      }
    }
  }

  // ------------------------------------------------------------------ clients

  // `entry` says which listening socket accepted this connection —
  // 'primary' (the home/whatever-MINING_PROFILE-says port, always up) or
  // 'rented' (the dedicated high-difficulty port, only up when server.js
  // configured one). It picks the client's limits once, here, and nothing
  // later ever moves a live connection between the two: a worker that wants
  // the other regime reconnects to the other port, the same way it would
  // point at a different pool.
  onConnection(socket, entry = 'primary') {
    // For 'primary' this is `this.config` itself, BY REFERENCE — see the
    // comment on `this.rentedPortLimits` in the constructor for why that
    // matters: it is what keeps a live MINING_PROFILE switch reaching workers
    // that connected before the switch, not just new ones.
    const limits = entry === 'rented' ? this.rentedPortLimits : this.config;

    // Stratum has no authentication — by design, since there is no account to
    // authenticate against. That makes an unbounded connection count a trivial
    // resource-exhaustion path for anyone who can reach a port, so it gets a
    // ceiling — counted PER PORT, not pool-wide, so a rented order's much
    // larger allowance can never starve the home port's much smaller one, and
    // a reconnecting home miner can never eat the slots a rented order is
    // waiting for either.
    let sameEntry = 0;
    for (const c of this.clients.values()) if (c.entry === entry) sameEntry++;
    if (sameEntry >= limits.maxConnections) {
      this.churnLog(`refused a ${entry} connection from ${socket.remoteAddress}: at the ${limits.maxConnections}-connection limit`);
      socket.destroy();
      return;
    }

    // A ceiling alone is not enough: one machine opening bare TCP sockets —
    // sending nothing, so the message rate limit never applies — would take
    // every slot and lock out the real miners. Cap per source too, again
    // scoped to this port: a rented order legitimately arrives as many
    // connections from a handful of its provider's addresses.
    const remote = socket.remoteAddress || 'unknown';
    let fromThisHost = 0;
    for (const c of this.clients.values()) if (c.entry === entry && c.remote === remote) fromThisHost++;
    if (fromThisHost >= limits.maxConnectionsPerIp) {
      this.churnLog(`refused a ${entry} connection from ${remote}: already has ${fromThisHost}`);
      socket.destroy();
      return;
    }

    const id = ++this.clientCounter;
    const extranonce1 = Buffer.alloc(EXTRANONCE1_SIZE);
    extranonce1.writeUInt32BE(this.extranonceCounter++ >>> 0, 0);

    const client = {
      id,
      socket,
      // Fixed for the life of the connection — see the comment on
      // onConnection above.
      entry,
      limits,
      extranonce1,
      subscribed: false,
      authorized: false,
      worker: null,
      payoutAddress: null,
      // Clamped, not trusted as-is: START_DIFFICULTY is an explicit env
      // override that applies to BOTH ports at once (see resolveProfileField
      // in server.js), so a value chosen to tune the primary port can land
      // outside the OTHER port's own min/max — a rented order handed a home-
      // sized starting difficulty would flood the message-rate limit before
      // vardiff ever got a chance to correct it. Belt and braces: whatever
      // combination of overrides produced `limits`, a fresh connection can
      // never start below its own floor or above its own ceiling.
      difficulty: clamp(limits.startDifficulty, limits.minDifficulty, limits.maxDifficulty),
      pendingDifficulty: null,
      connectedAt: Date.now(),
      lastShareAt: null,
      shareTimes: [],
      accepted: 0,
      rejected: 0,
      bestShareDiff: 0,
      // Round-trip time and where it came from. 'ping' is a real measurement
      // from client.get_version; 'handshake' is the subscribe->authorize gap,
      // which every miner produces but which also contains the miner's own
      // processing time, so it is an upper bound and is labelled as such.
      latencyMs: null,
      latencyFrom: null,
      supportsGetVersion: false,
      subscribeRepliedAt: null,
      rejectReasons: {},
      buffer: '',
      rateWindowAt: Date.now(),
      rateCount: 0,
      // The same normalised value the per-IP cap counts, so a socket with no
      // remoteAddress cannot slip past the cap by being counted differently.
      remote,
    };
    this.clients.set(id, client);

    socket.setKeepAlive(true, 60000);
    socket.setNoDelay(true);
    socket.setTimeout(limits.socketTimeoutMs);

    // Defence in depth: anything thrown inside a socket event handler that is
    // not caught takes the whole process down, and this handler parses input
    // from an unauthenticated peer.
    socket.on('data', (chunk) => {
      try {
        this.onData(client, chunk);
      } catch (err) {
        this.log(`dropping connection ${client.id} after an internal error: ${err.message}`);
        socket.destroy();
      }
    });
    socket.on('timeout', () => socket.destroy());

    // A connection that never authorizes is not a miner. Without this, an idle
    // socket holds its slot for the full socket timeout — fifteen minutes by
    // default — and a single newline now and then extends that forever.
    client.handshakeTimer = setTimeout(() => {
      if (!client.authorized) {
        this.log(`dropping connection ${client.id} from ${remote}: never authorized`);
        socket.destroy();
      }
    }, this.config.handshakeTimeoutMs);
    client.handshakeTimer.unref();
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(client.handshakeTimer);
      this.clients.delete(id);
      this.churnLog(`worker disconnected: ${client.worker || 'unauthorized'} (#${id})`);
    });
  }

  onData(client, chunk) {
    client.buffer += chunk.toString('utf8');
    if (client.buffer.length > MAX_LINE_BYTES) {
      // No legitimate stratum message is anywhere near this size.
      client.socket.destroy();
      return;
    }
    const lines = client.buffer.split('\n');
    client.buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Rate limit per connection. Share validation runs scrypt, which is
      // deliberately expensive, so an unthrottled client can spend our CPU far
      // faster than it spends its own.
      const now = Date.now();
      if (now - client.rateWindowAt > 10000) {
        client.rateWindowAt = now;
        client.rateCount = 0;
      }
      if (++client.rateCount > client.limits.maxMessagesPer10s) {
        this.log(`worker ${client.worker || client.id} exceeded the message rate limit; disconnecting`);
        client.socket.destroy();
        return;
      }

      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      // JSON.parse happily returns null, a number, a string or an array. Every
      // one of those is a valid line of JSON and none of them is a stratum
      // message. Reading .method or .id off them either throws — taking the
      // whole process down, since this runs inside a socket event handler —
      // or silently does nothing. One line containing `null` was enough.
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
        continue;
      }
      const replyId = msg.id === undefined ? null : msg.id;
      try {
        // handleSubmit is async, so a thrown error arrives as a rejected
        // promise that the surrounding try/catch would never see.
        const outcome = this.handleMessage(client, msg);
        if (outcome && typeof outcome.catch === 'function') {
          outcome.catch((err) => {
            this.reply(client, replyId, null, [20, err.message, null]);
          });
        }
      } catch (err) {
        this.reply(client, replyId, null, [20, err.message, null]);
      }
    }
  }

  send(client, obj) {
    if (client.socket.destroyed) return;
    client.socket.write(JSON.stringify(obj) + '\n');
  }

  reply(client, id, result, error = null) {
    this.send(client, { id, result, error });
  }

  handleMessage(client, msg) {
    // A message with no method is a RESPONSE to something we asked, not a
    // request. Without this branch it falls through to "unknown method" and we
    // reply to a reply, which some firmware answers again.
    if (msg.method === undefined) {
      if (client.pendingPing && msg.id === client.pendingPing.id) {
        client.latencyMs = Date.now() - client.pendingPing.sentAt;
        client.latencyFrom = 'ping';
        // Remembered so a later timeout can tell "this miner answers and has
        // gone quiet" (report nothing) from "this miner never answers"
        // (keep the handshake estimate).
        client.supportsGetVersion = true;
        client.pendingPing = null;
      }
      return;
    }

    switch (msg.method) {
      case 'mining.subscribe':
        return this.handleSubscribe(client, msg);
      case 'mining.authorize':
        return this.handleAuthorize(client, msg);
      case 'mining.submit':
        return this.handleSubmit(client, msg);
      case 'mining.extranonce.subscribe':
        return this.reply(client, msg.id, true);
      case 'mining.suggest_difficulty':
        return this.handleSuggestDifficulty(client, msg);
      case 'mining.configure':
        // We support no extensions; an empty object is the correct answer and
        // keeps firmware that always sends this from failing at handshake.
        return this.reply(client, msg.id, {});
      case 'mining.multi_version':
        return this.reply(client, msg.id, true);
      default:
        return this.reply(client, msg.id, null, [20, 'unknown method', null]);
    }
  }

  handleSubscribe(client, msg) {
    client.subscribed = true;
    // Bounded like the worker name: this string is stored, served in the status
    // API and rendered in the dashboard, and it arrives from the network.
    const agent = Array.isArray(msg.params) ? msg.params[0] : null;
    client.userAgent = agent == null ? null : String(agent).slice(0, 128);
    const sub = crypto.randomBytes(8).toString('hex');
    this.reply(client, msg.id, [
      [
        ['mining.set_difficulty', sub],
        ['mining.notify', sub],
      ],
      client.extranonce1.toString('hex'),
      EXTRANONCE2_SIZE,
    ]);
    // Stamped AFTER the write, so the interval measured against the authorize
    // that follows is the link, not our own serialisation.
    client.subscribeRepliedAt = Date.now();
  }

  handleAuthorize(client, msg) {
    // Re-authorizing an established connection would swap the payout script out
    // from under work the miner is already hashing: the coinbase changes, the
    // merkle root changes, and every in-flight share — including a winning one
    // — is validated against a header the miner never built. Accept the call so
    // firmware that repeats it is not upset, but change nothing.
    if (client.authorized) {
      this.reply(client, msg.id, true);
      return;
    }

    // The only round-trip every miner produces. Firmware sends authorize the
    // moment it has our subscribe reply, so this gap is the link plus a little
    // parsing. Both of this user's miners ignore client.get_version, and a
    // permanently empty column is worse than an honest upper bound.
    if (client.subscribeRepliedAt && client.latencyMs == null) {
      const rtt = Date.now() - client.subscribeRepliedAt;
      // Beyond a second the miner was doing something else, not waiting on the
      // network, and the number would be a lie.
      if (rtt >= 0 && rtt <= 1000) {
        client.latencyMs = rtt;
        client.latencyFrom = 'handshake';
      }
    }

    const [username] = msg.params || [];
    // Control characters stripped, not just length-bounded. A name containing a
    // newline lets anyone who can reach this port write forged lines into the
    // container log — including a convincing "BLOCK ACCEPTED" — and the same
    // string is stored and served to the dashboard.
    client.worker = String(username || 'worker')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .slice(0, 64) || 'worker';
    client.payoutScript = null;
    client.payoutAddress = null;

    if (this.publicMerged) {
      // Parsed from the name BEFORE the 64-character display cut: two
      // addresses and a dot are already 69 characters, so the truncated form
      // would always carry a broken Dogecoin address.
      const raw = String(username || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
      const parsed = pm.parsePublicUsername(raw, this.ltcChain, this.chain, this.pep ? this.pepChain : null);
      if (!parsed.ok) {
        this.churnLog(`worker refused: ${client.worker} from ${client.remote} — ${parsed.reason}`);
        return this.reply(client, msg.id, false, [24, parsed.reason, null]);
      }
      const key = this.payoutKey(parsed.ltcScript, parsed.dogeScript, parsed.pepScript);
      const inUse = new Set();
      for (const c of this.clients.values()) {
        if (c !== client && c.authorized && c.ltcPayoutScript && c.payoutScript) {
          inUse.add(this.payoutKey(c.ltcPayoutScript, c.payoutScript, c.pepPayoutScript));
        }
      }
      if (!inUse.has(key) && inUse.size >= this.config.maxPayoutVariants) {
        this.churnLog(`worker refused: ${client.worker} — the pool is full (${inUse.size} address pairs)`);
        return this.reply(client, msg.id, false, [24, 'pool is full, try again later', null]);
      }
      // Shown on the dashboard and used as the statistics key: the rig name
      // and the Dogecoin address, which together fit the display limit.
      client.worker = `${parsed.workerName ? `${parsed.workerName.slice(0, 20)}@` : ''}${parsed.dogeAddress}`.slice(0, 64);
      client.ltcPayoutScript = parsed.ltcScript;
      client.ltcPayoutAddress = parsed.ltcAddress;
      client.payoutScript = parsed.dogeScript;
      client.payoutAddress = parsed.dogeAddress;
      client.pepPayoutScript = parsed.pepScript;
      client.pepPayoutAddress = parsed.pepAddress;
      client.authorized = true;
      this.reply(client, msg.id, true);
      this.churnLog(
        `worker connected: ${client.worker} (#${client.id}) from ${client.remote} ` +
          `paying LTC ${parsed.ltcAddress} / DOGE ${parsed.dogeAddress}` +
          (parsed.pepAddress ? ` / PEP ${parsed.pepAddress}` : '')
      );
      this.setDifficulty(client, client.difficulty);
      if (this.currentJob) this.sendJob(client, this.currentJob, true);
      return;
    }

    client.authorized = true;

    // These miners put an address in the username field, so honour it: the
    // block a worker finds pays the address that worker asked for. Anything
    // unparseable silently falls back to the app's configured address rather
    // than refusing to mine.
    //
    // LOCK_PAYOUT_ADDRESS turns this off. Worth setting if the stratum port is
    // reachable by anyone you would not hand a block to — with it on, every
    // block pays the configured address no matter what a worker asks for.
    if (!this.config.lockPayoutAddress) {
      const candidate = client.worker.split('.')[0];
      try {
        const script = u.addressToScript(candidate, this.chain);
        // Decide here whether this address can actually be honoured, and say so
        // if it cannot. Deciding later, per job, meant a worker past the limit
        // silently mined to the app's address while the dashboard and the logs
        // reported the worker's own — the worst possible failure for something
        // that decides who gets paid.
        const key = script.toString('hex');
        const inUse = new Set();
        for (const c of this.clients.values()) {
          if (c !== client && c.payoutScript) inUse.add(c.payoutScript.toString('hex'));
        }
        if (!inUse.has(key) && inUse.size >= this.config.maxPayoutVariants) {
          this.log(
            `worker ${client.worker} asked to be paid at ${candidate}, but the limit of ` +
              `${this.config.maxPayoutVariants} distinct payout addresses is reached; ` +
              `its blocks will pay ${this.config.payoutAddress}`
          );
          client.payoutAddress = null;
          client.payoutScript = null;
        } else {
          client.payoutAddress = candidate;
          client.payoutScript = script;
        }
      } catch {
        // Leave both null so the app's configured address is used. Clearing
        // the script matters: clientJob() keys off it, so a stale one would
        // pay an address the dashboard does not report.
        client.payoutAddress = null;
        client.payoutScript = null;
      }
    }

    this.reply(client, msg.id, true);
    this.churnLog(
      `worker connected: ${client.worker} (#${client.id}) from ${client.remote}` +
        (client.payoutAddress ? ` paying ${client.payoutAddress}` : '')
    );

    this.setDifficulty(client, client.difficulty);
    if (this.currentJob) this.sendJob(client, this.currentJob, true);
  }

  handleSuggestDifficulty(client, msg) {
    const suggested = Number((msg.params || [])[0]);
    if (Number.isFinite(suggested) && suggested > 0) {
      const clamped = clamp(suggested, client.limits.minDifficulty, client.limits.maxDifficulty);
      this.setDifficulty(client, clamped);
    }
    this.reply(client, msg.id, true);
  }

  setDifficulty(client, difficulty) {
    // Keep the previous target valid for a grace period. A miner applies
    // mining.set_difficulty immediately, but work already dispatched to its
    // ASIC carries the old difficulty and is submitted against it. Rejecting
    // those would show up as a steady stream of "low difficulty share" that
    // looks exactly like failing hardware.
    if (client.target) {
      client.previousTarget = client.target;
      client.previousDifficulty = client.difficulty;
      client.previousTargetUntil = Date.now() + client.limits.difficultyGraceMs;
      this.rememberTarget(client, client.target);
    }
    client.difficulty = difficulty;
    // Stratum space, with the scrypt 2^16 multiplier — not consensus space.
    client.target = u.targetFromShareDifficulty(difficulty);
    this.send(client, { id: null, method: 'mining.set_difficulty', params: [difficulty] });
  }

  sendJob(client, job, cleanJobs) {
    this.send(client, {
      id: null,
      method: 'mining.notify',
      params: this.clientJob(client, job).notifyParams(cleanJobs),
    });
  }

  // ------------------------------------------------------------------- shares

  async handleSubmit(client, msg) {
    if (!client.authorized) {
      return this.reply(client, msg.id, null, [24, 'unauthorized worker', null]);
    }
    // Deliberately NOT refused during shutdown. A submission that arrives after
    // beginShutdown() can still be the block, and the drain already waits for
    // work in flight — so validating it costs a moment and refusing it could
    // cost the whole point of the app. Only new CONNECTIONS are turned away.

    const [, jobId, extranonce2, ntime, nonce] = msg.params || [];
    const job = this.jobs.get(jobId);
    if (!job) {
      this.countReject(client, 'stale job');
      return this.reply(client, msg.id, null, [21, 'job not found', null]);
    }

    // Must be the exact same job object the client was notified with.
    const effectiveJob = this.clientJob(client, job);

    // Every target this client has recently been told to use, not just the last
    // one: vardiff can climb several steps within a second on a fast miner, and
    // work queued at the first of them is still legitimately in flight.
    const targets = Date.now() < client.previousTargetUntil
      ? this.recentTargets(client)
      : [client.target];

    // Asynchronous on purpose: scrypt is expensive by design, and anyone who
    // reaches this port can ask for it. Running it on the event loop would let
    // a flood of junk submissions delay the one call that matters — submitblock.
    //
    // The counter lets shutdown wait for work already in progress, so the last
    // share before an update is not the one missing from the history.
    this.inFlight = (this.inFlight || 0) + 1;
    let result;
    try {
      result = await validateShareAsync(effectiveJob, {
        extranonce1: client.extranonce1,
        extranonce2Hex: String(extranonce2 || ''),
        ntimeHex: String(ntime || ''),
        nonceHex: String(nonce || ''),
        shareTarget: targets,
      });
    } finally {
      this.inFlight--;
    }

    // A block is a block even if the miner has gone. Do NOT return early on a
    // dead socket before the candidate check: the scrypt hash runs on the
    // thread pool, and anything that closes the connection in that window — a
    // TCP reset, the rate limiter, a shutdown — would otherwise throw away a
    // solved block. Only the reply to the miner is pointless now.
    const gone = client.socket.destroyed;

    if (!result.ok) {
      if (gone) return;
      this.countReject(client, result.reason);
      return this.reply(client, msg.id, null, [23, result.reason, null]);
    }

    // Submit first. Everything below is bookkeeping, and a block must not
    // depend on it.
    //
    // The two chains are dispatched separately and neither is awaited. One
    // hash can win on both, and a throw, a rejection or a node that is simply
    // down on one side must not cost the block on the other — so each gets its
    // own guard rather than sharing a try.
    if (result.isBlockCandidate) {
      this.dispatchSubmission(
        () => this.submitBlock(effectiveJob, result, client),
        this.merged ? 'Litecoin block submission' : 'block submission'
      );
    }
    if (result.isAuxCandidate) {
      this.dispatchSubmission(
        () => this.submitAuxBlock(effectiveJob, result, client),
        'Dogecoin aux block submission'
      );
    }
    // Further aux chains (Pepecoin), each on its own guard for the same
    // reason: one chain failing must never cost another its block.
    for (const a of result.extraAuxCandidates || []) {
      this.dispatchSubmission(
        () => this.submitExtraAuxBlock(effectiveJob, result, client, a),
        `${a.name} aux block submission`
      );
    }

    // Count the share even if the socket has gone. The work was done and
    // verified; only the reply to the miner is pointless now. Returning early
    // here would discard exactly the shares a shutdown drain exists to keep.
    client.accepted++;
    this.stats.accepted++;
    const now = Date.now();
    // Record the difficulty the share actually satisfied. During the grace
    // window after an increase, a share may only meet the OLD target; crediting
    // it at the new one would overstate the hashrate and mislead vardiff.
    const metCurrent = result.shareDiff * u.HASHES_PER_SHARE_UNIT >= client.difficulty * 0.99;
    const creditedDifficulty =
      metCurrent || !client.previousDifficulty ? client.difficulty : client.previousDifficulty;
    client.lastShareAt = now;
    client.shareTimes.push({ at: now, difficulty: creditedDifficulty });
    if (client.shareTimes.length > 200) client.shareTimes.shift();

    if (result.shareDiff > client.bestShareDiff) client.bestShareDiff = result.shareDiff;
    if (result.shareDiff > this.stats.bestShareDiff) {
      this.stats.bestShareDiff = result.shareDiff;
      this.stats.bestShareAt = now;
    }
    for (const a of effectiveJob.extraAux || []) {
      const cur = this.stats.chainBest[a.name];
      if (!cur || result.shareDiff > cur.diff) this.stats.chainBest[a.name] = { diff: result.shareDiff, at: now };
    }
    if (this.store) {
      this.store.recordShare(now, result.shareDiff, creditedDifficulty, client.worker);
    }

    if (gone) return;
    this.reply(client, msg.id, true);
    this.retarget(client);
  }

  // A view of the job carrying a specific payout script. Cached on the JOB and
  // keyed by the script, not per client: ten workers paying the same address
  // share one variant, and the memory cost is bounded by the number of distinct
  // addresses rather than by the number of connections.
  jobForClient(job, client) {
    const key = client.payoutScript.toString('hex');
    if (!job.variants) job.variants = new Map();
    const cached = job.variants.get(key);
    if (cached) return cached;

    // Backstop only — handleAuthorize already refuses to hand out a payout
    // script past the limit, and logs when it does. Reaching this branch would
    // mean a worker mining to the app's address while believing otherwise, so
    // it is loud rather than silent.
    if (job.variants.size >= this.config.maxPayoutVariants) {
      this.log(
        `WARNING: no job variant available for ${client.payoutAddress || 'a worker'}; ` +
          `its work will pay ${this.config.payoutAddress}`
      );
      return job;
    }
    const variant = new Job(job.id, job.template, client.payoutScript, this.config.coinbaseTag);
    job.variants.set(key, variant);
    return variant;
  }

  // Targets this client has recently been given. A single "previous target" is
  // not enough while vardiff is ramping: a rented miner climbs several steps in
  // a couple of seconds, and work already queued at the older difficulty is
  // then judged against a target several steps harder and rejected as a low
  // difficulty share. Keeping a few is honest — the miner really was told to
  // use them — and costs nothing, because share difficulty has no bearing on
  // whether a block is found.
  recentTargets(client) {
    const list = [client.target];
    for (const t of client.previousTargets || []) list.push(t);
    return list;
  }

  rememberTarget(client, target) {
    if (!client.previousTargets) client.previousTargets = [];
    client.previousTargets.unshift(target);
    while (client.previousTargets.length > RECENT_TARGETS) client.previousTargets.pop();
  }

  countReject(client, reason) {
    client.rejected++;
    // Per worker as well as in total: "8 rejected" across the pool does not say
    // which board is producing them, and stale shares from one slow miner need
    // a different answer than bad shares from a failing one.
    if (!client.rejectReasons) client.rejectReasons = {};
    client.rejectReasons[reason] = (client.rejectReasons[reason] || 0) + 1;
    this.stats.rejected++;
    this.stats.rejectReasons[reason] = (this.stats.rejectReasons[reason] || 0) + 1;
    if (this.store) this.store.recordReject(reason, client.worker);
  }

  // A found block is the entire point of the app, and submitblock is a single
  // RPC call that can fail transiently — a timeout while the node validates the
  // block, a full work queue, a restarting node. Failing once must not be the
  // end of it. Resubmitting a block the node already has is harmless: it
  // answers "duplicate", which we treat as success.
  async submitWithRetries(blockHex, height) {
    const delays = [0, 1000, 3000, 10000, 30000, 60000];
    let lastError = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await sleep(delays[attempt]);
      try {
        return await this.submitRpc.submitBlock(blockHex);
      } catch (err) {
        lastError = err;
        this.log(
          `submitblock attempt ${attempt + 1}/${delays.length} for height ${height} failed: ${err.message}`
        );
      }
    }
    throw lastError;
  }

  // The aux chain's equivalent. submitauxblock answers with a boolean rather
  // than Core's verdict string, so it is normalised into the same vocabulary
  // the shared machinery below already speaks.
  async submitAuxWithRetries(auxHash, auxPowHex, height) {
    const delays = [0, 1000, 3000, 10000, 30000, 60000];
    let lastError = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await sleep(delays[attempt]);
      try {
        const ok = await this.submitRpc.call('submitauxblock', [auxHash, auxPowHex]);
        return ok === true ? null : 'dogecoind refused the auxpow proof';
      } catch (err) {
        // One failure is not like the others. AuxMiningSubmitBlock looks the
        // hash up in mapNewBlock and throws "block hash unknown" when it is not
        // there — and AuxMiningCreateBlock empties that map the instant the tip
        // moves. So this error means the aux block we solved was discarded
        // before the proof arrived, and it can never come back: retrying spends
        // a hundred seconds of the retry schedule on a certainty, while the
        // Litecoin block from the same share is still being submitted on the
        // other RPC client.
        //
        // Counted rather than merely logged. This is the number that says
        // whether the aux longpoll is doing its job.
        if (/block hash unknown/i.test(err.message)) {
          this.stats.auxTipMissed++;
          this.stats.auxTipMissedAt = Date.now();
          this.log(
            `the Dogecoin tip moved before the proof for height ${height} could be submitted; ` +
              'dogecoind had already discarded that aux block (this is the window the aux ' +
              'longpoll exists to close)'
          );
          return 'the Dogecoin tip moved before the proof was submitted';
        }
        lastError = err;
        this.log(
          `submitauxblock attempt ${attempt + 1}/${delays.length} for height ${height} failed: ${err.message}`
        );
      }
    }
    throw lastError;
  }

  // Guard a submission that is deliberately not awaited. Without this a
  // rejection from one chain is an unhandled rejection at process level, and a
  // synchronous throw would propagate back into the share handler and abort the
  // other chain's submission before it was ever dispatched.
  dispatchSubmission(fn, what) {
    try {
      const p = fn();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => this.log(`${what} failed: ${err.message}`));
      }
    } catch (err) {
      this.log(`${what} failed: ${err.message}`);
    }
  }

  async submitBlock(job, result, client) {
    this.inFlightBlocks = (this.inFlightBlocks || 0) + 1;
    try {
      await this.submitBlockInner(job, result, client);
    } finally {
      this.inFlightBlocks--;
    }
  }

  async submitAuxBlock(job, result, client) {
    this.inFlightBlocks = (this.inFlightBlocks || 0) + 1;
    try {
      await this.submitAuxBlockInner(job, result, client);
    } finally {
      this.inFlightBlocks--;
    }
  }

  async submitAuxBlockInner(job, result, client) {
    const auxPowHex = job.auxPowHex(result.header, result.coinbase);

    // Check our own proof against Dogecoin's rules before spending the retry
    // schedule on it. The one input here we do not control is extranonce2, and
    // a miner that puts a second merged-mining magic in it makes the proof
    // invalid — which must cost this submission only. The Litecoin block for
    // the same share is already on its way, independently.
    const verdict = job.verifyAgainstDogecoin(result.header, result.coinbase);
    if (!verdict.ok) {
      this.log(
        `NOT submitting the Dogecoin aux block at height ${job.auxHeight}: ${verdict.problems.join(' | ')}`
      );
      return;
    }

    if (this.publicMerged) {
      const blockHex = pm.serializeAuxBlock(job.auxBlock, Buffer.from(auxPowHex, 'hex'));
      await this.submitCandidate({
        chain: 'DOGE',
        height: job.auxHeight,
        hash: job.auxHash,
        // The whole Dogecoin block this time, auxpow included: submitblock
        // takes exactly this, so it is also what recovers it by hand.
        hex: blockHex,
        hexLabel: `BLOCK HEX chain=DOGE height=${job.auxHeight}`,
        reward: job.auxValue,
        address: client.payoutAddress,
        worker: client.worker,
        submit: () => this.submitWithRetries(blockHex, job.auxHeight),
      });
      return;
    }

    await this.submitCandidate({
      chain: 'DOGE',
      height: job.auxHeight,
      hash: job.auxHash,
      // Not a block: the auxpow proof, which is what recovers this block by
      // hand if everything else fails. Same reasoning as the block hex.
      hex: auxPowHex,
      hexLabel: `AUXPOW HEX chain=DOGE height=${job.auxHeight} auxhash=${job.auxHash}`,
      reward: job.auxValue,
      address: this.config.payoutAddress,
      worker: client.worker,
      submit: () => this.submitAuxWithRetries(job.auxHash, auxPowHex, job.auxHeight),
    });
  }

  async submitExtraAuxBlock(job, result, client, a) {
    this.inFlightBlocks = (this.inFlightBlocks || 0) + 1;
    try {
      await this.submitExtraAuxBlockInner(job, result, client, a);
    } finally {
      this.inFlightBlocks--;
    }
  }

  // A Pepecoin block, from the same share as the Litecoin and Dogecoin ones:
  // the same parent proof with Pepecoin's own path through the chain merkle
  // tree. Checked against the auxpow rules first, exactly as Dogecoin's is.
  async submitExtraAuxBlockInner(job, result, client, a) {
    const verdict = job.verifyAux(result.header, result.coinbase, a.chainId, a.hash);
    if (!verdict.ok) {
      this.log(`NOT submitting the ${a.name} aux block at height ${a.height}: ${verdict.problems.join(' | ')}`);
      return;
    }
    const auxPowHex = job.auxPowHex(result.header, result.coinbase, a.chainId);

    // Soqucoin: private mode only, so always the proof for the block soqucoind
    // built itself with createauxblock.
    if (a.name === 'SOQ') {
      const soq = this.soq;
      if (!soq) return; // switched off since this job was built
      await this.submitCandidate({
        chain: a.name,
        height: a.height,
        hash: a.hash,
        hex: auxPowHex,
        hexLabel: `AUXPOW HEX chain=${a.name} height=${a.height} auxhash=${a.hash}`,
        reward: a.value,
        address: soq.payoutAddress,
        worker: client.worker,
        submit: () => this.submitSoqAuxWithRetries(a.hash, auxPowHex, a.height),
      });
      return;
    }

    const pep = this.pep;
    if (!pep) return; // switched off since this job was built

    if (this.publicMerged) {
      const blockHex = pm.serializeAuxBlock(a.block, Buffer.from(auxPowHex, 'hex'));
      await this.submitCandidate({
        chain: a.name,
        height: a.height,
        hash: a.hash,
        hex: blockHex,
        hexLabel: `BLOCK HEX chain=${a.name} height=${a.height}`,
        reward: a.value,
        address: client.pepPayoutAddress,
        worker: client.worker,
        submit: () => this.submitPepBlockWithRetries(blockHex, a.height),
      });
      return;
    }

    await this.submitCandidate({
      chain: a.name,
      height: a.height,
      hash: a.hash,
      hex: auxPowHex,
      hexLabel: `AUXPOW HEX chain=${a.name} height=${a.height} auxhash=${a.hash}`,
      reward: a.value,
      address: pep.payoutAddress,
      worker: client.worker,
      submit: () => this.submitPepAuxWithRetries(a.hash, auxPowHex, a.height),
    });
  }

  // submitAuxWithRetries for pepecoind, including its one hopeless error.
  async submitPepAuxWithRetries(auxHash, auxPowHex, height) {
    const delays = [0, 1000, 3000, 10000, 30000, 60000];
    let lastError = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await sleep(delays[attempt]);
      try {
        const ok = await this.pep.submitRpc.call('submitauxblock', [auxHash, auxPowHex]);
        return ok === true ? null : 'pepecoind refused the auxpow proof';
      } catch (err) {
        // Same as Dogecoin: the aux block was discarded when the Pepecoin tip
        // moved, and no retry brings it back. (Written apart from Dogecoin's
        // line on purpose: test/mutants.sh mutates that one by its exact text.)
        if (/block hash unknown/i.test(String(err.message))) {
          this.stats.pepTipMissed++;
          this.stats.pepTipMissedAt = Date.now();
          this.log(`the Pepecoin tip moved before the proof for height ${height} could be submitted`);
          return 'the Pepecoin tip moved before the proof was submitted';
        }
        lastError = err;
        this.log(`Pepecoin submitauxblock attempt ${attempt + 1}/${delays.length} for height ${height} failed: ${err.message}`);
      }
    }
    throw lastError;
  }

  // The same for soqucoind, whose aux RPCs are Dogecoin's: the same "block
  // hash unknown" once the tip it was built on has moved.
  async submitSoqAuxWithRetries(auxHash, auxPowHex, height) {
    const delays = [0, 1000, 3000, 10000, 30000, 60000];
    let lastError = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await sleep(delays[attempt]);
      try {
        const ok = await this.soq.submitRpc.call('submitauxblock', [auxHash, auxPowHex]);
        return ok === true ? null : 'soqucoind refused the auxpow proof';
      } catch (err) {
        if (/block hash unknown/i.test(String(err.message))) {
          this.stats.soqTipMissed++;
          this.stats.soqTipMissedAt = Date.now();
          this.log(`the Soqucoin tip moved before the proof for height ${height} could be submitted`);
          return 'the Soqucoin tip moved before the proof was submitted';
        }
        lastError = err;
        this.log(`Soqucoin submitauxblock attempt ${attempt + 1}/${delays.length} for height ${height} failed: ${err.message}`);
      }
    }
    throw lastError;
  }

  async submitPepBlockWithRetries(blockHex, height) {
    const delays = [0, 1000, 3000, 10000, 30000, 60000];
    let lastError = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await sleep(delays[attempt]);
      try {
        return await this.pep.submitRpc.submitBlock(blockHex);
      } catch (err) {
        lastError = err;
        this.log(`Pepecoin submitblock attempt ${attempt + 1}/${delays.length} for height ${height} failed: ${err.message}`);
      }
    }
    throw lastError;
  }

  async submitBlockInner(job, result, client) {
    // In merged mode this block is the LITECOIN one, and it pays the Litecoin
    // address; a worker's own address is refused at authorize time there.
    const address = this.publicMerged
      ? client.ltcPayoutAddress
      : this.merged
        ? this.config.ltcPayoutAddress
        : client.payoutAddress || this.config.payoutAddress;
    await this.submitCandidate({
      chain: this.merged ? 'LTC' : 'DOGE',
      height: job.height,
      hash: result.blockHash,
      hex: result.blockHex,
      hexLabel: this.merged
        ? `BLOCK HEX chain=LTC height=${job.height}`
        : `BLOCK HEX height=${job.height}`,
      reward: job.coinbaseValue,
      address,
      worker: client.worker,
      submit: () =>
        this.merged
          ? this.submitLtcWithRetries(result.blockHex, job.height)
          : this.submitWithRetries(result.blockHex, job.height),
    });
  }

  async submitLtcWithRetries(blockHex, height) {
    const delays = [0, 1000, 3000, 10000, 30000, 60000];
    let lastError = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await sleep(delays[attempt]);
      try {
        return await this.ltcSubmitRpc.submitBlock(blockHex);
      } catch (err) {
        lastError = err;
        this.log(
          `Litecoin submitblock attempt ${attempt + 1}/${delays.length} for height ${height} failed: ${err.message}`
        );
      }
    }
    throw lastError;
  }

  // Everything between "we hold a winning hash" and "the node has ruled on it",
  // for whichever chain won: the durable record, the hex in the log, the
  // notification, the retries and the verdict. One implementation, because this
  // is the sequence that costs real money when it is subtly different in two
  // places.
  async submitCandidate({ chain, height, hash, hex, hexLabel, reward, address, worker, submit }) {
    // Log lines carry the chain only in merged mode: with merged mining off
    // these are the exact strings this app has always written, and someone
    // grepping a year of container logs should not have to know that.
    const where = this.merged ? `${chain} height ${height}` : `height ${height}`;
    const what = this.merged ? `${chain} block` : 'block';
    this.log(`BLOCK CANDIDATE at ${where} by ${worker} — ${hash}`);
    const record = {
      // Which chain this block is on. Without it the dashboard shows two
      // records at unrelated heights and reconciliation asks the wrong node.
      chain,
      height,
      hash,
      worker,
      address,
      reward,
      at: Date.now(),
      status: 'submitting',
      accepted: null,
      error: null,
    };
    this.stats.blocks.unshift(record);
    if (this.stats.blocks.length > 50) this.stats.blocks.pop();

    // The full block hex, FIRST — before the store, before any listener, before
    // the submission. A dying SD card can hold fsync for tens of seconds or
    // forever, and this line is the difference between a recoverable situation
    // and 10,000 DOGE gone. It must not depend on a disk that may be failing.
    console.log(`[pool] ${hexLabel} ${hex}`);

    if (this.store) {
      // The store keeps a copy WITHOUT the block hex: fifty mainnet blocks of
      // hex is tens of megabytes, and the file is serialised synchronously.
      //
      // Saved here, before the submission, and deliberately so.
      //
      // Deferring it to a setImmediate after the submit call looks like it
      // takes the fsync off the critical path. Measured, it does not: the
      // check phase runs before the poll phase that actually writes the RPC
      // request to the socket, so the submission left at the same moment
      // either way — while the record spent that window existing only in
      // memory, where a crash loses the hash that reconciliation needs.
      // Same latency, strictly less durability, so: save first.
      this.store.recordBlock(record);
      this.store.save(true);
    }
    // Announced the moment it is found, not when the node has confirmed it.
    // Submission and its retry schedule can take a minute or more, and if it
    // ultimately fails this is the only notification that will ever be sent.
    // The later 'block' event replaces the notification rather than adding one.
    // emitSafely: a listener that throws here would otherwise abort the
    // submission entirely.
    this.emitSafely('blockfound', record);

    record.blockHex = hex;

    try {
      const response = await submit();
      // submitblock does not answer with a simple yes/no. Bitcoin Core, and
      // Dogecoin Core with it, returns null on success but also "duplicate",
      // "inconclusive" and "duplicate-inconclusive" for blocks that are
      // perfectly valid yet did not become the chain tip — typically because
      // somebody else's block for that height arrived first. Calling those
      // "rejected" would be both wrong and alarming.
      const verdict = response === null || response === undefined ? 'accepted' : String(response);

      if (verdict === 'accepted' || verdict === 'duplicate') {
        record.status = 'accepted';
        record.accepted = true;
        this.stats.blocksFound++;
        this.stats.lastBlock = record;
        if (this.store) {
          this.store.updateBlock(record.hash, { status: 'accepted', accepted: true });
          this.store.save(true);
        }
        this.log(`BLOCK ACCEPTED at ${where} — ${hash}`);
        // Also guarded: this call sits inside the try that decides the
        // block's fate, so a throwing listener would land in the catch below
        // and rewrite an ACCEPTED block to "error" — on disk.
        this.emitSafely('block', record);
      } else if (verdict.includes('inconclusive')) {
        record.status = 'stale';
        record.accepted = false;
        record.error = 'valid, but another block reached this height first';
        if (this.store) this.store.updateBlock(record.hash, { status: 'stale', accepted: false, error: record.error });
        this.log(`block at ${where} was orphaned (${verdict})`);
      } else {
        record.status = 'rejected';
        record.accepted = false;
        record.error = verdict;
        if (this.store) this.store.updateBlock(record.hash, { status: 'rejected', accepted: false, error: verdict });
        this.log(`${what} REJECTED by node: ${verdict}`);
      }
    } catch (err) {
      record.status = 'error';
      record.accepted = false;
      record.error = err.message;
      if (this.store) this.store.updateBlock(record.hash, { status: 'error', accepted: false, error: err.message });
      this.log(`${what} submission failed: ${err.message}`);
    }
    // Whatever happened, get a fresh template immediately.
    this.refreshTemplate('post-submit').catch(() => {});
  }

  // ------------------------------------------------------------------ vardiff

  // Aim for one share every `targetShareSeconds`. Miners here differ by more
  // than a factor of five in hashrate, so a single fixed difficulty would either
  // flood the server or leave the small miner apparently idle for minutes.
  retarget(client) {
    const window = this.config.vardiffWindow;
    // Anchor on a TIMESTAMP, not an index into shareTimes. That array is capped
    // and shifts its oldest entries out, so an index anchor stops matching the
    // data it points at: once the cap is reached the length stops growing, the
    // count of "shares since the last adjustment" sticks at zero, and vardiff
    // silently never adjusts again.
    const since = client.lastRetargetAt || 0;
    const sinceRetarget = client.shareTimes.filter((s) => s.at > since);
    if (sinceRetarget.length < window) return;
    const recent = sinceRetarget.slice(-window);
    const elapsed = (recent[recent.length - 1].at - recent[0].at) / 1000;
    if (elapsed <= 0) return;

    const actual = elapsed / (recent.length - 1);
    const desired = this.config.targetShareSeconds;
    const ratio = desired / actual;
    if (ratio > 0.75 && ratio < 1.33) return;

    // Round to a power of two BEFORE clamping. The other order lets the
    // rounding step push the result back outside the configured bounds.
    const next = clamp(
      roundDifficulty(client.difficulty * clamp(ratio, 0.25, 4)),
      client.limits.minDifficulty,
      client.limits.maxDifficulty
    );
    if (Math.abs(next - client.difficulty) / client.difficulty < 0.1) return;

    // Keep the share history: each entry carries the difficulty it was solved
    // at, so a mixed-difficulty window still sums correctly — and clearing it
    // would reset the hashrate estimate to a two-sample guess after every
    // adjustment.
    client.lastRetargetAt = Date.now();
    this.setDifficulty(client, next);
    if (this.currentJob) this.sendJob(client, this.currentJob, false);
  }

  // --------------------------------------------------------------- reporting

  clientHashrate(client) {
    // One share at stratum difficulty D costs D * 2^16 hashes on scrypt.
    // Using 2^32 here — the Bitcoin figure — would overstate every reading by
    // a factor of 65536.
    const cutoff = Date.now() - this.config.hashrateWindowMs;
    const recent = client.shareTimes.filter((s) => s.at >= cutoff);
    if (recent.length < 2) return 0;
    const seconds = (Date.now() - recent[0].at) / 1000;
    if (seconds <= 0) return 0;
    // Drop the first share from the numerator. The elapsed time spans the
    // intervals BETWEEN the samples, so counting all of them — including the
    // one that merely marks the start — inflates the estimate by n/(n-1),
    // which is a factor of two when the window is short.
    const work = recent.reduce((sum, s) => sum + s.difficulty, 0) - recent[0].difficulty;
    return (work * u.HASHES_PER_SHARE_UNIT) / seconds;
  }

  snapshot() {
    const workers = [...this.clients.values()]
      .filter((c) => c.authorized)
      .map((c) => ({
        id: c.id,
        // Which port this worker is on — 'primary' or 'rented'. Lets the
        // dashboard label a worker instead of leaving it to be inferred from
        // its difficulty, which a fast home miner can otherwise approach.
        entry: c.entry,
        worker: c.worker,
        userAgent: c.userAgent,
        remote: c.remote,
        difficulty: c.difficulty,
        hashrate: this.clientHashrate(c),
        accepted: c.accepted,
        rejected: c.rejected,
        bestShareDiff: c.bestShareDiff,
        payoutAddress: c.payoutAddress || this.config.payoutAddress,
        // The worker's own Litecoin and Pepecoin addresses, from a public
        // username. Null on the private port, and pepPayoutAddress is null for
        // a public miner that gave no Pepecoin address: the pool overview
        // counts only the miners that actually mine Pepecoin as PEP hashrate.
        ltcPayoutAddress: c.ltcPayoutAddress || null,
        pepPayoutAddress: c.pepPayoutAddress || null,
        connectedAt: c.connectedAt,
        lastShareAt: c.lastShareAt,
        latencyMs: c.latencyMs == null ? null : c.latencyMs,
        latencyFrom: c.latencyFrom || null,
        rejectReasons: { ...(c.rejectReasons || {}) },
        // Recent share timestamps, so the dashboard can show the rhythm of a
        // worker rather than just a number. A miner that stalled two minutes
        // ago looks identical to a healthy one on an averaged hashrate.
        shareHistory: c.shareTimes.slice(-48).map((s) => s.at),
      }));

    const job = this.currentJob;
    // In merged mode the headline numbers stay DOGECOIN's — height, difficulty,
    // reward. This is a Dogecoin app: "how long until a block" means a Dogecoin
    // block, and showing Litecoin's height beside a Dogecoin payout address
    // would be actively misleading. The parent chain gets its own object.
    const merged = this.merged && job
      ? {
          parentChain: 'LTC',
          parentHeight: job.height,
          parentDifficulty: job.networkDifficulty,
          parentReward: job.coinbaseValue,
          parentPayoutAddress: this.config.ltcPayoutAddress,
        }
      : null;
    // Every chain one hash can win on, with its own network difficulty in the
    // same consensus space as bestShareDiff — so best / difficulty is how close
    // the best share came to a block on THAT chain. One hash, several targets:
    // the same share is a far bigger fraction of a Pepecoin block than of a
    // Litecoin one, and the dashboard shows each.
    // The hashrate that can actually win each chain. On the public port a
    // miner mines Pepecoin only when its username carries a Pepecoin address,
    // so Pepecoin's share of the hashrate is those miners' alone; everywhere
    // else every connected miner mines every chain in the job.
    const allHashrate = workers.reduce((t, w) => t + w.hashrate, 0);
    const pepHashrate = this.publicMerged
      ? workers.filter((w) => w.pepPayoutAddress).reduce((t, w) => t + w.hashrate, 0)
      : allHashrate;
    const chains = !job
      ? []
      : this.merged
        ? [
            {
              name: 'LTC', label: 'Litecoin', height: job.height, difficulty: job.networkDifficulty,
              hashrate: allHashrate, reward: job.coinbaseValue, blockSeconds: 150,
            },
            {
              name: 'DOGE', label: 'Dogecoin', height: job.auxHeight, difficulty: job.auxDifficulty,
              hashrate: allHashrate, reward: job.auxValue, blockSeconds: 60,
            },
            ...(job.extraAux || []).map((a) => ({
              name: a.name,
              label: a.name === 'PEP' ? 'Pepecoin' : a.name === 'SOQ' ? 'Soqucoin' : a.name,
              height: a.height,
              difficulty: a.difficulty,
              hashrate: a.name === 'PEP' ? pepHashrate : allHashrate,
              // What the block pays (subsidy + fees, smallest unit) and the
              // chain's target block time — with the difficulty, that gives
              // the network's hashrate on the dashboard. Pepecoin and
              // Soqucoin both aim for a block a minute.
              reward: a.value,
              blockSeconds: 60,
              // Only the shares made while this chain was being mined.
              best: this.stats.chainBest[a.name] ? this.stats.chainBest[a.name].diff : 0,
            })),
          ]
        : [{
            name: 'DOGE', label: 'Dogecoin', height: job.height, difficulty: job.networkDifficulty,
            hashrate: allHashrate, reward: job.coinbaseValue, blockSeconds: 60,
          }];
    return {
      chain: this.chain,
      mergedMining: !!this.merged,
      merged,
      chains,
      stratumPort: this.config.stratumPort,
      // Null only when no second port was ever configured. Stays the actual
      // port number even if binding it failed (see the catch in start()) —
      // that is what lets the dashboard tell "configured, failed to bind"
      // apart from "never configured" using rentedPortActive below, instead
      // of both states collapsing into the same blank connect box while the
      // rented port silently loses whatever is pointed at it.
      rentedStratumPort: this.rentedPortLimits ? this.config.rentedStratumPort : null,
      rentedPortActive: !!this.rentedServer,
      payoutAddress: this.config.payoutAddress,
      lockPayoutAddress: !!this.config.lockPayoutAddress,
      profile: this.config.profile || 'home',
      startedAt: this.stats.startedAt,
      height: job ? (this.merged ? job.auxHeight : job.height) : null,
      networkDifficulty: job ? (this.merged ? job.auxDifficulty : job.networkDifficulty) : null,
      smoothedDifficulty: this.smoothedDifficulty(),
      difficultySamples: (this.difficultyHistory || []).length,
      nodeLatencyMs: this.medianNodeLatency(),
      firstStartedAt: this.stats.firstStartedAt || this.stats.startedAt,
      coinbaseValue: job ? (this.merged ? job.auxValue : job.coinbaseValue) : null,
      templateAgeMs: this.stats.lastTemplateAt ? Date.now() - this.stats.lastTemplateAt : null,
      templateError: this.stats.templateError,
      // 'unreachable' (the node is not answering) or 'unusable' (it answered
      // with something this pool cannot turn into a job). Both mean nothing is
      // being mined; they send the operator to completely different places.
      templateErrorKind: this.stats.templateErrorKind || null,
      auxError: this.stats.auxError || null,
      // Timestamps, not just the human sentences above. The health monitor
      // decides "how long has this been true" and must not have to parse a
      // number back out of an English string — and a sentence that already
      // contains a duration cannot be compared against a threshold at all.
      templateFailedAt: this.stats.templateFailedAt || null,
      auxUnavailableSince: this.auxUnavailableSince || null,
      // Evidence for the aux longpoll, both directions: how often dogecoind
      // told us its tip moved, and how many solved Dogecoin blocks were lost
      // because we found out too late.
      // What the aux chain falls back to when the longpoll is off or has given
      // up, so the dashboard can say "polling every 2s" rather than leaving the
      // user to guess what "not longpolling" means.
      pollIntervalMs: this.config.pollIntervalMs,
      auxLongpoll: !!(this.merged && this.config.auxLongpoll && !this.auxLongpollDisabled),
      auxLongpollDisabled: this.auxLongpollDisabled || null,
      auxLongpollSignals: this.auxLongpollSignals || 0,
      auxTipMoves: this.auxTipMoves || 0,
      auxTipMissed: this.stats.auxTipMissed || 0,
      auxTipMissedAt: this.stats.auxTipMissedAt || null,
      // Pepecoin, when configured. Never part of the health verdict: it is an
      // extra, and its node being down changes nothing about LTC and DOGE.
      pep: this.pep
        ? {
            height: this.pep.block ? this.pep.block.height : null,
            hash: this.pep.block ? this.pep.block.hash : null,
            unavailableSince: this.pep.unavailableSince || null,
            error: this.pep.error || null,
            tipMissed: this.stats.pepTipMissed || 0,
            tipMissedAt: this.stats.pepTipMissedAt || null,
          }
        : null,
      // Soqucoin likewise, private mode only.
      soq: this.soq
        ? {
            height: this.soq.block ? this.soq.block.height : null,
            hash: this.soq.block ? this.soq.block.hash : null,
            unavailableSince: this.soq.unavailableSince || null,
            error: this.soq.error || null,
            tipMissed: this.stats.soqTipMissed || 0,
            tipMissedAt: this.stats.soqTipMissedAt || null,
          }
        : null,
      soqIgnored: this.soqIgnored || null,
      accepted: this.stats.accepted,
      rejected: this.stats.rejected,
      rejectReasons: this.stats.rejectReasons,
      // When these counters were last zeroed by hand. Null means they are the
      // lifetime figures; a timestamp means the dashboard must say so, or the
      // reject rate reads as "since forever" when it is not.
      resetAt: this.stats.resetAt || (this.store ? this.store.state.resetAt : null) || null,
      // Consensus-space, so it is directly comparable with networkDifficulty.
      bestShareDiff: this.stats.bestShareDiff,
      // The same share expressed in the stratum units a miner reports, which
      // is 65536x larger. Rendering the consensus value in a widget shows "0"
      // for a perfectly healthy miner.
      bestShareStratum: this.stats.bestShareDiff * u.HASHES_PER_SHARE_UNIT,
      bestShareAt: this.stats.bestShareAt,
      blocksFound: this.stats.blocksFound,
      // Strip blockHex. A mainnet block is tens to hundreds of kilobytes, and
      // fifty of them re-serialised into every five-second dashboard poll turns
      // a win into a performance problem. The hex is kept in memory for a
      // manual resubmit and written to the container log when the block is
      // found; the dashboard has no use for it.
      blocks: this.stats.blocks.map(({ blockHex, ...rest }) => rest),
      workers,
      totalHashrate: workers.reduce((s, w) => s + w.hashrate, 0),
    };
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Snap to powers of two. Scrypt ASIC firmware is derived from cgminer, which
// stores the stratum difficulty as a double and derives the target from it;
// clean powers of two avoid rounding disagreements between our target and the
// miner's, which would show up as shares we consider one notch too easy.
function roundDifficulty(d) {
  const exp = Math.round(Math.log2(d));
  return Math.pow(2, exp);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { Pool };
