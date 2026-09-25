# ORA — Audit Diff vs. Upstream Liquity v1

**Purpose**: tell an auditor exactly what to read. ORA deliberately keeps the
audited, formally verified Liquity v1 engine byte-identical wherever possible;
every deviation is enumerated here with its size and risk class.

**Baseline**: pristine upstream at repo commit `39f1f7f` (unmodified Liquity
dev monorepo, `packages/contracts/contracts`). **Methodology**: per-file
whitespace-insensitive line diff (`diff` after stripping spaces/tabs; counts
are added + removed lines, including mechanical renames). Regenerate with the
commands in *Appendix A*.

---

## Tier 0 — byte-identical to the audited core (zero diff)

Verified **0 changed lines** vs. upstream: `TroveManager.sol`,
`StabilityPool.sol`, `ActivePool.sol`,
`DefaultPool.sol`, `CollSurplusPool.sol`, `SortedTroves.sol`,
`HintHelpers.sol`, `MultiTroveGetter.sol`, `GasPool.sol`, all of
`Dependencies/`, and the whole LQTY suite except the 2 files below
(`CommunityIssuance`, `LQTYStaking`, `LockupContract`,
`LockupContractFactory`: 0 diff).

The ETH branch (branch 1) runs on Tier 0 code except its BorrowerOperations'
27-line guardian pause (Tier 1, additive only).

## Tier 1 — modified audited code (101 lines total, review word-by-word)

| File | Δ lines | What changed | Risk notes |
|---|---|---|---|
| `LUSDToken.sol` | 70 | (a) rebrand strings (name/symbol → orUSD); (b) **multi-branch mint registry**: `isTroveManager`/`isBorrowerOperations` mappings, `registerBranch()` gated by a `branchRegistrar` (deployer; renounceable via `renounceBranchRegistrar`), mint gate widened to BO-or-TroveManager (rates branch mints interest from the TM) | This is THE security-critical diff: it controls who may mint orUSD. Registrar must be renounced in production (`ORA_RENOUNCE_REGISTRAR=1`, checked by `verify-tokenomics.js`) |
| `LQTY/LQTYToken.sol` | 4 | rebrand strings only (name/symbol → ORA) | cosmetic |
| `BorrowerOperations.sol` | 27 | **guardian borrowing pause**: `guardian` (one-shot `setGuardian`, `checkContract`-gated), `_requireBorrowingNotPaused()` in `openTrove` + debt-increasing `adjustTrove`; fail-open when unwired | purely additive (0 removed lines); pause blocks new debt only — repay/close/liquidate unaffected |

Internal identifiers and revert strings intentionally retain upstream names
(`LUSD:`, `LQTY:`…) to keep this tier minimal.

## Tier 2 — forks of audited code (read as: upstream + a delta)

Each file is a textual copy of its base with a bounded change set. Review the
delta, not the file.

| File | Base | Δ lines | Delta content |
|---|---|---|---|
| `branches/BorrowerOperationsERC20.sol` | BorrowerOperations | ≈141 | native ETH → ERC20 collateral (`msg.value` → `transferFrom`), `setCollToken`, **debt cap** (`setDebtCap`, checked on every mint) |
| `branches/ActivePoolERC20.sol` | ActivePool | 90 | ERC20 custody + `ICollateralReceiver` push pattern |
| `branches/CollSurplusPoolERC20.sol` | CollSurplusPool | 66 | ERC20 custody |
| `branches/DefaultPoolERC20.sol` | DefaultPool | 64 | ERC20 custody |
| `branches/StabilityPoolERC20.sol` | StabilityPool | 52 | ERC20 collateral gains |
| `branches/TroveManagerV2.sol` | TroveManager | ≈474 | **soft liquidations**: `liquidatePartial()` in the band [`SOFT_LIQ_FLOOR`, MCR), premium 103%, restores ICR to exactly MCR, remainder must stay a valid trove, SP must absorb fully |
| `rates/TroveManagerRates.sol` | TroveManager | ≈602 | **rates engine**: per-trove `troveAnnualRate` (0.5–100%), lazy `accrueTroveInterest` minted to `InterestRouter`, 7-day rate cooldown, `aggWeightedDebt`, redemption fee → treasury, zero borrow fee |
| `rates/BorrowerOperationsRates.sol` | BorrowerOperations | ≈98 | `openTroveWithRate`, `adjustTroveRate`, no origination fee, list keyed by rate |
| `rates/SortedTrovesRates.sol` | SortedTroves | 58 | comparator key: NICR → `troveAnnualRate` (descending; cheapest redeemed first) |
| `rates/StabilityPoolRates.sol` | StabilityPool | 32 | wiring for the rates TM |
| `rwa/TroveManagerRWA.sol` | TroveManagerV2 | **8** | constants only: MCR 1.05e18, CCR 1.15e18, soft floor 103e16 (via `LiquityBaseRWA`). Batch-exit diff is byte-identical to V2's, so this delta is unchanged |
| `rwa/BorrowerOperationsRWA.sol` | BorrowerOperationsERC20 | **8** | constants-only rebase onto `LiquityBaseRWA` (guardian block identical to ERC20's, so this delta is unchanged) |
| `rwa/StabilityPoolRWA.sol` | StabilityPoolERC20 | **8** | constants-only rebase |
| `rwa/HintHelpersRWA.sol` | HintHelpers | 14 | constants-only rebase |
| `rwa/LiquityBaseRWA.sol` | Dependencies/LiquityBase | 10 | MCR/CCR constants (Solidity 0.6 cannot override constants — hence textual forks) |

`≈` deltas = the pre-existing upstream delta plus this branch's purely
additive change (guardian: +27/+28 per BO; batch externalization: +44/−335
per TM, byte-identical across the three forks). Regenerate exact numbers
with Appendix A against the upstream archive.

**Compilers**: Tier 0/1/2 stay on Solidity 0.6.11 (the audited toolchain).
All Tier 3 code compiles under Solidity 0.8.24 (dual-compiler Hardhat
build), with identical selectors, storage layout, events, and revert
strings to the 0.6 code it replaces; SafeMath becomes native checked
arithmetic (`.sub(x, msg)` underflow reverts become panic 0x11). The only
cross-version file is `Interfaces/IOraGuardian.sol` (floating pragma,
valid under both compilers).

## Tier 3 — wholly new ORA code (highest review priority, ~2,240 lines, Solidity 0.8.24)

| File | Lines | Function | Key invariants (tested) |
|---|---|---|---|
| `rwa/WTBill.sol` | 162 | wmTBILL yield-share wrapper, 2%/yr linear skim to treasury | custody: `balanceOf(wrapper) == totalSupply×rate/1e18 + skimAccrued` (fuzzed); rate monotonically ↓, never 0 |
| `rwa/WTBillPriceFeed.sol` | 57 | composite NAV × wrapper rate; proxies clamp/shock/staleness | price == navFeed × rate exactly |
| `rates/SorUSDVault.sol` | 123 | ERC-4626-style savings vault | dead-shares (1000 → 0xdEaD) on first deposit; share price never manipulable down |
| `rates/InterestRouter.sol` | 56 | 80/20 interest split | split is exact; one-shot wiring |
| `rates/HintHelpersRates.sol` | 63 | rate-keyed hints | view-only |
| `zap/LeverZap.sol` | 225 | per-user leverage proxy (open loop / flash-loan-free unwind / `exec` escape hatch) | owner-gated; closes fully or reverts atomically; sweeps everything to owner |
| `zap/OraSwapPool.sol` | 83 | demo x·y=k AMM, 0.3% fee (**testnet-only venue**) | k never decreases (fuzzed); no LP withdrawal path by design |
| `branches/BranchStaking.sol` | 241 | per-branch ORA staking (ERC20 fee gains) | fee accounting mirrors LQTYStaking |
| `branches/BranchCommunityIssuance.sol` | 87 | per-branch capped ORA issuance | cap locked at `activate()` |
| `oracles/ChainlinkPriceFeed.sol` | 140 | Chainlink adapter w/ staleness fallback + **L2 sequencer guard** | constructor reverts on invalid/stale feed or sequencer outage |
| `oracles/PythFallbackAggregator.sol` | 80 | Pyth→AggregatorV3 adapter: the Chainlink feed's live fallback source (two-source confirm) | any-expo→8-dec scaling; zero/negative ⇒ answer 0; updatedAt=publishTime (feed heartbeat governs); ctor probe rejects unpublished/bad ids |
| `oracles/SequencerGuard.sol` | 57 | Chainlink L2 sequencer-uptime check (answer 0=up, 1h restart grace), optional via address(0) | outage/grace ⇒ oracle down, lastGoodPrice served |
| `oracles/WstETHPriceFeed.sol` | 172 | ETH/USD × stETH/ETH × wstETH rate; **depeg circuit breaker** <0.96; **per-feed heartbeats** + sequencer guard | breaker sticky until peg recovers; either feed stale ⇒ fallback |
| `oracles/RWAPriceFeed.sol` | 112 | NAV oracle: **+2%/fetch upside ratchet**, break-the-buck shock flag, 72h staleness | ratchet cannot be bypassed by the view path |
| `oracles/SettableAggregator.sol` | 59 | testnet mock feed | testnet only |
| Mocks (`MockWstETH`, `MockTBill`) | 117 | testnet collateral faucets | testnet only |
| `guardian/OraGuardian.sol` (+`Interfaces/IOraGuardian.sol`) | 68 + 12 | per-branch borrowing pause: multisig holder, per-BO expiry ≤30d, one-shot wiring | pause/unpause/expiry/rotation/branch-isolation (10 tests); no other powers |
| `keeper/BatchLiquidator.sol` | 119 | external batch liquidations (the TM forks implement singles only) | skip-on-failure = in-protocol batch semantics; holds no funds; head-walk caches `next` |
| `dependencies08/` (7 files) | 205 | 0.8 twins of the 0.6 interfaces/deps Tier 3 needs (`IERC20`, `IPriceFeed`, `AggregatorV3Interface`, `ILQTYStaking`, `OraMath`, `OraOwnable`, `OraCheckContract`) | identical selectors/events; `_decPow` cap 525600000 preserved |

## Known accepted deviations / debt

1. **Contract size**: resolved by externalizing batch liquidations. The
   three TM forks implement single-trove `liquidate()` only (~21.1KB each,
   `runs:1`); sequencing moved to the 0.8 `keeper/BatchLiquidator.sol`
   (revert-stubs preserve `ITroveManager`). CI enforces a 22KB size gate
   (`scripts/check-sizes.js`; the frozen upstream TM is exempt, capped at
   23.5KB) and per-release gas snapshots (`gas-snapshot.json`, >10%
   regression fails). Attempts to shrink via linked libraries were measured
   and reverted (call marshalling ate the savings).
2. **Revert strings** keep upstream prefixes (`LUSD:`, `TroveManager:`) — by
   design, to minimize Tier 1.
3. **OraSwapPool** is a demo venue: no LP shares, seeded once. A public
   mainnet deploy replaces it with a real DEX route in `LeverZap`.
4. **LeverZap unwind** is iterative (≤20 steps, 112% safety line) and can
   revert (never strand funds) if an unwind step can't hold ICR; `exec()` is
   the owner escape hatch. Production path: flash-loan unwind.
5. `aggWeightedDebt` is a display aggregate; subtraction guards absorb dust.
6. **Slither triage** (CI gates on high severity in Tier 3): the 3 high
   findings it caught (unchecked `transfer` returns in `BranchStaking`,
   inherited from the upstream staking pattern) are FIXED with `require`,
   as is the unchecked compensation `transfer` in `BatchLiquidator`.
   Remaining medium findings are accepted patterns: `divide-before-multiply`
   precision (bounded, 1e18-scaled), vault/wrapper strict `== 0` supply checks
   (standard first-deposit branch), and `reentrancy-no-eth` after
   `transferFrom` of trusted protocol tokens (orUSD/mTBILL revert-on-failure,
   no callbacks). Intentional ETH sends (swap payout, owner sweep, `exec`,
   keeper compensation forward, permissionless dust sweep) carry inline
   `slither-disable` comments with justifications.

## Verification pointers

- `npm test` — 167 tests incl. fuzz + invariant-driver mirrors + 6 jsdom UI smoke tests (custody, k-invariant, accrual math, zap round trips, sequencer outage/grace, per-feed staleness, guardian pause matrix, standalone + batch liquidations, oracle policy, keeper sharding, monitor logic)
- `forge test` — stateful invariant campaigns (wmTBILL custody/skim, sorUSD price/backing; 256 runs × depth 24, `fail_on_revert`)
- `scripts/watch-invariants.js` — live-deployment invariant monitor (solvency, custody, SP/vault/AMM backing, debt↔supply), 60s realtime watch + 6h CI cron backstop on Base Sepolia
- `scripts/verify-tokenomics.js` — 47 on-chain claims (registrar renounce = prod)
- `scripts/test-rwa-zap.js`, `scripts/smoke.js` — integration on a seeded chain
- CI: `.github/workflows/ci.yml` — 7 jobs: Hardhat suite (incl. 22KB contract-size gate + >10% gas-snapshot regression check) + Slither (gate: no high-severity in Tier 3; audited upstream filtered, full report informational) + Foundry invariants + oracle prod-config gate (fails single-source prod) + Base Sepolia fork reads + keeper scan load test + Tier-3 coverage gate (≥85%)

---

### Appendix A — regenerate the numbers

```bash
git archive 39f1f7f packages/contracts/contracts | tar -x -C /tmp/upstream
dd() { diff <(tr -d ' \t' < "$1") <(tr -d ' \t' < "$2") | grep -c '^[<>]'; }
dd /tmp/upstream/packages/contracts/contracts/LUSDToken.sol ora-mvp/contracts/LUSDToken.sol
# ...per the tables above
```
