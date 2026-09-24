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
`BorrowerOperations.sol`, `StabilityPool.sol`, `ActivePool.sol`,
`DefaultPool.sol`, `CollSurplusPool.sol`, `SortedTroves.sol`,
`HintHelpers.sol`, `MultiTroveGetter.sol`, `GasPool.sol`, all of
`Dependencies/`, and the whole LQTY suite except the 2 files below
(`CommunityIssuance`, `LQTYStaking`, `LockupContract`,
`LockupContractFactory`: 0 diff).

The ETH branch (branch 1) runs **entirely** on Tier 0 code.

## Tier 1 — modified audited code (74 lines total, review word-by-word)

| File | Δ lines | What changed | Risk notes |
|---|---|---|---|
| `LUSDToken.sol` | 70 | (a) rebrand strings (name/symbol → orUSD); (b) **multi-branch mint registry**: `isTroveManager`/`isBorrowerOperations` mappings, `registerBranch()` gated by a `branchRegistrar` (deployer; renounceable via `renounceBranchRegistrar`), mint gate widened to BO-or-TroveManager (rates branch mints interest from the TM) | This is THE security-critical diff: it controls who may mint orUSD. Registrar must be renounced in production (`ORA_RENOUNCE_REGISTRAR=1`, checked by `verify-tokenomics.js`) |
| `LQTY/LQTYToken.sol` | 4 | rebrand strings only (name/symbol → ORA) | cosmetic |

Internal identifiers and revert strings intentionally retain upstream names
(`LUSD:`, `LQTY:`…) to keep this tier minimal.

## Tier 2 — forks of audited code (read as: upstream + a delta)

Each file is a textual copy of its base with a bounded change set. Review the
delta, not the file.

| File | Base | Δ lines | Delta content |
|---|---|---|---|
| `branches/BorrowerOperationsERC20.sol` | BorrowerOperations | 113 | native ETH → ERC20 collateral (`msg.value` → `transferFrom`), `setCollToken`, **debt cap** (`setDebtCap`, checked on every mint) |
| `branches/ActivePoolERC20.sol` | ActivePool | 90 | ERC20 custody + `ICollateralReceiver` push pattern |
| `branches/CollSurplusPoolERC20.sol` | CollSurplusPool | 66 | ERC20 custody |
| `branches/DefaultPoolERC20.sol` | DefaultPool | 64 | ERC20 custody |
| `branches/StabilityPoolERC20.sol` | StabilityPool | 52 | ERC20 collateral gains |
| `branches/TroveManagerV2.sol` | TroveManager | 95 | **soft liquidations**: `liquidatePartial()` in the band [`SOFT_LIQ_FLOOR`, MCR), premium 103%, restores ICR to exactly MCR, remainder must stay a valid trove, SP must absorb fully |
| `rates/TroveManagerRates.sol` | TroveManager | 223 | **rates engine**: per-trove `troveAnnualRate` (0.5–100%), lazy `accrueTroveInterest` minted to `InterestRouter`, 7-day rate cooldown, `aggWeightedDebt`, redemption fee → treasury, zero borrow fee |
| `rates/BorrowerOperationsRates.sol` | BorrowerOperations | 71 | `openTroveWithRate`, `adjustTroveRate`, no origination fee, list keyed by rate |
| `rates/SortedTrovesRates.sol` | SortedTroves | 58 | comparator key: NICR → `troveAnnualRate` (descending; cheapest redeemed first) |
| `rates/StabilityPoolRates.sol` | StabilityPool | 32 | wiring for the rates TM |
| `rwa/TroveManagerRWA.sol` | TroveManagerV2 | **8** | constants only: MCR 1.05e18, CCR 1.15e18, soft floor 103e16 (via `LiquityBaseRWA`) |
| `rwa/BorrowerOperationsRWA.sol` | BorrowerOperationsERC20 | **8** | constants-only rebase onto `LiquityBaseRWA` |
| `rwa/StabilityPoolRWA.sol` | StabilityPoolERC20 | **8** | constants-only rebase |
| `rwa/HintHelpersRWA.sol` | HintHelpers | 14 | constants-only rebase |
| `rwa/LiquityBaseRWA.sol` | Dependencies/LiquityBase | 10 | MCR/CCR constants (Solidity 0.6 cannot override constants — hence textual forks) |

## Tier 3 — wholly new ORA code (highest review priority, ~1,500 lines)

| File | Lines | Function | Key invariants (tested) |
|---|---|---|---|
| `rwa/WTBill.sol` | 167 | wmTBILL yield-share wrapper, 2%/yr linear skim to treasury | custody: `balanceOf(wrapper) == totalSupply×rate/1e18 + skimAccrued` (fuzzed); rate monotonically ↓, never 0 |
| `rwa/WTBillPriceFeed.sol` | 59 | composite NAV × wrapper rate; proxies clamp/shock/staleness | price == navFeed × rate exactly |
| `rates/SorUSDVault.sol` | 126 | ERC-4626-style savings vault | dead-shares (1000 → 0xdEaD) on first deposit; share price never manipulable down |
| `rates/InterestRouter.sol` | 59 | 80/20 interest split | split is exact; one-shot wiring |
| `rates/HintHelpersRates.sol` | 63 | rate-keyed hints | view-only |
| `zap/LeverZap.sol` | 195 | per-user leverage proxy (open loop / flash-loan-free unwind / `exec` escape hatch) | owner-gated; closes fully or reverts atomically; sweeps everything to owner |
| `zap/OraSwapPool.sol` | 83 | demo x·y=k AMM, 0.3% fee (**testnet-only venue**) | k never decreases (fuzzed); no LP withdrawal path by design |
| `branches/BranchStaking.sol` | 262 | per-branch ORA staking (ERC20 fee gains) | fee accounting mirrors LQTYStaking |
| `branches/BranchCommunityIssuance.sol` | 91 | per-branch capped ORA issuance | cap locked at `activate()` |
| `oracles/ChainlinkPriceFeed.sol` (+Reader) | 108 | Chainlink adapter w/ staleness fallback | constructor reverts on invalid/stale feed |
| `oracles/WstETHPriceFeed.sol` | 142 | ETH/USD × stETH/ETH × wstETH rate; **depeg circuit breaker** <0.96 | breaker is sticky until peg recovers |
| `oracles/RWAPriceFeed.sol` | 113 | NAV oracle: **+2%/fetch upside ratchet**, break-the-buck shock flag, 72h staleness | ratchet cannot be bypassed by the view path |
| `oracles/SettableAggregator.sol` | 59 | testnet mock feed | testnet only |
| Mocks (`MockWstETH`, `MockTBill`) | ~90 | testnet collateral faucets | testnet only |

## Known accepted deviations / debt

1. **Contract size**: `TroveManagerV2/Rates/RWA` are 24,480–24,499 bytes with
   `optimizer runs:1` — bytes under EIP-170. No further logic may be added;
   production path is a library/external-logic split.
2. **Revert strings** keep upstream prefixes (`LUSD:`, `TroveManager:`) — by
   design, to minimize Tier 1.
3. **OraSwapPool** is a demo venue: no LP shares, seeded once. A public
   mainnet deploy replaces it with a real DEX route in `LeverZap`.
4. **LeverZap unwind** is iterative (≤20 steps, 112% safety line) and can
   revert (never strand funds) if an unwind step can't hold ICR; `exec()` is
   the owner escape hatch. Production path: flash-loan unwind.
5. `aggWeightedDebt` is a display aggregate; subtraction guards absorb dust.

## Verification pointers

- `npm test` — 56 tests incl. fuzz (custody, k-invariant, accrual math, zap round trips)
- `scripts/verify-tokenomics.js` — 47 on-chain claims (registrar renounce = prod)
- `scripts/test-rwa-zap.js`, `scripts/smoke.js` — integration on a seeded chain
- CI: `.github/workflows/ci.yml` — test suite + Slither (gate: no high-severity in Tier 3)

---

### Appendix A — regenerate the numbers

```bash
git archive 39f1f7f packages/contracts/contracts | tar -x -C /tmp/upstream
dd() { diff <(tr -d ' \t' < "$1") <(tr -d ' \t' < "$2") | grep -c '^[<>]'; }
dd /tmp/upstream/packages/contracts/contracts/LUSDToken.sol ora-mvp/contracts/LUSDToken.sol
# ...per the tables above
```
