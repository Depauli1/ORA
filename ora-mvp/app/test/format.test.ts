// Pure display/math helpers: fund-critical number formatting (debts,
// ratios, shortfalls) must never silently change.
import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { fmt, fmtUsd, short, icrClass, rebrand, reason, mapTransactionError } from "../src/format";
import {
  isNativeBranch, isRWABranch, isRatesBranch, brMcrOf, brSoftOf,
  icrPct, openPreview, adjustmentPreviews, healthTier, healthMeterPct, healthExplanation, collSymOf, faucetAmtOf,
} from "../src/branch";
import type { BranchCfg } from "../src/config";

const ethBranch = (over: Partial<BranchCfg> = {}): BranchCfg => ({
  collSymbol: "ETH",
  priceFeed: "0x1", troveManager: "0x2", borrowerOperations: "0x3",
  activePool: "0x4", stabilityPool: "0x5", gasPool: "0x6", defaultPool: "0x7",
  collSurplusPool: "0x8", sortedTroves: "0x9", hintHelpers: "0xa",
  multiTroveGetter: "0xb", communityIssuance: "0xc",
  ...over,
});

describe("format", () => {
  it("fmt renders ether values with grouping + decimals", () => {
    expect(fmt(ethers.parseEther("1234.5"))).toBe("1,234.5");
    expect(fmt(ethers.parseEther("4000"), 0)).toBe("4,000");
    expect(fmt(0n)).toBe("0");
    expect(fmtUsd(ethers.parseEther("2000"))).toBe("$2,000");
  });

  it("short truncates addresses with ellipsis", () => {
    expect(short("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toBe("0x7099…79C8");
  });

  it("icrClass tiers around the branch MCR", () => {
    expect(icrClass(105, 110)).toBe("bad"); // below MCR+10
    expect(icrClass(125, 110)).toBe("warn"); // MCR+10 .. MCR+40
    expect(icrClass(200, 110)).toBe("good");
    // RWA branch (MCR 105): 118% is warn there, bad on a 110% branch
    expect(icrClass(118, 105)).toBe("warn");
    expect(icrClass(118, 110)).toBe("bad");
  });

  it("rebrand translates upstream revert identifiers", () => {
    expect(rebrand("LUSD: decreased debt below min")).toBe("orUSD: decreased debt below min");
    expect(rebrand("LQTYStaking: nothing to claim")).toBe("ORAStaking: nothing to claim");
    expect(rebrand(42)).toBe("42");
  });

  it("reason prefers decoded revert strings, capped at 140 chars", () => {
    expect(reason({ shortMessage: "LUSD: boom" })).toBe("orUSD: boom");
    expect(reason({ info: { error: { message: "reverted with reason string 'LUSD: x'" } } })).toBe("orUSD: x");
    expect(reason(new Error("plain"))).toBe("plain");
    expect(reason("x".repeat(500)).length).toBe(140);
  });

  it("maps wallet, balance, network and contract failures to clear next steps", () => {
    const rejected = mapTransactionError({ code: 4001, message: "User rejected the request" });
    expect(rejected.code).toBe("USER_REJECTED");
    expect(rejected.message).toMatch(/rejected this request/);
    expect(rejected.recovery).toMatch(/review the action/i);

    const funds = mapTransactionError({ code: "INSUFFICIENT_FUNDS", message: "insufficient funds" });
    expect(funds.code).toBe("INSUFFICIENT_GAS_BALANCE");
    expect(funds.message).toMatch(/estimated gas/);

    const network = mapTransactionError(new Error("request timeout"));
    expect(network.code).toBe("NETWORK_UNAVAILABLE");
    expect(network.recovery).toMatch(/selected network/i);

    const reverted = mapTransactionError({
      code: "CALL_EXCEPTION",
      info: { error: { message: "reverted with reason string 'LUSD: below MCR'" } },
    });
    expect(reverted.code).toBe("PROTOCOL_REJECTED");
    expect(reverted.message).toBe("orUSD: below MCR");
    expect(reverted.technical).toContain("CALL_EXCEPTION");
  });
});

describe("branch selectors", () => {
  it("branch kind flags", () => {
    expect(isNativeBranch(ethBranch({ native: true }))).toBe(true);
    expect(isNativeBranch(ethBranch({}))).toBe(false);
    expect(isRWABranch(ethBranch({ rwa: true }))).toBe(true);
    expect(isRatesBranch(ethBranch({ rates: true }))).toBe(true);
    expect(collSymOf(ethBranch({ collSymbol: "wstETH" }))).toBe("wstETH");
    expect(faucetAmtOf(ethBranch({}))).toBe("10");
    expect(faucetAmtOf(ethBranch({ faucetAmount: "10000" }))).toBe("10000");
  });

  it("risk params default to 110%/105%, RWA overrides", () => {
    expect(brMcrOf(ethBranch({}))).toBe(1.1);
    expect(brSoftOf(ethBranch({}))).toBe(1.05);
    expect(brMcrOf(ethBranch({ mcr: 1.05, softFloor: 1.03 }))).toBe(1.05);
    expect(brSoftOf(ethBranch({ mcr: 1.05, softFloor: 1.03 }))).toBe(1.03);
  });

  it("classifies projected health with the branch MCR and safe buffer", () => {
    expect(healthTier(109.9, 1.1)).toBe("critical");
    expect(healthTier(150, 1.1)).toBe("caution");
    expect(healthTier(164.9, 1.1)).toBe("caution");
    expect(healthTier(165, 1.1)).toBe("safe");
    expect(healthTier(0, 1.1)).toBe("critical");
    expect(healthTier(Number.NaN, 1.1)).toBe("unknown");
    expect(healthMeterPct(165, 1.1)).toBe(100);
    expect(healthMeterPct(110, 1.1)).toBeCloseTo(66.6667, 3);
    expect(healthExplanation("caution", 130, 1.1, 1000, 2000)).toMatch(/collateral-price decline/);
  });

  it("icrPct guards zero debt", () => {
    expect(icrPct(5, 4000, 2000)).toBeCloseTo(250, 6);
    expect(icrPct(5, 0, 2000)).toBe(0);
  });

  it("openPreview matches the form math (fee + 200 gas comp)", () => {
    const p = openPreview(5, 4000, 5n * 10n ** 15n, 2000);
    expect(p.fee).toBeCloseTo(20, 6); // 0.5% of 4000
    expect(p.totalDebt).toBeCloseTo(4220, 6);
    expect(p.icr).toBeCloseTo((5 * 2000) / 4220 * 100, 6);
    expect(openPreview(0, 0, 0n, 0).icr).toBe(0);
  });

  it("previews collateral/debt adjustments and blocks actions that breach MCR", () => {
    const p = adjustmentPreviews(4, 3000, 0.5, 1000, 0.01, false, 1.1);
    expect(p.add.collateral).toBe(4.5);
    expect(p.withdraw.collateral).toBe(3.5);
    expect(p.borrow.debt).toBeCloseTo(3000.505, 6);
    expect(p.repay.debt).toBe(2999.5);
    expect(p.withdraw.healthSafe).toBe(true);

    const risky = adjustmentPreviews(2, 2500, 0.1, 1000, 0.01, false, 1.1);
    expect(risky.withdraw.executable).toBe(false);
    expect(risky.borrow.executable).toBe(false);
    // Adding collateral and repaying remain available even if they don't
    // immediately restore the position above MCR.
    expect(risky.add.executable).toBe(true);
    expect(risky.repay.executable).toBe(true);
    expect(risky.repay.healthSafe).toBe(false);
  });

  it("does not add an upfront fee to projected debt on the rates branch", () => {
    const p = adjustmentPreviews(4, 3000, 100, 1000, 0.05, true, 1.1);
    expect(p.borrow.debt).toBe(3100);
  });
});
