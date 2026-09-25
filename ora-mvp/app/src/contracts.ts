// Contract wiring + off-chain hint pipeline. Reads deployment state,
// builds the per-branch contract map, computes near-exact insert positions
// so mainnet-sized lists don't burn ruinous gas on zero hints.
import { ethers } from "ethers";
import { Z } from "./config";
import { state, dep, bcfg, provider, myAddr, req } from "./state";
import { isRatesBranch } from "./branch";

export function connectContracts(): void {
  const runner = state.wallet ?? provider();
  const B = bcfg();
  const S = dep().shared;
  const A = dep().abis;
  const C = state.C;
  C.priceFeed = new ethers.Contract(
    B.priceFeed, B.native ? A.priceFeed : (B.rwa ? A.priceFeedRWA : A.priceFeedWstETH), runner);
  C.aggNav = B.navAggregator
    ? new ethers.Contract(B.navAggregator, A.settableAggregator, runner) : null;
  C.aggEth = B.ethUsdSettable
    ? new ethers.Contract(req(B.ethUsdAggregator, "ethUsdAggregator"), A.settableAggregator, runner) : null;
  C.aggRate = B.stEthEthAggregator
    ? new ethers.Contract(B.stEthEthAggregator, A.settableAggregator, runner) : null;
  C.aggSeq = dep().shared && dep().shared.sequencerSettable && dep().shared.sequencerUptimeFeed !== Z
    ? new ethers.Contract(req(dep().shared.sequencerUptimeFeed, "sequencerUptimeFeed"), A.settableAggregator, runner) : null;
  C.aggEthFb = dep().shared && dep().shared.ethUsdFallbackSettable && dep().shared.ethUsdFallbackAggregator !== Z
    ? new ethers.Contract(req(dep().shared.ethUsdFallbackAggregator, "ethUsdFallbackAggregator"), A.settableAggregator, runner) : null;
  C.troveManager = new ethers.Contract(
    B.troveManager, B.rates ? A.troveManagerRates
      : B.native ? A.troveManager : (A.troveManagerV2 || A.troveManager), runner);
  C.borrowerOps = new ethers.Contract(
    B.borrowerOperations, B.rates ? A.borrowerOperationsRates
      : B.native ? A.borrowerOperations : A.borrowerOperationsERC20, runner);
  C.stabilityPool = new ethers.Contract(
    B.stabilityPool, B.rates ? A.stabilityPoolRates
      : B.native ? A.stabilityPool : A.stabilityPoolERC20, runner);
  C.multiGetter = new ethers.Contract(B.multiTroveGetter, A.multiTroveGetter, runner);
  C.sortedTroves = new ethers.Contract(B.sortedTroves, A.sortedTroves, runner);
  C.hintHelpers = new ethers.Contract(B.hintHelpers, B.rates ? A.hintHelpersRates : A.hintHelpers, runner);
  // Rates engine extras (ETH v2 branch)
  C.vault = B.sorUSDVault ? new ethers.Contract(B.sorUSDVault, A.sorUSDVault, runner) : null;
  C.router = B.interestRouter ? new ethers.Contract(B.interestRouter, A.interestRouter, runner) : null;
  C.zapFactory = B.leverZapFactory && A.leverZapFactory
    ? new ethers.Contract(B.leverZapFactory, A.leverZapFactory, runner) : null;
  C.swapPool = B.swapPool && A.oraSwapPool
    ? new ethers.Contract(B.swapPool, A.oraSwapPool, runner) : null;
  C.collToken = B.native ? null
    : new ethers.Contract(req(B.collToken, "collToken"), B.rwa ? A.mockTBill : A.mockWstETH, runner);
  C.orUSD = new ethers.Contract(S.orUSDToken, A.orUSDToken, runner);
  C.ora = new ethers.Contract(S.oraToken, A.oraToken, runner);
  // Phase 2: each branch has its own staking pool — ETH branch uses the classic
  // LQTYStaking (native ETH gains), other branches use BranchStaking (ERC20 gains).
  C.branchStakingMode = !B.native && !!B.branchStaking;
  C.staking = C.branchStakingMode
    ? new ethers.Contract(req(B.branchStaking, "branchStaking"), A.branchStaking, runner)
    : new ethers.Contract(S.oraStaking, A.oraStaking, runner);
}

// With address(0) hints SortedTroves walks the whole list on-chain — fine
// with 10 troves, ruinous gas with thousands. Compute a near-exact insert
// position off-chain first (free view calls), as mainnet frontends must.
export async function getInsertHints(newColl: bigint, newDebt: bigint): Promise<[string, string]> {
  const { C } = state;
  try {
    if (newDebt <= 0n || newColl <= 0n) return [Z, Z];
    const nicr = (newColl * 10n ** 20n) / newDebt; // NICR is 1e20-scaled
    const size = await C.sortedTroves.getSize();
    if (size <= 1n) return [Z, Z];
    const trials = BigInt(Math.min(15 * Math.ceil(Math.sqrt(Number(size))), 3000));
    const [approx] = await C.hintHelpers.getApproxHint(nicr, trials, 42n);
    const pos = await C.sortedTroves.findInsertPosition(nicr, approx, approx);
    return [pos[0], pos[1]];
  } catch (e) {
    console.warn("hint computation failed, falling back to zero hints", e);
    return [Z, Z]; // contracts still succeed, just cost more gas
  }
}

// Rates branch: the sorted list is keyed by annual interest rate.
export async function rateInsertHints(rateWei: bigint): Promise<[string, string]> {
  const { C } = state;
  try {
    const size = await C.sortedTroves.getSize();
    if (size <= 1n) return [Z, Z];
    const trials = BigInt(Math.min(15 * Math.ceil(Math.sqrt(Number(size))), 3000));
    const [approx] = await C.hintHelpers.getApproxHint(rateWei, trials, 42n);
    const pos = await C.sortedTroves.findInsertPosition(rateWei, approx, approx);
    return [pos[0], pos[1]];
  } catch (e) {
    console.warn("rate hint computation failed, falling back to zero hints", e);
    return [Z, Z];
  }
}

// Hints for adjusting the caller's existing trove by (dColl, dDebt) deltas.
export async function adjustHints(dColl: bigint, dDebt: bigint): Promise<[string, string]> {
  // Rates branch: adjustments don't change the rate, so the trove never moves
  // in the list — no hints needed at all.
  if (isRatesBranch(bcfg())) return [Z, Z];
  const e = await state.C.troveManager.getEntireDebtAndColl(myAddr());
  return getInsertHints(e[1] + dColl, e[0] + dDebt);
}

// Net debt increase for a borrow: amount + borrowing fee (with decay).
export async function borrowWithFee(amount: bigint): Promise<bigint> {
  const rate = await state.C.troveManager.getBorrowingRateWithDecay();
  return amount + (amount * rate) / 10n ** 18n;
}

// Leverage Zapper (rates branch): per-user proxy owns the leveraged trove.
export async function myZap(): Promise<ethers.Contract | null> {
  const { C } = state;
  if (!C.zapFactory || !state.wallet) return null;
  const addr = await C.zapFactory.zapOf(myAddr());
  if (addr === Z) return null;
  return new ethers.Contract(addr, dep().abis.leverZap, state.wallet);
}
