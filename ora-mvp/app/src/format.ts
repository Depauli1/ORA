// Pure display + message helpers. No state, no DOM — exhaustively unit
// tested (these format fund-critical numbers: debts, ratios, shortfalls).
import { ethers } from "ethers";

export const fmt = (v: bigint, d = 2): string =>
  Number(ethers.formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: d });

export const fmtUsd = (v: bigint, d = 2): string => "$" + fmt(v, d);

export const short = (a: string): string => a.slice(0, 6) + "…" + a.slice(-4);

// ICR health class. Takes the branch MCR explicitly so the tiers stay pure;
// callers pass brMcrOf(branch) * 100.
export const icrClass = (icr: number, mcrPct: number): string =>
  icr < mcrPct + 10 ? "bad" : icr < mcrPct + 40 ? "warn" : "good";

// Contracts keep upstream Liquity identifiers verbatim (audit-diff stays
// minimal), so on-chain revert strings say LUSD/LQTY — translate any message
// to ORA branding before a user ever sees it.
export function rebrand(s: unknown): string {
  return String(s)
    .replace(/LUSD/g, "orUSD")
    .replace(/LQTY/g, "ORA")
    .replace(/Liquity/g, "ORA");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function reason(e: any): string {
  const m = e?.info?.error?.message || e?.shortMessage || e?.message || String(e);
  const match = String(m).match(/reverted with reason string '([^']+)'/);
  return rebrand(match ? match[1] : String(m).slice(0, 140));
}
