// Network switching + runtime config. Local demo mode additionally requires
// loopback (defense in depth: demo keys must never render on a public host).
import { ethers } from "ethers";
import { NETWORKS, DEFAULT_CONFIG } from "./config";
import { state, req, isRWA, bcfg } from "./state";
import type { Deployment } from "./config";
import { canUseDemo } from "./wallet-gate";
import { setAccount } from "./wallet";
import { setBranch, refresh } from "./views";
import { $, select } from "./dom";
import { renderActivity } from "./activity";

export async function loadConfig(): Promise<void> {
  try {
    const r = await fetch("/config");
    if (!r.ok) throw new Error("status " + r.status);
    const j = (await r.json()) as { faucet?: unknown; walletConnectProjectId?: unknown; previewDemo?: unknown };
    state.appConfig = {
      faucet: !!j.faucet,
      walletConnectProjectId: typeof j.walletConnectProjectId === "string" ? j.walletConnectProjectId : null,
      previewDemo: j.previewDemo === true,
    };
  } catch {
    state.appConfig = { ...DEFAULT_CONFIG }; // old server / file:// — degrade gracefully
  }
}

function setNetworkBadge(mode: string, status: "loading" | "ready" | "unavailable"): void {
  const net = NETWORKS[mode]; // callers pass keys validated against NETWORKS
  const badge = $("networkBadge");
  badge.dataset.status = status;
  badge.dataset.environment = net.local ? "local" : net.testnet ? "testnet" : "mainnet";
  badge.textContent = status === "loading"
    ? `Loading ${net.label}…`
    : status === "unavailable"
      ? `${net.label} · unavailable`
      : net.local ? "Local demo" : `${net.label} · ${net.testnet ? "testnet" : "mainnet"}`;
}

function showNetworkNotice(message: string, kind: "loading" | "error"): void {
  const notice = $("networkNotice");
  notice.hidden = false;
  notice.dataset.kind = kind;
  notice.textContent = message;
}

function hideNetworkNotice(): void {
  $("networkNotice").hidden = true;
}

function renderBranchOptions(deployment: Deployment): string {
  const branchSelect = select("branchSelect");
  branchSelect.replaceChildren();
  const labels: Record<string, string> = {
    ETH: "ETH · interest-free",
    wstETH: "wstETH",
    tBILL: "wmTBILL · RWA",
    ETHv2: "ETH · custom rates",
  };
  for (const [key, branch] of Object.entries(deployment.branches)) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = labels[key] || branch.collSymbol || key;
    branchSelect.appendChild(option);
  }
  const names = Object.keys(deployment.branches);
  const picker = $("branchPicker");
  picker.hidden = names.length <= 1;
  return names.includes("ETH") ? "ETH" : names[0];
}

function validateDeployment(deployment: Deployment, mode: string): string | null {
  if (!deployment || !deployment.branches || !deployment.abis || !deployment.shared) {
    return "The published deployment file is incomplete. Please try again later or contact the ORA team.";
  }
  const expected = NETWORKS[mode]?.chainIdHex;
  if (expected && deployment.chainId !== undefined && deployment.chainId !== parseInt(expected, 16)) {
    return `Deployment chain ID does not match ${NETWORKS[mode].label}; transactions have been disabled for safety.`;
  }
  if (Object.keys(deployment.branches).length === 0) return "This deployment has no collateral markets configured.";
  return null;
}

export function updateSimControls(): void {
  const settable = !!bcfg().ethUsdSettable;
  document.querySelectorAll("#priceRow button, #priceRow input").forEach((el) => {
    (el as HTMLButtonElement).disabled = !settable;
  });
  $("simNote").hidden = settable || isRWA();
}

function unavailable(mode: string, message: string): void {
  state.networkReady = false;
  state.provider = null;
  state.wallet = null;
  state.dep = null;
  state.C = {};
  state.position = null;
  state.price = 0;
  state.nativeBalance = 0n;
  state.collateralBalance = 0n;
  state.orUsdBalance = 0n;
  state.borrowingRate = 0n;
  state.oracleLive = null;
  state.navShock = false;
  state.recoveryMode = false;
  $("appContent").hidden = true;
  setNetworkBadge(mode, "unavailable");
  showNetworkNotice(message, "error");
}

export async function setNetwork(mode: string): Promise<void> {
  const selected = NETWORKS[mode] ? mode : "local";
  const net = NETWORKS[selected];
  state.netMode = selected;
  state.networkReady = false;
  state.provider = null;
  state.wallet = null;
  state.dep = null;
  state.C = {};
  state.position = null;
  state.price = 0;
  state.nativeBalance = 0n;
  state.collateralBalance = 0n;
  state.orUsdBalance = 0n;
  state.borrowingRate = 0n;
  state.oracleLive = null;
  state.navShock = false;
  state.recoveryMode = false;
  state.lastRefreshAt = null;
  state.lastRefreshError = null;
  $("appContent").hidden = true;
  select("networkSelect").value = selected;
  setNetworkBadge(selected, "loading");
  showNetworkNotice(`Loading ${net.label} deployment…`, "loading");

  if (net.local && !canUseDemo(state.hostname, state.appConfig.previewDemo)) {
    unavailable(selected, "The local demo chain is only available on localhost or an explicitly enabled Arena preview. Choose a published network, or open the app locally to use the demo.");
    return;
  }

  try {
    const response = await fetch(net.file + "?ts=" + Date.now());
    if (!response.ok) {
      unavailable(selected,
        `${net.label} does not have a published ORA deployment in this app build. No protocol actions are available on this network yet.`);
      return;
    }
    const deployment = await response.json() as Deployment;
    const validationError = validateDeployment(deployment, selected);
    if (validationError) {
      unavailable(selected, validationError);
      return;
    }

    state.dep = deployment;
    state.provider = net.local
      ? new ethers.JsonRpcProvider(location.origin + "/rpc", undefined, { staticNetwork: true })
      : new ethers.JsonRpcProvider(req(net.rpc, "rpc url"), parseInt(req(net.chainIdHex, "chainIdHex"), 16), { staticNetwork: true });

    // validateDeployment() above already rejected empty branch maps, so this
    // always resolves to a real branch key.
    const branch = renderBranchOptions(deployment);

    const faucetOn = net.local && state.appConfig.faucet;
    ( $("btnFaucet") as HTMLButtonElement).disabled = !faucetOn;
    $("faucetRow").hidden = !faucetOn;
    $("btnWC").hidden = net.local || !state.appConfig.walletConnectProjectId;
    $("btnConnect").textContent = "Connect wallet";
    $("btnConnect").hidden = net.local;
    $("walletSelect").hidden = net.local || state.discoveredWallets.length <= 1;
    $("accountSelect").hidden = !net.local;
    if (!net.local) $("addr").textContent = "Read-only · connect a wallet to transact";

    // The app only shows actions after a validated deployment and matching
    // provider have been configured. A failed refresh remains visible/stale.
    state.networkReady = true;
    setNetworkBadge(selected, "ready");
    hideNetworkNotice();
    $("appContent").hidden = false;
    select("branchSelect").value = branch;
    if (net.local) setAccount(select("accountSelect").value);
    setBranch(branch);
    renderActivity();
    await refresh();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    unavailable(selected, `Could not load ${net.label}: ${message}`);
  }
}
