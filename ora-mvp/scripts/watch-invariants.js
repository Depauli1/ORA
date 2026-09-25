// ORA invariant monitor — read-only health watcher for a live deployment.
//
// Two modes (finding 8):
//   one-shot (default): deep invariant audit, exits 1 on any ERROR.
//     Runs as the CI cron backstop (.github/workflows/monitor.yml).
//   --watch: minute-level realtime loop (default 60s) with webhook alerting
//     on TCR band crossings, usingFallback flips, shock flags (depeg/nav),
//     oracle outages, large redemptions, and keeper heartbeat staleness.
//     Run ONE per deployment host next to the keeper(s):
//       ORA_ALERT_WEBHOOK=https://... ORA_KEEPER_HEARTBEATS=/var/run/ora-keeper-0.json \
//         node scripts/watch-invariants.js --watch
//
//   local one-shot: node scripts/watch-invariants.js
//   Base Sepolia:   ORA_RPC_URL=https://sepolia.base.org \
//                   ORA_DEPLOYMENT=app/deployment-baseSepolia.json \
//                   node scripts/watch-invariants.js
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { tcrBand, newAlertBus, heartbeatStatus, isLargeRedemption } = require("./monitor-lib");

const RPC = process.env.ORA_RPC_URL || "http://127.0.0.1:3000/rpc";
const DEP = process.env.ORA_DEPLOYMENT || path.join(__dirname, "..", "app", "deployment.json");
// Watch-mode knobs (one-shot ignores all of these):
const WATCH = process.argv.includes("--watch");
const POLL = Number(process.env.ORA_MONITOR_POLL_SECONDS || 60);
const WEBHOOK = process.env.ORA_ALERT_WEBHOOK || "";
const TCR_WARN = ethers.parseEther(process.env.ORA_TCR_WARN_RATIO || "1.5");
const TCR_CRIT = ethers.parseEther(process.env.ORA_TCR_CRIT_RATIO || "1.25");
const REDEMPTION_ALERT = ethers.parseEther(process.env.ORA_REDEMPTION_ALERT_ORUSD || "100000");
const KEEPER_HBS = (process.env.ORA_KEEPER_HEARTBEATS || process.env.ORA_KEEPER_HEARTBEAT_FILE || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const KEEPER_STALE_MS = Number(process.env.ORA_KEEPER_STALE_SECONDS || 300) * 1000;
const bus = newAlertBus(Number(process.env.ORA_REALERT_MINUTES || 30) * 60 * 1000);

async function alert(text, key, force = false) {
  console.error(`[${new Date().toISOString()}] ALERT: ${text}`);
  if (!WEBHOOK || !bus.shouldFire(key || text, Date.now(), force)) return;
  try {
    await fetch(WEBHOOK, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `[ora-monitor] ${text}` }) });
  } catch (e) { console.error("webhook failed:", e.message); }
}
const E18 = 10n ** 18n;
const f = v => Number(ethers.formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 4 });

let errors = 0, warnings = 0;
const ok = (label, detail) => console.log(`  OK    ${label}${detail ? " — " + detail : ""}`);
const warn = (label, detail) => { warnings++; console.log(`  WARN  ${label}${detail ? " — " + detail : ""}`); };
const err = (label, detail) => { errors++; console.log(`  ERROR ${label}${detail ? " — " + detail : ""}`); };
const gate = (cond, label, detail, soft) =>
  cond ? ok(label, detail) : (soft ? warn(label, detail) : err(label, detail));

async function main() {
  if (!fs.existsSync(DEP)) {
    console.log(`deployment file not found (${DEP}) — nothing to monitor, skipping`);
    return;
  }
  const dep = JSON.parse(fs.readFileSync(DEP));
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
  const A = dep.abis, S = dep.shared;
  const orUSD = new ethers.Contract(S.orUSDToken, A.orUSDToken, provider);

  console.log(`ORA invariant monitor — chainId ${(await provider.getNetwork()).chainId} @ ${RPC}`);
  console.log(`deployment: ${path.basename(DEP)}\n`);

  let totalDebt = 0n;

  for (const [name, B] of Object.entries(dep.branches)) {
    console.log(`[${name}]`);
    const tm = new ethers.Contract(B.troveManager, B.rates ? A.troveManagerRates : A.troveManager, provider);
    const feedAbi = B.rwa ? (A.wtBillPriceFeed || A.priceFeedRWA) : B.native ? A.priceFeed : A.priceFeedWstETH;
    const feed = new ethers.Contract(B.priceFeed, feedAbi, provider);
    const sp = new ethers.Contract(B.stabilityPool,
      B.rates ? A.stabilityPoolRates : B.native ? A.stabilityPool : A.stabilityPoolERC20, provider);

    // 1. price sanity + oracle health
    const price = await feed.getPrice();
    gate(price > 0n, "price > 0", "$" + f(price));
    try { gate(await feed.oracleLive(), "oracle live", null, true); } catch {}
    try { if (feed.interface.getFunction("sequencerUp")) gate(await feed.sequencerUp(), "L2 sequencer up", null, true); } catch {}
    try { if (B.rwa) gate(!(await feed.navShock()), "no NAV shock", null, true); } catch {}

    // 2. solvency: TCR above water
    const nTroves = await tm.getTroveOwnersCount();
    if (nTroves > 0n) {
      const tcr = await tm.getTCR(price);
      gate(tcr > E18, "TCR > 100%", (Number(tcr) / 1e16).toFixed(1) + "%");
    } else { ok("no troves", "TCR undefined"); }

    // 3. collateral custody: book value <= actual pool balances
    const sysColl = await tm.getEntireSystemColl();
    let apBal, dpBal;
    if (B.native) {
      apBal = await provider.getBalance(B.activePool);
      dpBal = await provider.getBalance(B.defaultPool);
    } else {
      const coll = new ethers.Contract(B.collToken, A.mockWstETH, provider);
      apBal = await coll.balanceOf(B.activePool);
      dpBal = await coll.balanceOf(B.defaultPool);
    }
    gate(apBal + dpBal >= sysColl, "collateral custody covers book",
      `book ${f(sysColl)} <= actual ${f(apBal + dpBal)}`);

    // 4. Stability Pool: orUSD balance covers recorded deposits
    const spDeposits = await sp.getTotalLUSDDeposits();
    const spBal = await orUSD.balanceOf(B.stabilityPool);
    gate(spBal >= spDeposits, "SP balance covers deposits", `${f(spBal)} >= ${f(spDeposits)}`);

    const debt = await tm.getEntireSystemDebt();
    totalDebt += debt;

    // 5. branch extras
    if (B.rwa && B.underlyingToken) {
      const wt = new ethers.Contract(B.collToken, A.wtBill, provider);
      const tb = new ethers.Contract(B.underlyingToken, A.mockTBill, provider);
      const bal = await tb.balanceOf(B.collToken);
      const need = (await wt.totalSupply()) * (await wt.rate()) / E18 + (await wt.skimAccrued());
      gate(bal >= need, "wmTBILL custody invariant", `underlying ${f(bal)} >= shares*rate+skim ${f(need)}`);
      const bo = new ethers.Contract(B.borrowerOperations, A.borrowerOperationsERC20, provider);
      gate(debt <= (await bo.debtCap()), "debt under RWA cap", `${f(debt)} <= ${f(await bo.debtCap())}`);
    }
    if (B.rates) {
      const vault = new ethers.Contract(B.sorUSDVault, A.sorUSDVault, provider);
      const vAssets = await vault.totalAssets();
      const vBal = await orUSD.balanceOf(B.sorUSDVault);
      gate(vBal >= vAssets, "vault assets backed 1:1", `${f(vBal)} >= ${f(vAssets)}`);
      const agg = await tm.aggWeightedDebt();
      gate(agg <= debt, "aggWeightedDebt <= system debt (rate <= 100%)", `${f(agg)} <= ${f(debt)}`);
      if (B.swapPool) {
        const pool = new ethers.Contract(B.swapPool, A.oraSwapPool, provider);
        const [rU, rEth] = [await pool.reserveOrUSD(), await pool.reserveETH()];
        const [bU, bEth] = [await orUSD.balanceOf(B.swapPool), await provider.getBalance(B.swapPool)];
        gate(bU >= rU && bEth >= rEth, "AMM reserves backed by balances",
          `orUSD ${f(bU)}>=${f(rU)}, ETH ${f(bEth)}>=${f(rEth)}`);
      }
    }
    console.log();
  }

  // 6. global backing: total branch debt >= orUSD supply, gap = un-accrued interest
  console.log("[global]");
  const supply = await orUSD.totalSupply();
  gate(totalDebt >= supply - 10n ** 16n, "system debt covers orUSD supply",
    `debt ${f(totalDebt)} >= supply ${f(supply)}`);
  const gap = totalDebt > supply ? totalDebt - supply : 0n;
  gate(gap < supply / 100n + 10n ** 18n, "un-minted interest gap < 1% of supply",
    `${f(gap)} orUSD pending accrual`, true);

  console.log(`\n${errors} errors, ${warnings} warnings`);
  if (errors > 0) process.exit(1);
}

// ---------------- realtime watch mode ----------------
// First tick baselines state silently (a restart must not page for the
// status quo); every tick after that alerts on transitions + sustained-bad
// (cooldown re-alerts), and always announces recoveries.
async function watchTick(dep, provider, st) {
  const latest = await provider.getBlockNumber();
  for (const [name, B] of Object.entries(dep.branches)) {
    const tmAbi = B.rates ? dep.abis.troveManagerRates : dep.abis.troveManager;
    const tm = new ethers.Contract(B.troveManager, tmAbi, provider);
    const feedAbi = B.rwa ? (dep.abis.wtBillPriceFeed || dep.abis.priceFeedRWA)
      : B.native ? dep.abis.priceFeed : dep.abis.priceFeedWstETH;
    const feed = new ethers.Contract(B.priceFeed, feedAbi, provider);
    const prev = st.branches[name] || {};
    const cur = {};

    // price + oracle liveness + fallback/shock flags (whatever the feed exposes)
    const price = await feed.getPrice().catch(() => 0n);
    if (price <= 0n) await alert(`${name}: price unreadable/zero`, `${name}:noprice`);
    for (const [field, good, badText] of [
      ["oracleLive", true, "ORACLE OUTAGE"],
      ["usingFallback", false, "primary oracle broken — FALLBACK serving"],
      ["depegged", false, "stETH DEPEG circuit breaker active"],
      ["navShock", false, "mTBILL NAV SHOCK flagged"],
      ["sequencerUp", true, "L2 sequencer DOWN (guard freezing prices)"],
    ]) {
      try {
        if (!feed.interface.getFunction(field)) continue;
        cur[field] = await feed[field]();
        if (prev[field] !== undefined && cur[field] !== prev[field]) {
          const bad = cur[field] !== good;
          await alert(`${name}: ${field} -> ${cur[field]}${bad ? ` — ${badText}` : " (recovered)"}`,
            `${name}:${field}:${cur[field]}`, !bad);
        } else if (prev[field] === undefined && cur[field] !== good) {
          console.log(`[${name}] baselined ${field}=${cur[field]} (already bad — one-shot cron covers it)`);
        }
      } catch {}
    }

    // TCR bands (edge-triggered; insolvent re-alerts on cooldown)
    try {
      if ((await tm.getTroveOwnersCount()) > 0n) {
        const tcr = await tm.getTCR(price > 0n ? price : 1n);
        cur.tcrBand = tcrBand(tcr, TCR_WARN, TCR_CRIT);
        const pct = (Number(tcr) / 1e16).toFixed(1);
        if (prev.tcrBand && cur.tcrBand !== prev.tcrBand) {
          const rec = cur.tcrBand === "ok";
          await alert(`${name}: TCR ${prev.tcrBand} -> ${cur.tcrBand} (${pct}%)${rec ? " (recovered)" : ""}`,
            `${name}:tcr:${cur.tcrBand}`, rec);
        } else if (!prev.tcrBand && cur.tcrBand !== "ok") {
          console.log(`[${name}] baselined TCR ${pct}% (${cur.tcrBand})`);
        } else if (cur.tcrBand === "insolvent" || cur.tcrBand === "crit") {
          await alert(`${name}: TCR still ${cur.tcrBand} (${pct}%)`, `${name}:tcr:${cur.tcrBand}`);
        }
      }
    } catch (e) { await alert(`${name}: TCR read failed (${String(e.shortMessage || e.message).slice(0, 80)})`, `${name}:tcr:read`); }

    // redemptions since the last tick (alert only the large ones)
    try {
      const from = st.lastBlock ? st.lastBlock + 1 : latest;
      if (from <= latest) {
        const evs = await tm.queryFilter(tm.filters.Redemption(), from, latest);
        for (const ev of evs) {
          const [attempted, actual, ethSent] = ev.args;
          const line = `${name}: redemption ${ethers.formatEther(actual)} orUSD -> ${ethers.formatEther(ethSent)} ETH`;
          if (isLargeRedemption(actual, REDEMPTION_ALERT)) await alert(`LARGE ${line} (>= ${ethers.formatEther(REDEMPTION_ALERT)})`, `${name}:redemption:${ev.transactionHash}`);
          else console.log(`  ${line}`);
        }
      }
    } catch (e) { console.error(`[${name}] redemption poll failed:`, String(e.shortMessage || e.message).slice(0, 100)); }

    st.branches[name] = { ...prev, ...cur };
  }
  st.lastBlock = latest;

  // keeper heartbeats (same-host files the keeper writes every scan)
  if (!KEEPER_HBS.length) {
    if (!st.warnedNoHb) { st.warnedNoHb = true; console.log("no ORA_KEEPER_HEARTBEATS set — keeper-failure coverage OFF"); }
  }
  for (const hb of KEEPER_HBS) {
    const s = heartbeatStatus(fs, hb, KEEPER_STALE_MS);
    if (s.missing) await alert(`keeper heartbeat ${hb}: ${s.reason} — keeper down or never started?`, `keeper:missing:${hb}`);
    else if (s.stale) await alert(`keeper heartbeat ${hb} stale (${Math.round(s.ageMs / 1000)}s > ${Math.round(KEEPER_STALE_MS / 1000)}s) — keeper stalled?`, `keeper:stale:${hb}`);
  }
}

async function watch() {
  if (!fs.existsSync(DEP)) { console.log(`deployment file not found (${DEP}) — nothing to monitor`); return; }
  const dep = JSON.parse(fs.readFileSync(DEP));
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
  console.log(`ORA realtime monitor — ${path.basename(DEP)} @ ${RPC} (every ${POLL}s; webhook ${WEBHOOK ? "ON" : "OFF — alerts go to stderr only"})`);
  const st = { branches: {}, lastBlock: 0 };
  for (;;) {
    const t0 = Date.now();
    try { await watchTick(dep, provider, st); }
    catch (e) { await alert(`monitor tick failed: ${String(e.shortMessage || e.message).slice(0, 160)}`, "monitor:tick"); }
    await new Promise(r => setTimeout(r, Math.max(0, POLL * 1000 - (Date.now() - t0))));
  }
}

if (require.main === module) {
  (WATCH ? watch() : main()).catch(e => { console.error("MONITOR FAILED:", e.shortMessage || e.message); process.exit(1); });
}
