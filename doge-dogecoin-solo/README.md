# Dogecoin Solo Mining

A stratum v1 server that turns your own Dogecoin node into a solo pool of one.
Your miners connect here instead of to a pool; block templates come from your
node, candidate blocks are submitted by your node, and the reward pays to an
address you control.

## What it is not

It is not a pool. There is no share ledger, no payout engine, no database, and
no operator taking a cut. The coinbase of the block *is* the payout. That is
also why there is nothing here to corrupt: the only state is in memory, and
losing it costs you a reconnect.

## Setup

1. Install the Dogecoin Node app first and let it finish syncing. This app
   declares it as a dependency, which is what makes the node's RPC credentials
   available here.
2. Create `~/umbrel/app-data/doge-dogecoin-solo/.env` on the device with a
   Dogecoin address you control:

   ```
   PAYOUT_ADDRESS=D...
   ```

   The app refuses to start without one, and validates the checksum — a typo
   would otherwise mean mining a reward nobody can spend.
3. Point your miners at `stratum+tcp://<your-umbrel-ip>:22557`. Any password.

### Why `.env` and not `docker-compose.yml`

umbrelOS regenerates `app-data/<app>/docker-compose.yml` from the app store on
every install and every update, so a setting typed there survives until the next
update and then vanishes. It never touches `.env`. `exports.sh` reads that file
and hands the values to the compose file, so the same settings come back after
an update instead of reverting to the defaults — which for merged mining means
the difference between still mining two chains in the morning and quietly
mining one.

Recognised keys, all optional except the first:

| Key | Default | What it does |
| --- | --- | --- |
| `PAYOUT_ADDRESS` | — | Dogecoin address for block rewards. Required. |
| `MINING_PROFILE` | `home` | `home` or `rented`; switches every limit on the main port at once. |
| `RENTED_STRATUM_PORT` | — | A second, dedicated port that is always at the rented profile's numbers — see below. |
| `MERGED_MINING` | `0` | `1` to mine Dogecoin and Litecoin from the same hashes. |
| `POLL_INTERVAL_SECONDS` | `2` | How often the Dogecoin aux block is refreshed. Floored at 0.5. |
| `LTC_PAYOUT_ADDRESS` | — | Litecoin address (`L…`, `M…` or `3…`). Required when merged. |
| `LTC_RPC_PASSWORD` | — | From the Litecoin Node app. Required when merged. |
| `LTC_RPC_HOST` | `doge-litecoin-node_litecoind_1` | Only if your Litecoin node lives elsewhere. |
| `LTC_RPC_PORT` | `9332` | |
| `LTC_RPC_USER` | `umbrel` | |

Anything else in the file is ignored on purpose: `exports.sh` is sourced into
umbrelOS's own shell while it starts apps, so a stray `PATH=` line there must
not be able to reach outside this app.

Put a Dogecoin address in the **username** field and blocks that worker finds
pay to that address instead of the configured one. That is how these small
scrypt ASICs are set up anyway, so they work with their normal configuration.

## Switching the mining profile without SSH

The dashboard has a **Mining profile** section with `Home` / `Rented` buttons.
Pressing one applies instantly — no `.env` edit, no `apps.stop` + `apps.start`,
and no dropped shares, because it changes the running pool's configuration in
place rather than starting a new process. The choice is written to this app's
data directory, so it survives a restart or an update the same way a setting
in `.env` does.

Switching to `Rented` is refused, from the dashboard, by the same rule that
already guards it at startup: `LOCK_PAYOUT_ADDRESS=1` must be set in `.env`
first, because that profile assumes the stratum port is open to the internet
and an unlocked payout on an open port pays whoever asks. The button explains
this when it applies.

If `MINING_PROFILE` is set in `.env`, the dashboard control goes read-only and
says so — an operator who fixed it there meant to fix it, and a button that
silently overrode that would be a worse surprise than not having the button.
Remove the line from `.env` (and restart the app) to hand control back to the
dashboard.

## Running your own miners and a rented order at the same time

`MINING_PROFILE` has one real limitation: it is a single port switched
between two regimes, so your own home miners and a rented order can never
both be correctly configured at once. Switch to `rented` for the order and a
home ASIC still connected gets the same jump in starting difficulty — it
does not disconnect, it just stops finding shares fast enough to look alive,
which reads as "my miner broke the moment I rented hashpower."

`RENTED_STRATUM_PORT` fixes that by opening a **second** stratum port,
always at the rented profile's numbers, running at the same time as the
main one:

```
RENTED_STRATUM_PORT=22558
```

Point your own miners at the usual port (`22557`) as always. Point a rented
order at this one instead. Neither setup has to know the other exists —
switching or restarting one never touches the other, because they are two
separate listeners with two separate sets of limits, not one port whose
meaning changes.

Like `MINING_PROFILE=rented`, this requires `LOCK_PAYOUT_ADDRESS=1` — the
app refuses to start otherwise, for the same reason: this port is meant to
be reachable from the internet, and an unlocked payout on an open port pays
whoever asks. It is also meant to be **forwarded on your router only while
an order is running**, and un-forwarded the moment it ends, exactly like the
main port under `MINING_PROFILE=rented`.

An explicit override (`START_DIFFICULTY` and the rest, listed under
"Difficulty, and why the numbers look large" below) still wins over any
profile everywhere it applies — including on this port. If you have one of
those set to fix the main port's currently active profile, the same value
reaches this port too.

The dashboard's "Mining profile" section shows whether this port is
configured, and each row in the worker table is labelled with which port
that worker is actually connected to — useful once both are in use at once,
since a fast home device and a slow rented one can otherwise look similar
on the page.

## Difficulty, and why the numbers look large

Scrypt stratum difficulty is not Bitcoin's. Every piece of scrypt mining
software applies a factor of 2^16, so a share at difficulty *D* costs
`D × 65536` hashes, not `D × 2^32`. This is a convention baked into the miners
themselves, not something a pool chooses:

- cgminer v3.7.2, `set_target()`: `if (opt_scrypt) d64 *= (double)65536;`
- pooler/cpuminer, `stratum_gen_work()`: `diff_to_target(work->target, sctx->job.diff / 65536.0)`
- node-stratum-pool `algoProperties.js`: `scrypt: { multiplier: Math.pow(2, 16) }`
- Miningcore `coins.json`, litecoin and dogecoin: `"shareMultiplier": 65536`

So difficulty 2048 here means roughly one share every 12 seconds from an
11 MH/s device. Vardiff tunes each worker separately; `MIN_DIFFICULTY` and
`MAX_DIFFICULTY` are only the bounds.

Network difficulty, by contrast, is in the ordinary consensus space. The two
must never be mixed, and the code keeps them in separate functions
(`targetFromShareDifficulty` vs `targetFromDifficulty`) for exactly that reason.

## Expectations

Solo mining is a lottery. At 83 MH/s against a ~2.9 PH/s network with one-minute
blocks, the expected wait is roughly 66 years, and the chance of a block in any
given month is about 0.13%. When you do win, you win the entire block — a little
over 10,000 DOGE at the current subsidy. The dashboard shows your real expected
wait rather than a progress bar, because there is no progress: every share
starts the lottery over.

The "distance to a block" ruler shows how close your best share came, on a
logarithmic scale. It is a record of near misses, not a countdown.

## How it is verified

Block construction is the part where a mistake stays invisible until the day it
costs you a block, so it is tested against Dogecoin Core itself rather than
against assumptions:

- `test/mine_regtest.js` builds blocks with this code and has a real dogecoind
  accept them, then checks the coinbase pays the right address for the right
  amount and the block version survived intact.
- `test/stratum_e2e.js` mines through the wire protocol with a miner that
  rebuilds everything from the `mining.notify` parameters alone, so a wrong
  prevhash word-swap or coinbase split fails the test.
- `test/stratum_payout.js` proves a worker with its own payout address is
  notified with, and validated against, the same coinbase — and that the block
  landing on chain is byte-identical to what the miner solved.
- `test/merkle_check.js` reproduces the merkle root of real blocks from their
  txids and compares against the header dogecoind wrote.
- `test/unit.js` checks the share target against cgminer's formula exactly.
- `test/browser_check.js` renders the dashboard in Chromium and fails on any
  console error, CSP violation or horizontal overflow.

## A public port (PUBLIC_MERGED)

The app itself is for your own miners: in merged mode both rewards always go to
your configured addresses. A **public** port — one strangers mine on, each paid
at their own addresses — runs as a *separate* container of the same image,
next to the app, never instead of it:

| Variable | Value |
| --- | --- |
| `MERGED_MINING` | `1` |
| `PUBLIC_MERGED` | `1` |
| `POOL_FEE_PERCENT` | `1` (0–10) |
| `PAYOUT_ADDRESS` / `LTC_PAYOUT_ADDRESS` | where the **fee** goes |
| `MAX_PAYOUT_VARIANTS` | how many distinct miners (address pairs) at once, e.g. `64` |

Miners use the username `<LTC address>.<DOGE address>[.rigname]`; legacy
(`L…`/`M…`/`3…`) and native segwit (`ltc1q…`) Litecoin addresses both work.
A name without two valid addresses is refused at authorize, so no reward can
end up somewhere nobody asked for.

How it differs from the private mode: `createauxblock` can only pay one
address, so in public mode the pool builds each miner's Dogecoin block itself
from `getblocktemplate` — 99% to the miner, the fee to you — and hands it in
with `submitblock`, auxpow included. The Litecoin coinbase is split the same
way. `LOCK_PAYOUT_ADDRESS` and `RENTED_STRATUM_PORT` are refused in this mode.

Proven against the daemons by `test/public_aux_regtest.js` (a self-built,
fee-paying aux block accepted on both chains, non-empty mempools),
`test/public_merged_pool.js` (two strangers through the wire protocol; the
winner is paid 99/1 on both chains, the other nothing) and
`test/public_coexist.js` (the private app and the public container on the same
two nodes). `test/public_unit.js` covers the pure parts in CI, including that
the private mode's coinbase is unchanged byte for byte.

## Ports

| Port | What | Forward on your router? |
|---|---|---|
| 22551 | Dashboard, behind the umbrelOS login | No |
| 22557 | Stratum | **No** — anyone who reaches it can mine to their own address using your node's templates |
| 22558 | The dedicated rented-capacity port. Claimed on the host from 1.6.0 onward whether or not you use it — Docker Compose cannot publish a port only conditionally — but the app only *listens* here once `RENTED_STRATUM_PORT` is set in `.env`. If something else on your device already uses 22558, set `RENTED_STRATUM_PORT` to a free port instead. | **Only while a rented order is running** — un-forward it the moment the order ends |

## Configuration

Device-specific settings — the payout addresses, the merged-mining switch, the
mining profile, the Litecoin RPC password, the poll interval — go in
`~/umbrel/app-data/doge-dogecoin-solo/.env`, which survives app updates. See
"Why `.env` and not `docker-compose.yml`" above for the full list.

Everything else is an environment variable in `docker-compose.yml`. Editing the
running copy under `~/umbrel/app-data/` works but is overwritten on the next
update; change the repo and update the app to make it stick.

After changing anything, stop and start the app — never restart it. `docker
restart` gives a container 10 seconds and then kills it, ignoring
`stop_grace_period`. That matters much more for the node app than for this one,
but the habit is worth keeping.
