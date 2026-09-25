// Pure display/math helpers: fund-critical number formatting (debts,
// ratios, shortfalls) must never silently change.
import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { fmt, fmtUsd, short, icrClass, rebrand, reason } from "../src/format";
import {
  isNativeBranch, isRWABranch, isRatesBranch, brMcrOf, brSoftOf,
  icrPct, openPreview, collSymOf, faucetAmtOf,
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
});
