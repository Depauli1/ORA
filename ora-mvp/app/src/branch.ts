// Pure per-branch selectors over a BranchCfg. The ICR/MCR math decides what
// the user sees as "safe to borrow" — kept side-effect-free and unit tested.
import { fmtNum, fmtPct } from "./format";
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

export type HealthTier = "safe" | "caution" | "critical" | "unknown";

/** Safe means a meaningful buffer above MCR; caution is above MCR but within 1.5× it. */
export function healthTier(icr: number, mcr = 1.1): HealthTier {
  if (!Number.isFinite(icr) || icr < 0 || !(mcr > 0)) return "unknown";
  if (icr < mcr * 100) return "critical";
  if (icr < mcr * 150) return "caution";
  return "safe";
}

/** Progress is scaled from zero to 1.5× MCR, leaving the protocol threshold visible. */
export function healthMeterPct(icr: number, mcr = 1.1): number {
  if (!Number.isFinite(icr) || icr <= 0 || !(mcr > 0)) return 0;
  return Math.max(0, Math.min(100, (icr / (mcr * 150)) * 100));
}

export function healthExplanation(
  tier: HealthTier,
  icr: number,
  mcr: number,
  liquidationPrice: number,
  marketPrice: number,
): string {
  if (tier === "unknown") return "Waiting for a valid collateral price and position amounts.";
  if (tier === "critical") {
    return `Below the ${fmtPct(mcr * 100, 0)} minimum collateral ratio. Do not borrow more or withdraw collateral.`;
  }
  const buffer = marketPrice > 0 && liquidationPrice > 0
    ? Math.max(0, ((marketPrice - liquidationPrice) / marketPrice) * 100)
    : 0;
  const distance = Number.isFinite(buffer) ? fmtNum(buffer, 1) : "0.0";
  return tier === "caution"
    ? `Only about ${distance}% collateral-price decline to the liquidation threshold. Consider adding collateral or borrowing less.`
    : `Healthy buffer: about ${distance}% collateral-price decline to the liquidation threshold. Keep monitoring market conditions.`;
}

// Preview math for the open-trove form (mirrors updateOpenPreview).
export function openPreview(
  coll: number,
  borrow: number,
  feeRate: bigint,
  price: number,
  mcr = 1.1,
): {
  fee: number;
  totalDebt: number;
  icr: number;
  liquidationPrice: number;
  risk: HealthTier;
} {
  const fee = (borrow * Number(feeRate)) / 1e18;
  const totalDebt = borrow + fee + 200; // +200 orUSD gas compensation
  const icr = totalDebt > 0 && price > 0 ? ((coll * price) / totalDebt) * 100 : 0;
  const liquidationPrice = coll > 0 ? (totalDebt * mcr) / coll : 0;
  return { fee, totalDebt, icr, liquidationPrice, risk: healthTier(icr, mcr) };
}

export interface AdjustmentProjection {
  collateral: number;
  debt: number;
  icr: number;
  liquidationPrice: number;
  risk: HealthTier;
  executable: boolean;
  healthSafe: boolean;
  reason: string;
}

/**
 * Estimate the user's health after each available Trove adjustment.
 * Debt values include the protocol's 200 orUSD gas compensation.
 */
export function adjustmentPreviews(
  collateral: number,
  debt: number,
  amount: number,
  price: number,
  feeRate: number,
  ratesBranch: boolean,
  mcr: number,
  minNetDebt = 1800,
): Record<"add" | "withdraw" | "borrow" | "repay", AdjustmentProjection> {
  const evaluate = (nextCollateral: number, nextDebt: number, action: string): AdjustmentProjection => {
    const icr = nextDebt > 0 && price > 0 ? (nextCollateral * price / nextDebt) * 100 : 0;
    const liquidationPrice = nextCollateral > 0 ? nextDebt * mcr / nextCollateral : 0;
    const healthSafe = icr >= mcr * 100;
    const risk = healthTier(icr, mcr);
    let reason = "Projected health after this action.";
    let executable = amount > 0 && Number.isFinite(amount) && price > 0;
    if (!(amount > 0) || !Number.isFinite(amount)) {
      reason = "Enter an amount greater than zero.";
      executable = false;
    } else if (!(price > 0)) {
      reason = "Waiting for a valid market price.";
      executable = false;
    } else if (!(nextCollateral > 0) || !(nextDebt > 0)) {
      reason = "This amount would leave the Trove with no collateral or debt.";
      executable = false;
    } else if (action === "repay" && nextDebt < minNetDebt + 200) {
      reason = `Would leave less than the ${fmtNum(Number(minNetDebt))} orUSD minimum net debt; close the Trove instead.`;
      executable = false;
    } else if ((action === "withdraw" || action === "borrow") && !healthSafe) {
      reason = `Would leave the Trove below the ${fmtPct(mcr * 100, 0)} minimum collateral ratio.`;
      executable = false;
    } else if (!healthSafe) {
      reason = `This improves the Trove, but it would remain below the ${fmtPct(mcr * 100, 0)} minimum ratio.`;
    }
    return { collateral: nextCollateral, debt: nextDebt, icr, liquidationPrice, risk, executable, healthSafe, reason };
  };

  const borrowFee = ratesBranch ? 0 : amount * Math.max(0, feeRate);
  return {
    add: evaluate(collateral + amount, debt, "add"),
    withdraw: evaluate(collateral - amount, debt, "withdraw"),
    borrow: evaluate(collateral, debt + amount + borrowFee, "borrow"),
    repay: evaluate(collateral, debt - amount, "repay"),
  };
}
