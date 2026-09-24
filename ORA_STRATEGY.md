# ORA Protocol — Strategy & Roadmap

**ORA is a decentralized, interest-free borrowing protocol issuing orUSD, a hard-pegged USD stablecoin — built on Liquity's battle-tested engine, evolved for the 2026 market, and aimed at the two fronts where incumbents are weakest: yield-native collateral and emerging-market demand.**

---

## 1. Market Reality Check (why a plain fork loses)

| Competitor | Their edge | Their weakness |
|---|---|---|
| Liquity v2 (BOLD) | User-set interest rates, LST collateral | Complex UX; rates confuse retail borrowers |
| crvUSD | Soft liquidations (LLAMMA) | Tied to Curve ecosystem politics |
| Aave GHO | Distribution via Aave | Governance-heavy, rate set by DAO |
| MakerDAO/Sky USDS | RWA yield, scale | Centralization drift, opaque governance |
| Dead Liquity forks (dozens) | None | No differentiation — pure copy = zero moat |

**Conclusion:** we don't win by copying. We win by *sequencing* four edges on top of a proven engine, each phase funding and de-risking the next.

## 2. The Four Edges — Phased, Not Simultaneous

### Phase 0 — Foundation (NOW)
- Rebrand core: **orUSD** stablecoin, **ORA** utility/staking token.
- Modernize the stack: new Hardhat toolchain, local testnet, new ORA frontend.
- Keep Liquity v1 mechanics untouched at first — they are audited, formally analyzed, and survived 5+ years including multiple >50% ETH drawdowns. **Security is the first marketing feature.**
- Deliverable: working testnet MVP (this repo).

### Phase 1 — Yield-Bearing Collateral (the wedge)
- Accept **wstETH / weETH** alongside ETH. Collateral earns staking yield *while* backing an interest-free loan → effective negative borrowing cost. This is the single strongest retail pitch in DeFi lending.
- Implementation: collateral branches (one TroveManager/ActivePool/StabilityPool set per collateral, à la Liquity v2), oracle adapters with LST/LRT rate feeds + depeg circuit breakers.
- KPI: $10M TVL on one L2, orUSD peg within ±0.5%.

### Phase 2 — Better Mechanics (the moat)
- **Soft liquidation buffer**: partial liquidations below MCR before full liquidation (kinder than v1's all-or-nothing, simpler than LLAMMA).
- **User-set interest rates + sorUSD** (SHIPPED as the ETH v2 branch): Liquity-v2-style
  rate-ordered redemptions and a savings vault fed by borrower interest — the protocol's
  own economic engine.
- **Dynamic redemption fee decay** tuned for L2 block times.
- **ORA staking = real yield**: 100% of borrow + redemption fees to stakers (no emissions dependence).
- KPI: lower liquidation losses per $ of TVL than Liquity v2 over a 30-day volatile window.

### Phase 3 — Emerging-Market Distribution (the market nobody's fighting for)
- Target Ghana / Nigeria / Kenya: high inflation (GHS, NGN), high mobile-money penetration, real demand for dollar savings and credit.
- Product: dead-simple mobile-first app — "save in dollars, borrow against your crypto" — orUSD on a cheap L2 (Base), on/off-ramps via local PSP partners (mobile money ↔ orUSD).
- Frontend-operator kickback model (inherited from Liquity) becomes an *agent network*: local operators earn ORA for onboarding users.
- KPI: 10k active wallets in West Africa; orUSD/mobile-money corridor live.

### Phase 4 — Multi-Collateral + RWA (the endgame)
- Tokenized T-bills (e.g., tokenized money-market funds) as an isolated collateral branch → deepens orUSD backing and lets the protocol earn RWA yield.
- Strict isolation: an RWA branch failure can never contaminate crypto branches.
- KPI: orUSD supply > $100M, ≥3 collateral branches.

## 3. Tokenomics

- **orUSD** — the stablecoin. Mint by borrowing against collateral (min 110% ICR). Hard peg: $1 redemption floor + minting ceiling arbitrage.
- **ORA** (100M fixed supply) — captures protocol revenue:
  - Stake ORA → earn 100% of borrowing + redemption fees (real yield, in ETH/LST + orUSD).
  - Community issuance (32%) streams to Stability Pool depositors and agent-network operators
    (32M to the ETH-branch pool at token creation, plus 2M reallocated from treasury to the
    wstETH/mTBILL/ETH-v2 branch pools — caps locked at activation; 34M streamed in total).
  - **Interest economics (rates engine)**: borrowers on rates branches pay a self-chosen
    annual rate, minted continuously as orUSD — 80% to sorUSD savers, 20% to the treasury.
    This is protocol revenue that never depends on emissions.
  - No governance theater at launch: minimal, immutable core; parameters per collateral branch set at branch deployment.
    All contract ownership renounced during wiring; the one remaining admin power (the orUSD branch registrar)
    is renounced on production deploys via `ORA_RENOUNCE_REGISTRAR=1`.
  - Verified on-chain: `npx hardhat run scripts/verify-tokenomics.js` checks every claim above
    against the deployment (47/47 with the registrar renounced).

## 4. Why We Can Win

1. **Engine credibility** — Liquity v1 core: audited, formally verified properties, 5 years unbroken on mainnet.
2. **A pitch retail understands** — "your collateral pays YOU to borrow" (Phase 1).
3. **A market incumbents ignore** — African dollar-demand distribution (Phase 3) is a distribution moat, not a code moat. Code gets forked; agent networks don't.
4. **Real-yield token** — ORA accrues fees from day one, not emissions.

## 5. This Repo — What's Done / Next

- [x] Fork of Liquity `dev` monorepo (engine + SDK + reference frontend)
- [x] Token rebrand in contracts: `orUSD`, `ORA`
- [x] `ora-mvp/`: modern Hardhat toolchain (Node 22), compiles the 0.6.11 core untouched
- [x] Local testnet deployment script (full 14-contract wiring)
- [x] New ORA web app: open Troves, mint orUSD, Stability Pool, liquidation demo
- [x] **Phase 1: collateral branches** — multi-branch orUSD (`registerBranch`), full
      ERC20-collateral pool suite (`ora-mvp/contracts/branches/`), wstETH branch live
      on the local testnet with the ETH branch; `TroveManager` bytecode reused
      unchanged across branches; end-to-end smoke test incl. cross-branch orUSD
      fungibility and wstETH liquidations
- [x] Base Sepolia deployment kit (`ora-mvp/DEPLOY_BASE_SEPOLIA.md`) — one-command
      deploy from any open-internet machine (Arena sandbox blocks public RPCs)
- [x] **Phase 1.5: real oracle adapters** — `ChainlinkPriceFeed` (ETH/USD) and
      `WstETHPriceFeed` (ETH/USD x stETH/ETH x wstETH rate) with depeg circuit
      breaker at 0.96, 1.0 rate cap, staleness fallback to lastGoodPrice; on
      Base Sepolia the ETH branch reads the live Chainlink ETH/USD feed
- [x] **Phase 1.5: public face** — frontend network switcher (Local / Base
      Sepolia) with MetaMask signing (auto chain add/switch), oracle status
      badge, and a depeg-simulator that trips the on-chain circuit breaker
- [x] **Phase 2: per-branch tokenomics** — `BranchStaking` (stake ORA, earn the
      wstETH branch's borrow fees in orUSD + redemption fees in wstETH) and
      `BranchCommunityIssuance` (1M ORA from treasury, same yearly-halving curve,
      cap locked at activation) paying ORA to wstETH Stability Pool depositors
- [x] **Phase 2: soft liquidations** — `TroveManagerV2` on the wstETH branch adds
      `liquidatePartial`: troves in the soft band [105%, 110%) are partially
      offset against the SP at a 3% premium (vs ~10% full-liq penalty), restored
      to exactly 110% and kept open; 0.5% of seized collateral to the caller;
      normal mode only, remainder must stay a valid trove; ETH branch keeps the
      audited v1 TroveManager
- [x] **Phase 4: RWA branch (mTBILL)** — third collateral branch backed by a
      tokenized T-bill fund share (`MockTBill`, non-rebasing, NAV-accruing like
      OUSG/BUIDL); `RWAPriceFeed` NAV oracle with +2%/update upside clamp
      (manipulation-proof ratchet), sticky break-the-buck shock flag (>2% below
      the high-water mark) and 72h staleness fallback; **strict isolation
      enforced twice** — structurally (own pools/SP/TroveManager per branch)
      and economically (2,000,000 orUSD branch debt cap in
      `BorrowerOperationsERC20.setDebtCap`, checked on every mint); Phase 2
      stack reused (TroveManagerV2 soft-liqs, BranchStaking, 500k ORA
      issuance); ≥3 collateral branches KPI now live on testnet
- [x] **Rates engine (ETH v2 branch)** — Liquity-v2-style user-set interest rates
      as a fourth branch on the same orUSD: borrowers choose 0.5–100%/yr
      (`TroveManagerRates`), the sorted list is keyed by rate
      (`SortedTrovesRates`), and **redemptions hit the cheapest borrowers
      first** — paying more is redemption protection; partial redemptions never
      reorder the list (no hints needed). Interest accrues lazily per trove,
      is minted to an `InterestRouter` and split 80/20 between the **sorUSD
      savings vault** (ERC-4626-style, dead-shares protected) and the treasury.
      No origination fee (continuous interest replaces it); 7-day rate-adjust
      cooldown blocks redemption-dodging; ETH-v2 SP gets 500k ORA issuance.
      Verified on-chain: accrual math (~150k @3.5% × 30d = 432 orUSD), 80/20
      routing, share-price appreciation, rate-ordered redemption picking the
      0.6%-rate trove over a lower-ICR 9% trove, system-debt invariant to
      sub-dust precision, normal-mode liquidation incl. accrued interest
- [ ] Audit diff vs. upstream Liquity (kept deliberately small: 4 rebrand lines +
      ~40 lines multi-branch orUSD; branch pool suite is new isolated code)

> Legacy note: the original `packages/*` toolchain (Node 14–16, Docker/OpenEthereum) is kept for reference and upstream diffing; active development happens in `ora-mvp/` against the same contracts. Internal contract identifiers retain upstream names (LUSDToken, LQTYToken…) to keep the security-relevant diff vs. audited Liquity minimal — only user-facing name/symbol changed.
