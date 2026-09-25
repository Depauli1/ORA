// Pure per-branch selectors over a BranchCfg. The ICR/MCR math decides what
// the user sees as "safe to borrow" — kept side-effect-free and unit tested.
import type { BranchCfg } from "./config";

export const isNativeBranch = (b: BranchCfg): boolean => !!b.native;
export const isRWABranch = (b: BranchCfg): boolean => !!b.rwa;
export const isRatesBranch = (b: BranchCfg): boolean => !!b.rates;
export const collSymOf = (b: BranchCfg): string => b.collSymbol;
export const faucetAmtOf = (b: BranchCfg): string => b.faucetAmount || "10";

// Per-branch risk params (from deployment.json): the RWA T-bill branch runs
// MCR 105% / CCR 115% with a [103%, 105%) soft-liq band; others 110%/150%.
export const brMcrOf = (b: BranchCfg): number => Number(b.mcr) || 1.1;
export const brSoftOf = (b: BranchCfg): number => Number(b.softFloor) || 1.05;

// ICR in percent from raw collateral/debt at a USD price (all human units).
export function icrPct(coll: number, debt: number, price: number): number {
  if (!(debt > 0)) return 0;
  return ((coll * price) / debt) * 100;
}

// Preview math for the open-trove form (mirrors updateOpenPreview).
export function openPreview(coll: number, borrow: number, feeRate: bigint, price: number): {
  fee: number;
  totalDebt: number;
  icr: number;
} {
  const fee = (borrow * Number(feeRate)) / 1e18;
  const totalDebt = borrow + fee + 200; // +200 orUSD gas compensation
  const icr = totalDebt > 0 ? ((coll * price) / totalDebt) * 100 : 0;
  return { fee, totalDebt, icr };
}
