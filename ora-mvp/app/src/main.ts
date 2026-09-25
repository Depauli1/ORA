// App entry: error hooks, boot sequence, test hook. Auto-boots in the
// browser; under vitest the suites drive boot() explicitly per test.
import "./styles.css";
import { NETWORKS } from "./config";
import { state } from "./state";
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
  state.refreshTimer = setInterval(() => {
    updateDataFreshness();
    if (!state.busy) void refresh();
  }, 8000);
}

// Auto-boot in the browser only — under vitest (MODE=test) the suites drive
// boot() explicitly, so importing this module must have no side effects.
if (import.meta.env?.MODE !== "test") {
  boot().catch((e) => toast("Init failed: " + reason(e), 10000));
}

// Test hook (inert in production): exposes the pure network registry so
// suites can pin testnet/mainnet gating without a chain or wallet.
window.__ora = window.__ora || { NETWORKS };
