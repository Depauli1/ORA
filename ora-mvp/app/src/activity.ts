// Durable, user-visible transaction activity. Only public transaction
// metadata is persisted; no wallet keys or signing data ever enter storage.
import { NETWORKS } from "./config";
import { state } from "./state";

export type ActivityStatus =
  | "preparing"
  | "awaiting-wallet"
  | "submitted"
  | "confirming"
  | "processing"
  | "confirmed"
  | "failed"
  | "replaced"
  | "cancelled"
  | "interrupted";

export interface ActivityRecord {
  id: string;
  label: string;
  netMode: string;
  netLabel: string;
  explorer?: string;
  hash?: string;
  status: ActivityStatus;
  message?: string;
  errorCode?: string;
  recovery?: string;
  technical?: string;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = "ora.transaction-activity.v1";
const MAX_RECORDS = 20;
const ACTIVITY_STATUSES = new Set<ActivityStatus>([
  "preparing", "awaiting-wallet", "submitted", "confirming", "processing",
  "confirmed", "failed", "replaced", "cancelled", "interrupted",
]);
let idCounter = 0;

function isActivityStatus(value: unknown): value is ActivityStatus {
  return typeof value === "string" && ACTIVITY_STATUSES.has(value as ActivityStatus);
}

function makeId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid || `${Date.now()}-${++idCounter}`;
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.activity.slice(0, MAX_RECORDS)));
  } catch {
    // Private browsing/storage quota must not prevent a transaction.
  }
}

export function hydrateActivity(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    if (Array.isArray(parsed)) {
      state.activity = parsed.filter((item): item is ActivityRecord =>
        !!item && typeof item.id === "string" && typeof item.label === "string" &&
        isActivityStatus(item.status) && typeof item.createdAt === "number" && Number.isFinite(item.createdAt))
        .slice(0, MAX_RECORDS)
        .map((item) => {
          const validNetMode = typeof item.netMode === "string" &&
            Object.prototype.hasOwnProperty.call(NETWORKS, item.netMode);
          const netMode = validNetMode ? item.netMode : "local";
          const net = NETWORKS[netMode]; // netMode is validated or coerced to "local" above
          return {
            id: item.id.slice(0, 160),
            label: item.label.slice(0, 200),
            netMode,
            netLabel: net.label,
            explorer: net.explorer,
            hash: typeof item.hash === "string" ? item.hash.slice(0, 256) : undefined,
            status: item.status,
            message: typeof item.message === "string" ? item.message.slice(0, 500) : undefined,
            errorCode: typeof item.errorCode === "string" ? item.errorCode.slice(0, 80) : undefined,
            recovery: typeof item.recovery === "string" ? item.recovery.slice(0, 300) : undefined,
            technical: typeof item.technical === "string" ? item.technical.slice(0, 1200) : undefined,
            createdAt: item.createdAt,
            updatedAt: typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)
              ? item.updatedAt : item.createdAt,
          };
        });
    }
  } catch {
    state.activity = [];
  }
  // A page reload before a hash exists interrupts the wallet request. A
  // submitted hash remains trackable, but this page cannot promise that it
  // has reconciled the latest protocol state until a fresh read succeeds.
  state.activity = state.activity.map((item) =>
    item.status === "preparing" || item.status === "awaiting-wallet"
      ? {
        ...item,
        status: "interrupted",
        message: "The page reloaded before a transaction hash was saved. Check your wallet and activity before retrying.",
      }
      : item.status === "submitted" || item.status === "confirming" || item.status === "processing"
        ? {
          ...item,
          status: "submitted",
          message: "Tracking resumed after page reload; check the explorer for final status.",
        }
        : item);
  renderActivity();
}

export function addActivity(label: string, netMode: string): string {
  const net = NETWORKS[netMode] || NETWORKS.local;
  const id = makeId();
  const now = Date.now();
  state.activity.unshift({
    id,
    label,
    netMode,
    netLabel: net.label,
    explorer: net.explorer,
    status: "preparing",
    message: "Checking protocol state and preparing the transaction…",
    createdAt: now,
    updatedAt: now,
  });
  state.activity = state.activity.slice(0, MAX_RECORDS);
  persist();
  renderActivity();
  return id;
}

export function updateActivity(id: string, patch: Partial<Omit<ActivityRecord, "id" | "createdAt">>): void {
  const record = state.activity.find((item) => item.id === id);
  if (!record) return;
  Object.assign(record, patch, { updatedAt: Date.now() });
  persist();
  renderActivity();
}

function statusLabel(status: ActivityStatus): string {
  switch (status) {
    case "preparing": return "Preparing";
    case "awaiting-wallet": return "Confirm in wallet";
    case "submitted": return "Submitted";
    case "confirming": return "Confirming";
    case "processing": return "Updating account";
    case "confirmed": return "Confirmed";
    case "failed": return "Failed";
    case "replaced": return "Replaced";
    case "cancelled": return "Cancelled";
    case "interrupted": return "Interrupted";
  }
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function renderActivity(): void {
  const list = document.getElementById("activityList");
  if (!list) return;
  list.replaceChildren();

  const pending = state.activity.filter((item) =>
    item.status === "preparing" || item.status === "awaiting-wallet" || item.status === "submitted" ||
    item.status === "confirming" || item.status === "processing").length;
  const panel = document.getElementById("activityPanel") as HTMLDetailsElement | null;
  if (panel && pending > 0) panel.open = true;
  const summary = document.getElementById("activitySummary");
  if (summary) {
    summary.textContent = state.activity.length === 0
      ? "No transactions yet"
      : `${pending ? `${pending} pending · ` : ""}${state.activity.length} recent ${state.activity.length === 1 ? "transaction" : "transactions"}`;
  }

  if (state.activity.length === 0) {
    const empty = document.createElement("p");
    empty.className = "activity-empty";
    empty.textContent = "Your recent protocol transactions will appear here.";
    list.appendChild(empty);
    return;
  }

  for (const item of state.activity) {
    const row = document.createElement("article");
    row.className = "activity-item";
    row.dataset.status = item.status;

    const copy = document.createElement("div");
    copy.className = "activity-copy";
    const title = document.createElement("strong");
    title.textContent = item.label;
    const meta = document.createElement("span");
    meta.className = "activity-meta";
    meta.textContent = `${item.netLabel} · ${relativeTime(item.updatedAt)}`;
    copy.append(title, meta);

    const stateBlock = document.createElement("div");
    stateBlock.className = "activity-state";
    const badge = document.createElement("span");
    badge.className = "activity-badge";
    badge.textContent = statusLabel(item.status);
    stateBlock.appendChild(badge);
    if (item.message) {
      const message = document.createElement("span");
      message.className = "activity-message";
      message.textContent = item.message;
      stateBlock.appendChild(message);
    }
    if (item.recovery) {
      const recovery = document.createElement("span");
      recovery.className = "activity-recovery";
      recovery.textContent = item.recovery;
      stateBlock.appendChild(recovery);
    }
    if (item.technical) {
      const technical = document.createElement("details");
      technical.className = "activity-technical";
      const summary = document.createElement("summary");
      summary.textContent = item.errorCode ? `Technical details · ${item.errorCode}` : "Technical details";
      const raw = document.createElement("pre");
      raw.textContent = item.technical;
      technical.append(summary, raw);
      stateBlock.appendChild(technical);
    }
    if (item.hash) {
      if (item.explorer) {
        const link = document.createElement("a");
        link.href = `${item.explorer.replace(/\/$/, "")}/tx/${encodeURIComponent(item.hash)}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "View transaction";
        stateBlock.appendChild(link);
      } else {
        const hash = document.createElement("code");
        hash.textContent = `${item.hash.slice(0, 10)}…${item.hash.slice(-6)}`;
        hash.title = item.hash;
        stateBlock.appendChild(hash);
      }
    }
    row.append(copy, stateBlock);
    list.appendChild(row);
  }
}
