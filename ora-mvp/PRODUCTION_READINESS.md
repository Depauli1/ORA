# ORA Production Readiness

Tracked gap analysis vs. the bar set by Aave/Chainlink-class protocols.
Status: ✅ closed · 🟡 partially closed (remainder documented) · ❌ open
(requires resources outside this repo: audits, funds, third-party accounts).

| Layer | Status | Where we are | Remaining gap to "Aave-grade" |
|---|---|---|---|
| Core engine | ✅ | Audited Liquity v1, byte-identical (AUDIT_DIFF Tier 0); 74 changed lines total in Tier 1 | — |
| New contracts | 🟡 | 71-test suite incl. fuzz; Slither CI gate (0 high); AUDIT_DIFF.md for auditors | **External audits + bug bounty** — budget item, not a code item |
| Testing | ✅ | 71 unit/fuzz tests, ~35-check invariant watcher, integration scripts, jsdom UI e2e, all in CI | Foundry-style long-run invariant campaigns are a nice-to-have |
| Oracles | ✅ | L2 sequencer guard (1h grace), per-feed heartbeats, **50% deviation guard**, **two-source confirmation + fallback feed**, upside ratchet + shock flag (RWA), depeg breaker (wstETH) | Real second source on mainnet (API3/Pyth adapter address) — config, not code |
| AMM / leverage venue | 🟡 | **Aggregate oracle-anchored slippage guard** on the zap (total equity-loss cap, atomic revert); demo AMM clearly scoped testnet-only | Mainnet: route via Aerodrome/Uniswap + flash-loan unwind (needs a live DEX; interface is isolated in `IPool`) |
| Key management | 🟡 | No admin keys post-deploy (all ownership renounced, registrar renounce verified); testnet deployer = throwaway faucet key; `DEPLOYER_KEY` secret override | Mainnet: Safe multisig deploy ceremony (documented in INCIDENT_RUNBOOK.md) — needs real signers |
| Frontend | 🟡 | **Pre-flight simulation** (decoded revert before signing, zero gas), **EIP-6963 multi-wallet**, **error tracking** (`/log` ring buffer), **CSP + security headers** | WalletConnect relay (needs owner's project ID), TypeScript migration, IPFS pinning (needs a pinning account) |
| Infra | ✅ | **Liquidation keeper bot** (soft-liq aware, staticCall pre-flight, watch mode), **invariant monitor on a 6h CI cron + auto-issue alerting**, **incident runbook** (8 scenarios) | Subgraph/indexer for rich analytics; Tenderly/Defender if third-party SaaS is acceptable |
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
3. **Base Sepolia deployer funding** — `0xbC8aFFCE0B146B9e82fa7D8C7d0d40D1443Cd131`
   (the entire deploy+monitor pipeline is armed and waiting).
