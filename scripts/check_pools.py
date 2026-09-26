#!/usr/bin/env python3
"""
Independent live check of the public pools, from the outside, exactly as a
miner sees them: connect to pool.cryptocodes.eu, subscribe, authorize with a
TEST address (no shares are submitted, so nothing is mined), take the first
mining.notify, rebuild the coinbase transaction and list its outputs.

A pool is OK when the coinbase pays exactly two parties: the test miner ~99%
and OUR fee address ~1% (plus zero-value commitment outputs).

    python3 check_pools.py
"""
import json, socket, time

HOST = "pool.cryptocodes.eu"
# The test miner: the hash160 of the Bitcoin genesis address, in each chain's
# format. Nobody's shares, nobody's money — only used to read the work.
TEST_H160 = "62e907b15cbf27d5425399ebf6f0fb50ebb88f18"
TEST_SCRIPT = "76a914" + TEST_H160 + "88ac"
FEE = {
    "BTC": "001458df2ab95ea4db620ef4897431359b5f6c026f01",   # bc1qtr0j4w275ndkyrh5396rzdvmtakqymcp046cht
    "BCH": "76a91443c86bedc7b3069cd5fa41a258a7de56edeb68d688ac",  # bitcoincash:qppus6ldc7esd8x4lfq6yk98metwm6mg6czuhu4k8p
    "LTC": "76a914c4be596b686aced9c75897b6aeda57dc0bcbf45188ac",  # LdAEjWgrrUjyV6Cy3DTKZ3uBNmG3FQhXsj
}
POOLS = [
    ("BTC", 3333, "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa.check"),
    ("BTC rental", 3338, "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa.check"),
    ("BCH", 3334, "bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy.check"),
    ("BCH rental", 3337, "bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy.check"),
    ("LTC+DOGE", 3335, "LUEweDxDA4WhvWiNXXSxjM9CYzHPJv4QQF.DEA5vGb2NpAwCiCp5yTE16F3DueQUVivQp.check"),
]


def varint(b, i):
    n = b[i]
    if n < 0xFD:
        return n, i + 1
    size = {0xFD: 2, 0xFE: 4, 0xFF: 8}[n]
    return int.from_bytes(b[i + 1:i + 1 + size], "little"), i + 1 + size


def outputs_of(tx):
    i = 4                                  # version
    n_in, i = varint(tx, i)
    for _ in range(n_in):
        i += 36                            # prevout
        ln, i = varint(tx, i)
        i += ln + 4                        # scriptSig + sequence
    n_out, i = varint(tx, i)
    outs = []
    for _ in range(n_out):
        value = int.from_bytes(tx[i:i + 8], "little"); i += 8
        ln, i = varint(tx, i)
        outs.append((value, tx[i:i + ln].hex())); i += ln
    return outs


def work(port, user):
    s = socket.create_connection((HOST, port), timeout=15)
    f = s.makefile("rwb")
    def send(obj):
        f.write((json.dumps(obj) + "\n").encode()); f.flush()
    send({"id": 1, "method": "mining.subscribe", "params": ["check/1.0"]})
    send({"id": 2, "method": "mining.authorize", "params": [user, "x"]})
    en1 = en2size = None
    deadline = time.time() + 20
    while time.time() < deadline:
        line = f.readline()
        if not line:
            break
        msg = json.loads(line)
        if msg.get("id") == 1 and msg.get("result"):
            en1, en2size = msg["result"][1], msg["result"][2]
        if msg.get("id") == 2 and msg.get("result") is not True:
            raise RuntimeError(f"authorize refused: {msg.get('error')}")
        if msg.get("method") == "mining.notify" and en1 is not None:
            p = msg["params"]
            s.close()
            return bytes.fromhex(p[2] + en1 + "00" * en2size + p[3])
    s.close()
    raise RuntimeError("no work received")


all_ok = True
for name, port, user in POOLS:
    chain = "LTC" if name.startswith("LTC") else name.split()[0]
    try:
        cb = work(port, user)
    except Exception as e:
        print(f"{name:11} :{port}  NOT REACHABLE / REFUSED — {e}")
        all_ok = False
        continue
    outs = [(v, sc) for v, sc in outputs_of(cb) if v > 0]
    total = sum(v for v, _ in outs)
    miner = sum(v for v, sc in outs if sc == TEST_SCRIPT)
    fee = sum(v for v, sc in outs if sc == FEE[chain])
    other = [(v, sc) for v, sc in outs if sc not in (TEST_SCRIPT, FEE[chain])]
    pct = 100 * fee / total if total else 0
    ok = total > 0 and not other and 0.99 <= pct <= 1.01 and miner + fee == total
    all_ok &= ok
    extra = "  (aux commitment present)" if b"\xfa\xbe\x6d\x6d" in cb else ""
    print(f"{name:11} :{port}  miner {miner/1e8:.8f}  fee {fee/1e8:.8f} = {pct:.3f}%  "
          f"{'OK' if ok else 'PROBLEM'}{extra}")
    for v, sc in other:
        print(f"             unexpected output {v/1e8:.8f} to script {sc}")

print("\nALL POOLS PAY THE MINER 99% AND US 1%" if all_ok else "\nSEE ABOVE")
