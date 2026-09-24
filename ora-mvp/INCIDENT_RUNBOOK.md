# ORA Incident Runbook

Who does what when something breaks. Alerts arrive from the **invariant
monitor** (`monitor.yml` — opens/updates a GitHub issue with the failing
checks) and from **client error tracking** (`GET /log` on the app server).

**First response to ANY alert (5 minutes):**
```bash
node scripts/watch-invariants.js                         # local
ORA_RPC_URL=https://sepolia.base.org ORA_DEPLOYMENT=app/deployment-baseSepolia.json \
  node scripts/watch-invariants.js                       # testnet
```
The watcher pinpoints the violated invariant. Then follow the matching
scenario below. The protocol has **no admin keys after deployment** — every
response is a *permissionless* action (anyone can run it) or a *communication*
action. That is by design: there is nothing to compromise, and nothing that
needs a 3am key ceremony.

---

## S1 — Oracle down (`oracle live` WARN)

**Meaning**: the branch price feed is serving `lastGoodPrice` because the
primary source is broken/stale, deviated >50% unconfirmed, or the sequencer
guard is active. Borrowing/liquidation continue at the last good price.

1. Diagnose which layer: `feed.sequencerUp()`, `feed.usingFallback()`,
   aggregator `latestRoundData()` age vs heartbeat.
2. Primary stale but fallback healthy → nothing to do; the feed auto-recovers
   (`usingFallback` flips back when the primary returns).
3. Both sources down > heartbeat: prices are frozen. Communicate; liquidations
   at stale prices remain fair by construction (`lastGoodPrice`), but new
   borrowing against a falling market is the risk to warn about.
4. Never attempt to "fix" prices by other means: the deviation guard exists
   precisely so no single actor (including us) can move them.

## S2 — L2 sequencer outage (`L2 sequencer up` WARN)

1. Confirm on the official status page (status.base.org) — the guard reads
   Chainlink's uptime feed, which can itself lag.
2. During the outage: no one can transact anyway (the chain isn't sequencing);
   the guard's job happens at RESTART — it enforces a 1h grace so stale
   Chainlink rounds can't be exploited before feeds catch up.
3. After restart + grace: run the keeper (`node scripts/bots/liquidator.js`)
   — positions that became unhealthy during the freeze must be cleared first.

## S3 — TCR below 100% / branch insolvency (`TCR > 100%` ERROR)

Worst case. The branch's collateral is worth less than its debt.

1. Run the keeper immediately — every liquidatable trove must be absorbed
   while the Stability Pool still has deposits.
2. Check SP depth (`SP balance covers deposits`): if the SP empties,
   liquidations redistribute to remaining troves (Liquity mechanism) — the
   branch keeps operating; orUSD holders arbitrage via redemptions.
3. Isolation check: verify OTHER branches' TCRs are unaffected (they must be —
   pools/SP/TroveManager are per-branch; the only shared object is orUSD).
4. Communicate honestly: which branch, what backing ratio, what redemption
   yields.

## S4 — NAV shock / RWA break-the-buck (`no NAV shock` WARN)

1. `navShock` is sticky and informational: the T-bill fund printed >2% below
   its high-water mark. Prices already reflect the marked-down NAV.
2. Run the keeper: bait-band troves get soft-liquidated (restored to 105%),
   deep ones fully liquidated. The 2M orUSD debt cap bounds total exposure.
3. If the underlying fund is actually impaired (not an oracle error): the
   branch winds down naturally — debt cap prevents growth, redemptions and
   liquidations shrink it.

## S5 — stETH depeg (`depegged` breaker)

Collateral is priced at the REAL (lower) market rate — conservative by
construction. Run the keeper for troves pushed under 110%; communicate that
pricing follows the market rate, capped at 1.0.

## S6 — wmTBILL custody invariant ERROR

`balance < shares×rate + skimAccrued` would mean wrapper insolvency — this
must never happen (fuzzed + monitored). If it fires: treat as a critical bug,
freeze communications on the RWA branch (borrowing there prices via the
wrapper), open a security issue, and engage the audit contact. Do NOT call
`claimSkim` (it would pay out of user collateral).

## S7 — AMM/vault backing ERROR

`SorUSDVault` or `OraSwapPool` balances below book: critical bug path, same
handling as S6. The vault holds savers' orUSD; the demo AMM is isolated from
protocol accounting (worst case: LP funds only).

## S8 — Monitor itself failing (MONITOR FAILED)

Usually RPC flakiness. Re-run with a different `ORA_RPC_URL`. If the
deployment file is missing on a fresh branch checkout, the monitor skips by
design.

---

## Keeper operations

```bash
node scripts/bots/liquidator.js            # one-shot scan, all branches
node scripts/bots/liquidator.js --watch    # continuous (ORA_POLL_SECONDS=30)
ORA_KEEPER_KEY=0x... ORA_RPC_URL=... ORA_DEPLOYMENT=... node scripts/bots/liquidator.js --watch
```
The keeper prefers `liquidatePartial` inside the soft band (gentler for the
borrower, 0.5% caller reward), falls back to full liquidation, and simulates
every call before spending gas.

## Key management posture

- **Testnet**: throwaway deployer key, committed by necessity (CI has no
  secret access); it holds faucet ETH only. Owner can override with a
  `DEPLOYER_KEY` Actions secret at any time.
- **Production**: deploy from a Safe multisig, renounce the branch registrar
  (`ORA_RENOUNCE_REGISTRAR=1`) in the same ceremony, verify with
  `verify-tokenomics.js` (47/47 requires the renounce). After that there are
  NO privileged keys — the runbook above never needs one.
