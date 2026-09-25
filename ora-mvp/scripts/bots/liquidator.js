// ORA liquidation keeper — scans every branch for troves below the branch MCR
// and liquidates them (soft-liquidation preferred inside the partial band on
// branches that support it; BatchLiquidator sweeps for waves).
//
// One keeper process is single-threaded and sequential (manual nonces); run
// TWO (different infra/operators) for redundancy — liquidation is
// first-wins and idempotent, so active-active is safe. Death of a keeper is
// detected via the heartbeat file / metrics (see the realtime monitor).
//
//   one-shot (local):  node scripts/bots/liquidator.js
//   watch mode:        node scripts/bots/liquidator.js --watch
//   Base Sepolia:      ORA_RPC_URL=https://sepolia.base.org \
//                      ORA_DEPLOYMENT=app/deployment-baseSepolia.json \
//                      ORA_KEEPER_KEY=0x... ORA_METRICS_PORT=9090 \
//                      ORA_HEARTBEAT_FILE=/var/run/ora-keeper.json \
//                      node scripts/bots/liquidator.js --watch
//
// Env knobs:
//   ORA_KEEPER_SHARD     "i/N" (default "0/1"): multi-operator sharding. Keeper i
//                        handles candidates with keccak(owner) % N == i — run N
//                        keepers on different infra for overlap-free coverage.
//   ORA_KEEPER_KEY       signer key (REQUIRED off localhost; no default on live nets)
//   ORA_POLL_SECONDS     watch interval (30)
//   ORA_SCAN_TROVES      cursor page size (500; single pages OOG past ~700)
//   ORA_MAX_PAGES        0 = scan to the end (default); N caps pages per branch
//   ORA_USE_BATCH        1 = route 2+ candidates via BatchLiquidator (default 1)
//   ORA_BATCH_CHUNK      max troves per sweep tx (40; ~150k gas each measured)
//   ORA_MAX_FEE_GWEI     fee cap; sends above it are skipped, not stuck (200)
//   ORA_PRIORITY_FEE_GWEI priority fee (2)
//   ORA_METRICS_PORT     0 = disabled; else serve /metrics + /health (Prometheus)
//   ORA_HEARTBEAT_FILE   path for the JSON heartbeat (crash detection)
//   ORA_ALERT_WEBHOOK    POST {text} on crash / repeated scan failure
const { ethers } = require("ethers");
const fs = require("fs");
const http = require("http");
const path = require("path");

const RPC = process.env.ORA_RPC_URL || "http://127.0.0.1:3000/rpc";
const DEP = process.env.ORA_DEPLOYMENT || path.join(__dirname, "..", "..", "app", "deployment.json");
const POLL = Number(process.env.ORA_POLL_SECONDS || 30);
const PAGE = Number(process.env.ORA_SCAN_TROVES || 500);
const MAX_PAGES = Number(process.env.ORA_MAX_PAGES || 0);
const USE_BATCH = process.env.ORA_USE_BATCH !== "0";
const CHUNK = Number(process.env.ORA_BATCH_CHUNK || 40);
const MAX_FEE = ethers.parseUnits(process.env.ORA_MAX_FEE_GWEI || "200", "gwei");
const PRIO_FEE = ethers.parseUnits(process.env.ORA_PRIORITY_FEE_GWEI || "2", "gwei");
const METRICS_PORT = Number(process.env.ORA_METRICS_PORT || 0);
const HEARTBEAT = process.env.ORA_HEARTBEAT_FILE || "";
const WEBHOOK = process.env.ORA_ALERT_WEBHOOK || "";
const LOCAL_KEY = "0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e"; // hardhat #19

// Multi-operator sharding (finding 9): deterministic split of liquidation
// candidates across N independent keepers — no overlap, no coordination,
// and a dead keeper's shard is visible as its candidates going unhandled
// (the realtime monitor watches keeper heartbeats per shard file).
function parseShard(s) {
  const m = /^(\d+)\/(\d+)$/.exec(String(s).trim());
  if (!m) throw new Error(`bad ORA_KEEPER_SHARD "${s}" (want "i/N", e.g. "1/3")`);
  const i = Number(m[1]), n = Number(m[2]);
  if (!(n >= 1 && n <= 32 && i < n)) throw new Error(`bad ORA_KEEPER_SHARD "${s}" (need 0 <= i < N <= 32)`);
  return { i, n };
}
function inShard(owner, { i, n }) {
  if (n === 1) return true;
  return Number(BigInt(ethers.keccak256(ethers.getBytes(owner))) % BigInt(n)) === i;
}
const SHARD = parseShard(process.env.ORA_KEEPER_SHARD || "0/1");

const f = v => Number(ethers.formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const M = { scans: 0, actions: 0, errors: 0, trovesSeen: 0, candidates: 0, shardedOut: 0, lastScanTs: 0, lastError: "" };
let lastAlertTs = 0;

async function alert(text) {
  const now = Date.now();
  if (now - lastAlertTs < 5 * 60 * 1000) return; // 5-min cooldown
  lastAlertTs = now;
  console.error(`ALERT: ${text}`);
  if (!WEBHOOK) return;
  try {
    await fetch(WEBHOOK, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `[ora-keeper] ${text}` }) });
  } catch (e) { console.error("webhook failed:", e.message); }
}

function writeHeartbeat() {
  if (!HEARTBEAT) return;
  const tmp = HEARTBEAT + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ ts: Date.now(), ...M }));
  fs.renameSync(tmp, HEARTBEAT);
}

function serveMetrics() {
  if (!METRICS_PORT) return;
  http.createServer((req, res) => {
    if (req.url === "/health") {
      const stale = Date.now() / 1000 - M.lastScanTs > Math.max(120, POLL * 4);
      res.writeHead(stale ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: !stale, ...M }));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end([
      "# HELP ora_keeper_scans_total completed scans",
      "# TYPE ora_keeper_scans_total counter",
      `ora_keeper_scans_total ${M.scans}`,
      `ora_keeper_liquidations_total ${M.actions}`,
      `ora_keeper_scan_errors_total ${M.errors}`,
      `ora_keeper_troves_seen ${M.trovesSeen}`,
      `ora_keeper_candidates ${M.candidates}`,
      `ora_keeper_sharded_out_total ${M.shardedOut}`,
      `ora_keeper_shard_info{shard="${SHARD.i}",of="${SHARD.n}"} 1`,
      `ora_keeper_last_scan_timestamp ${M.lastScanTs}`,
    ].join("\n") + "\n");
  }).listen(METRICS_PORT, () => console.log(`metrics on :${METRICS_PORT}/metrics`));
}

// Send with gas escalation: if the tx isn't mined within 60s, rebroadcast
// the SAME nonce at +25% fees, up to ORA_MAX_FEE_GWEI, then give up loudly.
async function sendTx(wallet, nonce, req) {
  const fee = await wallet.provider.getFeeData();
  let maxFee = (fee.maxFeePerGas || fee.gasPrice || MAX_FEE) + PRIO_FEE;
  for (let attempt = 0; ; attempt++) {
    if (maxFee > MAX_FEE) throw new Error(`fee cap exceeded (${ethers.formatUnits(MAX_FEE, "gwei")} gwei)`);
    const tx = await wallet.sendTransaction({ ...req, nonce, maxFeePerGas: maxFee, maxPriorityFeePerGas: PRIO_FEE });
    try {
      return await tx.wait(1, 60_000);
    } catch (e) {
      if (e.code === "TIMEOUT" && attempt < 5) {
        maxFee = maxFee * 125n / 100n; // same nonce, +25%
        console.log(`  escalating ${tx.hash.slice(0, 10)} -> ${ethers.formatUnits(maxFee, "gwei")} gwei`);
        continue;
      }
      throw e;
    }
  }
}

// Cursor pages to the end of the list (O(page) each); legacy MTG single
// page when the deployment predates the cursor.
async function scanBranch(dep, B, wallet) {
  const A = dep.abis;
  const tm = new ethers.Contract(B.troveManager,
    B.rates ? A.troveManagerRates : (A.troveManagerV2 || A.troveManager), wallet);
  const feedAbi = B.rwa ? (A.wtBillPriceFeed || A.priceFeedRWA) : B.native ? A.priceFeed : A.priceFeedWstETH;
  const feed = new ethers.Contract(B.priceFeed, feedAbi, wallet);
  const price = await feed.getPrice();
  const rows = [];
  if (dep.shared.troveCursor && A.troveCursor) {
    const cursor = new ethers.Contract(dep.shared.troveCursor, A.troveCursor, wallet);
    let next = ethers.ZeroAddress, pages = 0;
    for (;;) {
      const [batch, nxt] = await cursor.scan(B.troveManager, B.sortedTroves, next, PAGE);
      for (const r of batch) rows.push({ owner: r.owner, debt: r.debt, coll: r.coll });
      if (nxt === ethers.ZeroAddress || (MAX_PAGES && ++pages >= MAX_PAGES)) break;
      next = nxt;
    }
  } else {
    console.log("  WARNING: no TroveCursor in deployment — legacy top-500 scan");
    const getter = new ethers.Contract(B.multiTroveGetter, A.multiTroveGetter, wallet);
    for (const r of await getter.getMultipleSortedTroves(0, PAGE))
      rows.push({ owner: r[0], debt: r[1], coll: r[2] });
  }
  return { tm, price, rows };
}

async function scanOnce(dep, wallet, nonceState) {
  let actions = 0;
  for (const [name, B] of Object.entries(dep.branches)) {
    const { tm, price, rows } = await scanBranch(dep, B, wallet);
    M.trovesSeen += rows.length;
    const mcr = ethers.parseEther(String(B.mcr || 1.1));
    const softFloor = ethers.parseEther(String(B.softFloor || 1.05));
    const hasSoft = !B.native && !B.rates && !!(dep.abis.troveManagerV2 || dep.abis.troveManagerRWA);
    const cands = [];
    for (const r of rows) {
      if (r.debt === 0n) continue;
      const icr = r.coll * price / r.debt;
      if (icr < mcr) cands.push({ ...r, icr, soft: hasSoft && icr >= softFloor });
    }
    M.candidates += cands.length;
    const mine = cands.filter(c => inShard(c.owner, SHARD));
    M.shardedOut += cands.length - mine.length;
    if (!mine.length) continue;
    const candsMine = mine;

    // soft-liquidate in-band candidates individually (gentler for borrowers)
    const fulls = [];
    for (const c of candsMine) {
      const label = `${name} ${c.owner.slice(0, 10)} ICR ${(Number(c.icr) / 1e16).toFixed(2)}%`;
      if (c.soft) {
        try {
          await tm.liquidatePartial.staticCall(c.owner);
          const data = tm.interface.encodeFunctionData("liquidatePartial", [c.owner]);
          await sendTx(wallet, nonceState.n++, { to: B.troveManager, data });
          console.log(`  SOFT-LIQ ${label}`);
          actions++;
          continue;
        } catch { /* remainder too small / recovery mode -> full path */ }
      }
      fulls.push({ ...c, label });
    }
    if (!fulls.length) continue;

    // pre-flight each survivor, then sweep in chunks via the BatchLiquidator
    const ready = [];
    for (const c of fulls) {
      try { await tm.liquidate.staticCall(c.owner); ready.push(c); }
      catch (e) { console.log(`  skip ${c.label} — ${(e.shortMessage || e.message || "").slice(0, 80)}`); }
    }
    const useBatch = USE_BATCH && ready.length >= 2 && dep.shared.batchLiquidator && dep.abis.batchLiquidator;
    if (useBatch) {
      const bl = new ethers.Contract(dep.shared.batchLiquidator, dep.abis.batchLiquidator, wallet);
      const orUSD = dep.shared.orUSDToken;
      for (let i = 0; i < ready.length; i += CHUNK) {
        const addrs = ready.slice(i, i + CHUNK).map(c => c.owner);
        const data = bl.interface.encodeFunctionData("batchLiquidateTroves", [B.troveManager, addrs, orUSD]);
        await sendTx(wallet, nonceState.n++, { to: dep.shared.batchLiquidator, data });
        console.log(`  SWEPT ${addrs.length} troves on ${name} (batch)`);
        actions += addrs.length;
      }
    } else {
      for (const c of ready) {
        const data = tm.interface.encodeFunctionData("liquidate", [c.owner]);
        await sendTx(wallet, nonceState.n++, { to: B.troveManager, data });
        console.log(`  LIQUIDATED ${c.label} — debt ${f(c.debt)} orUSD`);
        actions++;
      }
    }
  }
  return actions;
}

async function main() {
  const watch = process.argv.includes("--watch");
  if (!fs.existsSync(DEP)) { console.log(`deployment not found (${DEP}) — nothing to do`); return; }
  const dep = JSON.parse(fs.readFileSync(DEP));
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
  const net = await provider.getNetwork();
  const live = net.chainId !== 31337n;
  if (live && !process.env.ORA_KEEPER_KEY) {
    console.error(`FATAL: ORA_KEEPER_KEY is required on chain ${net.chainId} (refusing the local demo key)`);
    process.exit(1);
  }
  const key = process.env.ORA_KEEPER_KEY || LOCAL_KEY;
  if (!live && !process.env.ORA_KEEPER_KEY)
    console.log("WARNING: local demo key (hardhat #19) — set ORA_KEEPER_KEY anywhere else");
  const wallet = new ethers.Wallet(key, provider);
  console.log(`ORA liquidation keeper — ${wallet.address} @ ${RPC} (chain ${net.chainId})${watch ? ` (watch, ${POLL}s)` : " (one-shot)"} [shard ${SHARD.i}/${SHARD.n}]`);
  serveMetrics();

  const nonceState = { n: await wallet.getNonce("pending") };
  do {
    const started = Date.now();
    try {
      const n = await scanOnce(dep, wallet, nonceState);
      M.scans++;
      M.actions += n;
      M.lastScanTs = Math.floor(Date.now() / 1000);
      console.log(`[${new Date().toISOString()}] scan complete — ${n} liquidation(s)`);
    } catch (e) {
      M.errors++;
      M.lastError = (e.shortMessage || e.message || "").slice(0, 200);
      console.error("scan failed:", M.lastError);
      await alert(`scan failed (${M.errors} total): ${M.lastError}`);
      nonceState.n = await wallet.getNonce("pending").catch(() => nonceState.n);
    }
    writeHeartbeat();
    if (watch) await new Promise(r => setTimeout(r, Math.max(0, POLL * 1000 - (Date.now() - started))));
  } while (watch);
}

if (require.main === module) {
  process.on("uncaughtException", e => { alert(`CRASH: ${e.message}`).finally(() => process.exit(1)); });
  process.on("unhandledRejection", e => { alert(`CRASH: ${e}`).finally(() => process.exit(1)); });
  main().catch(e => { console.error("KEEPER FAILED:", e.shortMessage || e.message); process.exit(1); });
}
module.exports = { parseShard, inShard };
