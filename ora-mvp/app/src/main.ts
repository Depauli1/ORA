// App entry: error hooks, boot sequence, test hook. Auto-boots in the
// browser; under vitest the suites drive boot() explicitly per test.
import "./styles.css";
import { NETWORKS } from "./config";
import { state, BASE_POLL_MS, nextPollDelayMs } from "./state";
import { canUseDemo } from "./wallet-gate";
import { initWalletDiscovery } from "./wallet";
import { loadConfig, setNetwork } from "./network";
import { refresh, updateDataFreshness } from "./views";
import { wireActions } from "./actions";
import { toast } from "./dom";
import { reason } from "./format";
import { hydrateActivity } from "./activity";

// Error tracking: uncaught errors/rejections are reported to the app server's
// /log ring buffer (inspect at GET /log). No third-party telemetry.
function reportError(kind: string, message: unknown, stack: unknown): void {
  try {
    fetch("/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind, message: String(message).slice(0, 500),
        stack: String(stack || "").slice(0, 1500), url: location.href, ua: navigator.userAgent,
      }),
    }).catch(() => { /* reporting must never break the app */ });
  } catch { /* ignore */ }
}

let hooksInstalled = false;

export function installErrorHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  window.addEventListener("error", (e) => reportError("error", e.message, (e as ErrorEvent).error?.stack));
  window.addEventListener("unhandledrejection", (e) =>
    reportError("unhandledrejection", (e.reason?.message || e.reason) ?? "unknown", e.reason?.stack));
}

// Adaptive polling scheduler. One refresh = one ~22-call RPC batch, so the
// cadence is a quota decision, not just a freshness knob:
//   - healthy: fixed BASE_POLL_MS (8s)
//   - failing: exponential backoff, capped at MAX_POLL_MS (60s) — the
//     stale-data lockout (views.ts) already pauses risk-increasing actions,
//     so backing off never trades safety for quota
//   - tab hidden: no RPC at all; an immediate catch-up refresh on return
let pollDelayMs = BASE_POLL_MS;
let visibilityHookInstalled = false;

function schedulePoll(): void {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => void poll(), pollDelayMs);
}

async function poll(): Promise<void> {
  state.refreshTimer = null;
  if (document.hidden) return schedulePoll(); // no RPC while hidden
  updateDataFreshness();
  if (!state.busy) {
    const ok = await refresh();
    pollDelayMs = nextPollDelayMs(pollDelayMs, ok);
  }
  schedulePoll();
}

function installVisibilityHook(): void {
  if (visibilityHookInstalled) return;
  visibilityHookInstalled = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || state.busy || !state.networkReady) return;
    pollDelayMs = BASE_POLL_MS; // catch up immediately on return
    void poll();
  });
}

export async function boot(hostname: string = location.hostname): Promise<void> {
  installErrorHooks();
  state.reset(hostname);
  hydrateActivity();
  initWalletDiscovery();
  await loadConfig();
  // Localhost keeps the local demo default. The hosted Arena preview may use
  // it only when its server explicitly opts in; all other public hosts remain
  // on the published-network path.
  await setNetwork(canUseDemo(hostname, state.appConfig.previewDemo) ? "local" : "baseSepolia");
  wireActions();
  installVisibilityHook();
  pollDelayMs = BASE_POLL_MS;
  schedulePoll();
}

// Auto-boot in the browser only — under vitest (MODE=test) the suites drive
// boot() explicitly, so importing this module must have no side effects.
if (import.meta.env?.MODE !== "test") {
  boot().catch((e) => toast("Init failed: " + reason(e), 10000));
}

// Test hook (inert in production): exposes the pure network registry so
// suites can pin testnet/mainnet gating without a chain or wallet.
window.__ora = window.__ora || { NETWORKS };
