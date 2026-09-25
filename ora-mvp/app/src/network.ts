// Network switching + runtime config. Local demo mode additionally requires
// loopback (defense in depth: demo keys must never render on a public host,
// even if someone serves this build with a deployment.json present).
import { ethers } from "ethers";
import { NETWORKS, DEFAULT_CONFIG } from "./config";
import { state, req, bcfg, isRWA } from "./state";
import { isLocalhost } from "./wallet-gate";
import { setAccount } from "./wallet";
import { setBranch, refresh } from "./views";
import { $, select, toast } from "./dom";
import { reason } from "./format";

export async function loadConfig(): Promise<void> {
  try {
    const r = await fetch("/config");
    if (!r.ok) throw new Error("status " + r.status);
    const j = (await r.json()) as { faucet?: unknown; walletConnectProjectId?: unknown };
    state.appConfig = {
      faucet: !!j.faucet,
      walletConnectProjectId: typeof j.walletConnectProjectId === "string" ? j.walletConnectProjectId : null,
    };
  } catch {
    state.appConfig = { ...DEFAULT_CONFIG }; // old server / file:// — degrade gracefully
  }
}

export function updateSimControls(): void {
  const settable = !!bcfg().ethUsdSettable;
  document.querySelectorAll("#priceRow button, #priceRow input").forEach((el) => {
    (el as HTMLButtonElement).disabled = !settable;
  });
  $("simNote").style.display = settable || isRWA() ? "none" : "inline";
}

export async function setNetwork(mode: string): Promise<void> {
  try {
    const net = NETWORKS[mode] || NETWORKS.local;
    if (!net.local) {
      const r = await fetch(net.file + "?ts=" + Date.now());
      if (!r.ok) {
        toast(net.label + " not deployed yet — run the deployment runbook, commit " + net.file + ", and reload.", 9000);
        select("networkSelect").value = state.netMode;
        return;
      }
      state.dep = await r.json();
      state.netMode = mode;
      state.provider = new ethers.JsonRpcProvider(req(net.rpc, "rpc url"), parseInt(req(net.chainIdHex, "chainIdHex"), 16), { staticNetwork: true });
      state.wallet = null;
      $("accountSelect").style.display = "none";
      $("btnConnect").style.display = "inline-block";
      $("addr").textContent = "read-only — connect a wallet to transact";
    } else {
      if (!isLocalhost(state.hostname)) {
        toast("Local demo chain is available on localhost only", 8000);
        select("networkSelect").value = state.netMode;
        return;
      }
      state.dep = await (await fetch(net.file + "?ts=" + Date.now())).json();
      state.netMode = mode;
      state.provider = new ethers.JsonRpcProvider(location.origin + "/rpc", undefined, { staticNetwork: true });
      $("accountSelect").style.display = "inline-block";
      $("btnConnect").style.display = "none";
    }
    // The ORA faucet is a server-side drip, offered only on the local chain
    // when the server holds a faucet key (see faucet.ts).
    const faucetOn = net.local && state.appConfig.faucet;
    ( $("btnFaucet") as HTMLButtonElement).disabled = !faucetOn;
    $("faucetRow").style.display = faucetOn ? "" : "none";
    // WalletConnect covers mobile on public nets (local dev uses demo keys).
    $("btnWC").style.display = !net.local && state.appConfig.walletConnectProjectId ? "inline-block" : "none";

    // Guard against stale/partial deployment files (e.g. cached from an older
    // phase, or a public deployment made before newer branches existed).
    const dep = state.dep;
    if (!dep || !dep.branches || !dep.abis || !dep.shared) {
      throw new Error("deployment file is invalid or from an old build — hard-refresh the page (Ctrl/Cmd+Shift+R)");
    }
    // Only show tabs for branches this deployment actually has
    document.querySelectorAll<HTMLElement>(".tab").forEach((t) =>
      (t.style.display = dep.branches[t.dataset.branch || ""] ? "" : "none"));
    if (!dep.branches[state.branch]) state.branch = Object.keys(dep.branches)[0];

    if (net.local) setAccount(select("accountSelect").value);
    setBranch(dep.branches.ETH ? "ETH" : Object.keys(dep.branches)[0]);
    await refresh();
  } catch (e) {
    toast("Network switch failed: " + reason(e), 8000);
  }
}
