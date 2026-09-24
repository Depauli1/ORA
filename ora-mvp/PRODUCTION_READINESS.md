# ORA Production Readiness

Tracked gap analysis vs. the bar set by Aave/Chainlink-class protocols.
Status: ✅ closed · 🟡 partially closed (remainder documented) · ❌ open
(requires resources outside this repo: audits, funds, third-party accounts).

| Layer | Status | Where we are | Remaining gap to "Aave-grade" |
|---|---|---|---|
| Core engine | ✅ | Audited Liquity v1 core (AUDIT_DIFF Tier 0; 101 additive lines in Tier 1, incl. the 27-line guardian pause in BorrowerOperations) | — |
| New contracts | 🟡 | 88-test suite incl. fuzz; Slither CI gate (0 high); 22KB size gate; gas-snapshot regressions gated; all Tier 3 on Solidity 0.8.24; AUDIT_DIFF.md for auditors | **External audits + bug bounty** — budget item, not a code item (scope: Tier 1–3 incl. guardian + BatchLiquidator) |
| Testing | ✅ | 88 unit/fuzz tests, ~35-check invariant watcher, integration scripts, jsdom UI e2e, gas snapshots, all in CI | Foundry-style long-run invariant campaigns are a nice-to-have |
| Oracles | ✅ | L2 sequencer guard (1h grace), per-feed heartbeats, **50% deviation guard**, **two-source confirmation + fallback feed**, upside ratchet + shock flag (RWA), depeg breaker (wstETH) | Real second source on mainnet (API3/Pyth adapter address) — config, not code |
| AMM / leverage venue | 🟡 | **Aggregate oracle-anchored slippage guard** on the zap (total equity-loss cap, atomic revert); demo AMM clearly scoped testnet-only | Mainnet: route via Aerodrome/Uniswap + flash-loan unwind (needs a live DEX; interface is isolated in `IPool`) |
| Key management | 🟡 | Secrets-only testnet deploys (`DEPLOYER_KEY` Actions secret; the old committed throwaway key is abandoned, never refilled); registrar renounce verified; sole post-deploy privilege is the pause-only, auto-expiring guardian multisig | Mainnet: Safe multisig deploy + guardian-holder ceremony (documented in INCIDENT_RUNBOOK.md) — needs real signers |
| Frontend | 🟡 | **Pre-flight simulation** (decoded revert before signing, zero gas), **EIP-6963 multi-wallet**, **error tracking** (`/log` ring buffer), **CSP + security headers** | WalletConnect relay (needs owner's project ID), TypeScript migration, IPFS pinning (needs a pinning account) |
| Infra | ✅ | **Liquidation keeper bot** (soft-liq aware, staticCall pre-flight, watch mode) + on-chain **BatchLiquidator** sweeps, **invariant monitor on a 6h CI cron + auto-issue alerting**, **incident runbook** (8 scenarios + guardian ops) | Subgraph/indexer for rich analytics; Tenderly/Defender if third-party SaaS is acceptable |
| Process | ✅ | CI on every push (tests + Slither gate), PR-documented phases, audit-diff doc, runbooks | Second human reviewer :) |

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
