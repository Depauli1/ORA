// Pure display + message helpers. No state, no DOM — exhaustively unit
// tested (these format fund-critical numbers: debts, ratios, shortfalls).
import { ethers } from "ethers";

// Single source of locale-sensitive formatting. Every user-facing number in
// the app goes through fmt/fmtNum/fmtPct/fmtUsd(Num) — a future locale (or
// currency convention) changes these definitions and nothing else. Numeric
// SERIALIZATION (toFixed feeding parseEther) must stay locale-free and is
// deliberately not routed here.
export const NUMBER_LOCALE = "en-US";

export const fmt = (v: bigint, d = 2): string =>
  Number(ethers.formatEther(v)).toLocaleString(NUMBER_LOCALE, { maximumFractionDigits: d });

export const fmtNum = (v: number, d = 2): string =>
  v.toLocaleString(NUMBER_LOCALE, { maximumFractionDigits: d });

export const fmtPct = (v: number, d = 1): string => `${fmtNum(v, d)}%`;

export const fmtUsd = (v: bigint, d = 2): string => "$" + fmt(v, d);

export const fmtUsdNum = (v: number, d = 2): string => "$" + fmtNum(v, d);

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

export interface TransactionAppError {
  code: string;
  title: string;
  message: string;
  recovery: string;
  technical: string;
}

function technicalErrorText(error: unknown): string {
  const e = error as {
    code?: unknown;
    message?: unknown;
    shortMessage?: unknown;
    info?: { error?: { message?: unknown } };
  } | null;
  const fields = [e?.code, e?.info?.error?.message, e?.shortMessage, e?.message]
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .map(String);
  return [...new Set(fields)].join("\n").slice(0, 1200) || "No technical details were provided by the wallet or RPC.";
}

// Convert wallet/RPC/protocol failures into clear next steps while keeping a
// bounded, opt-in technical trace for support and debugging.
export function mapTransactionError(error: unknown): TransactionAppError {
  const e = error as { code?: unknown; message?: unknown; shortMessage?: unknown } | null;
  const raw = [e?.shortMessage, e?.message, error].filter(Boolean).map(String).join(" ");
  const text = raw.toLowerCase();
  const code = String(e?.code ?? "");
  const technical = technicalErrorText(error);

  if (code === "ACTION_REJECTED" || code === "4001" || /user rejected|user denied|request rejected/.test(text)) {
    return {
      code: "USER_REJECTED",
      title: "Request cancelled",
      message: "You rejected this request in your wallet. No transaction was submitted.",
      recovery: "Review the action again when you are ready; you can safely close this message.",
      technical,
    };
  }
  if (code === "INSUFFICIENT_FUNDS" || /insufficient funds|insufficient balance for transaction/.test(text)) {
    return {
      code: "INSUFFICIENT_GAS_BALANCE",
      title: "Not enough ETH for the network fee",
      message: "Your wallet balance cannot cover this transaction and its estimated gas cost.",
      recovery: "Keep enough ETH in your wallet for gas, then review and submit the action again.",
      technical,
    };
  }
  if (/network_error|server_error|timeout|econnreset|failed to fetch|could not detect network|chain unreachable/.test(`${code} ${text}`)) {
    return {
      code: "NETWORK_UNAVAILABLE",
      title: "Network unavailable",
      message: "ORA could not reliably reach the selected network, so this action could not be completed.",
      recovery: "Check your connection and selected network. Retry only after market data is current.",
      technical,
    };
  }
  if (code === "CALL_EXCEPTION" || /revert|execution reverted|pre-flight simulation/.test(text)) {
    const decoded = reason(error).replace(/^rejected in pre-flight simulation\s*[—:-]\s*/i, "");
    const useful = decoded && !/call exception|missing revert data|could not decode/i.test(decoded);
    return {
      code: "PROTOCOL_REJECTED",
      title: "The protocol rejected this action",
      message: useful ? decoded : "The transaction did not meet the protocol's current requirements.",
      recovery: "Review the amount, wallet balance, and current risk warnings before trying again.",
      technical,
    };
  }
  const plainMessage = error instanceof Error && !code && error.message.length <= 180 &&
    !/rpc|json-rpc|ethers|socket|fetch|0x[0-9a-f]{16,}/i.test(error.message)
    ? rebrand(error.message)
    : null;
  return {
    code: "TRANSACTION_FAILED",
    title: "Transaction could not be completed",
    message: plainMessage || "The action did not finish. Check recent activity to see whether a transaction was submitted.",
    recovery: "Review the technical details and current market state before retrying.",
    technical,
  };
}
