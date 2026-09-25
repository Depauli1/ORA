# ORA Production Readiness

Tracked gap analysis vs. the bar set by Aave/Chainlink-class protocols.
Status: ✅ closed · 🟡 partially closed (remainder documented) · ❌ open
(requires resources outside this repo: audits, funds, third-party accounts).

| Layer | Status | Where we are | Remaining gap to "Aave-grade" |
|---|---|---|---|
| Core engine | ✅ | Audited Liquity v1 core (AUDIT_DIFF Tier 0; 101 additive lines in Tier 1, incl. the 27-line guardian pause in BorrowerOperations) | — |
| New contracts | 🟡 | 172-test suite incl. fuzz; Slither CI gate (0 high in Tier 3 — audited upstream + test contracts filtered, full report informational); 22KB size gate; gas-snapshot regressions gated; all Tier 3 on Solidity 0.8.24; AUDIT_DIFF.md for auditors | **External audits + bug bounty** — budget item, not a code item (scope: Tier 1–3 incl. guardian + BatchLiquidator) |
| Testing | ✅ | 172-test Hardhat suite (unit + fuzz + fork reads + 8 deploy-pipeline checks), 74-test vitest frontend suite (server + UI) + two Playwright e2e tests, ~35-check invariant watcher, Foundry invariant campaigns (256 runs × 6144 calls), integration scripts, gas snapshots, all in CI | Thousand-run overnight invariant campaigns are a nice-to-have |
| Oracles | ✅ | L2 sequencer guard (1h grace), per-feed heartbeats, **50% deviation guard**, **two-source confirmation + live Pyth fallback adapter** (per-asset policy file, prod single-source fails CI), upside ratchet + shock flag (RWA), depeg breaker (wstETH) | Production Pyth feed ids + endpoint (config in `oracle-policy.json`, not code) |
| AMM / leverage venue | 🟡 | **Aggregate oracle-anchored slippage guard** on the zap (total equity-loss cap, atomic revert); demo AMM clearly scoped testnet-only | Mainnet: route via Aerodrome/Uniswap + flash-loan unwind (needs a live DEX; interface is isolated in `IPool`) |
| Key management | 🟡 | Secrets-only testnet deploys (`DEPLOYER_KEY` Actions secret; the old committed throwaway key is abandoned, never refilled); registrar renounce verified; sole post-deploy privilege is the pause-only, auto-expiring guardian multisig | Mainnet: Safe-held guardian at construction (ORA_GUARDIAN) + bundle-generated multisig ceremony (scripts/safe-batch.js + runbook); deploys ship verified (verify-deployment.js), nonce-replayable (check-addresses.js), with per-release manifest diffs — needs real signers |
| Frontend | 🟡 | **Pre-flight simulation** (decoded revert before signing, zero gas), **EIP-6963 multi-wallet**, **error tracking** (`/log` ring buffer), **CSP + security headers**, focused Borrow/Earn/Markets sections, oracle/NAV risk banners + stale-data lockout, persistent transaction activity with explorer links | WalletConnect relay (needs owner's project ID), IPFS pinning (needs a pinning account), independent usability/accessibility review |
| Infra | ✅ | **Keeper bot** (soft-liq aware, pre-flight, gas escalation + fee cap, crash alerting, Prometheus metrics, **overlap-free N-operator sharding**, load-tested scan) + **BatchLiquidator** sweeps; **realtime monitor** (60s watch: TCR bands, fallback flips, shock flags, large redemptions, keeper heartbeats; webhook alerting) with the 6h CI cron + auto-issue as backstop; **incident runbook** (8 scenarios + keeper/monitor/SaaS ops) | Subgraph/indexer for rich analytics; owner-provisioned webhook + RPC endpoints (account steps in INCIDENT_RUNBOOK.md) |
| Process | ✅ | 7-job CI on every push (suite + Slither + Foundry + oracle-config + fork reads + keeper load + coverage), PR-documented phases, audit-diff doc, runbooks | Second human reviewer :) |

## Verified end-to-end (local chain)
- Market crash −25% (two-source confirmed past the deviation guard) → keeper
  executed 3 full liquidations + 2 soft-liquidations (restored to exactly
  105%) → invariant watcher: **0 errors, 0 warnings** afterwards.
- Doomed transaction → rejected in pre-flight simulation with the decoded
  protocol reason, 0 blocks mined, 0 gas spent.
- Sequencer halt → oracles freeze to lastGoodPrice; restart honors the 1h
  grace; recovery accepts fresh prices.

## The three ❌→🟡 items that need YOU (not code)
1. **Audits + bounty** — the single biggest remaining risk. 2 independent
   audits of Tier 1–3 (AUDIT_DIFF.md) before any mainnet talk.
2. **WalletConnect Cloud project ID** — free registration; I wire it in.
3. **Base Sepolia `DEPLOYER_KEY` secret + funding** — generate with
   `node ora-mvp/scripts/gen-deployer.js`, store as the `DEPLOYER_KEY`
   Actions secret, fund from a faucet (the entire deploy+monitor pipeline
   is armed and waiting). The previously committed throwaway deployer
   (`0xbC8aFFCE0B146B9e82fa7D8C7d0d40D1443Cd131`) is ABANDONED — it touched
   git history and must be treated as public; never fund it.
