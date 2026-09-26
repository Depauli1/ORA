// Wallet layer: localhost-gated demo accounts, EIP-6963 discovery, injected
// + WalletConnect connections, pre-flight simulation, guarded sends.
// (views.ts imports tx() from here and this imports refresh() from views —
// a runtime-safe ESM cycle: both are only *called* inside function bodies.)
import { ethers } from "ethers";
import { ACCOUNTS, NETWORKS } from "./config";
import { state, provider, myAddr, req, type AppSigner, type Eip1193 } from "./state";
import { canUseDemo } from "./wallet-gate";
import { connectContracts } from "./contracts";
import { refresh } from "./views";
import { $, select, toast } from "./dom";
import { short, reason, mapTransactionError } from "./format";
import { addActivity, updateActivity } from "./activity";

export function setAccount(name: string): void {
  if (!canUseDemo(state.hostname, state.appConfig.previewDemo)) {
    toast("Demo accounts are available on localhost or an explicitly enabled Arena preview only", 7000);
    return;
  }
  const key = ACCOUNTS[name];
  if (!key) {
    toast(`Unknown demo account: ${name}`, 7000);
    return;
  }
  const w = new ethers.Wallet(key, provider());
  const wallet = new ethers.NonceManager(w) as unknown as AppSigner;
  wallet.address = w.address;
  state.wallet = wallet;
  guardSigner(wallet, provider());
  connectContracts();
  $("addr").textContent = w.address;
}

/* EIP-6963 multi-wallet discovery: every installed browser wallet announces
 * itself (MetaMask, Rabby, Coinbase Wallet, Trust…); the user picks one.
 * Falls back to the legacy window.ethereum injection. */
export function initWalletDiscovery(): void {
  if (state.discoveryInstalled) return;
  state.discoveryInstalled = true;
  window.addEventListener("eip6963:announceProvider", (ev) => {
    try {
      const e = ev as CustomEvent;
      if (!e.detail || !e.detail.info) return;
      if (state.discoveredWallets.some((w) => w.info.uuid === e.detail.info.uuid)) return;
      state.discoveredWallets.push(e.detail);
      const sel = document.getElementById("walletSelect") as HTMLSelectElement | null;
      if (!sel) return;
      sel.innerHTML = state.discoveredWallets
        .map((w, i) => `<option value="${i}">${w.info.name}</option>`).join("");
      sel.hidden = state.discoveredWallets.length <= 1 || $("btnConnect").hidden;
    } catch { /* ignore malformed announcements */ }
  });
  try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch { /* ignore */ }
}

export function pickedEip1193(): Eip1193 | null {
  if (state.discoveredWallets.length > 0) {
    const i = parseInt(select("walletSelect").value || "0", 10) || 0;
    return (state.discoveredWallets[i] || state.discoveredWallets[0]).provider;
  }
  return (window.ethereum as Eip1193 | undefined) || null;
}

// Shared connect tail: chain switch/add, signer, guard, refresh.
export async function connectWithProvider(injected: Eip1193, via: string): Promise<void> {
  const net = NETWORKS[state.netMode];
  try {
    try {
      await injected.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: net.chainIdHex }],
      });
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code;
      if (code === 4902) {
        await injected.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: net.chainIdHex,
            chainName: net.chainName,
            rpcUrls: [net.rpc],
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            blockExplorerUrls: [net.explorer],
          }],
        });
      } else { throw err; }
    }
    const bp = new ethers.BrowserProvider(injected as unknown as ethers.Eip1193Provider);
    await bp.send("eth_requestAccounts", []);
    const signer = (await bp.getSigner()) as AppSigner;
    // NB: JsonRpcSigner exposes `address` as a read-only getter — assigning
    // to it throws, which used to break every injected-wallet connection.
    // The getter is authoritative, so nothing needs caching here.
    guardSigner(signer, bp);
    state.provider = bp;
    state.wallet = signer;
    connectContracts();
    $("addr").textContent = signer.address;
    $("btnConnect").textContent = short(signer.address);
    toast("✓ Wallet connected to " + net.label + via);
    await refresh();
  } catch (e) {
    toast("Wallet connection failed: " + reason(e), 8000);
  }
}

// wcStarter is injectable for tests (real one lives in walletconnect.ts).
export async function connectWallet(wcStarter?: () => Promise<Eip1193 | null>): Promise<void> {
  const net = NETWORKS[state.netMode];
  const injected = pickedEip1193();
  if (!injected) {
    // Mobile path: no extension — fall through to WalletConnect when the
    // server provides a project id, else the classic install prompt.
    if (state.appConfig.walletConnectProjectId && wcStarter) {
      const wc = await wcStarter();
      if (wc) return connectWithProvider(wc, " via WalletConnect");
      return; // wcStarter already toasted the failure
    }
    toast(`No wallet extension found — install MetaMask (or a compatible wallet) to use ${net.label}.`, 8000);
    return;
  }
  return connectWithProvider(injected, "");
}

/* Pre-flight simulation: every write is eth_call'd first, so a doomed tx is
 * rejected with the DECODED revert reason before the wallet ever prompts for
 * a signature (and before any gas is spent). Non-revert simulation hiccups
 * (RPC blips, missing state) never block sending. */
export function guardSigner(signer: AppSigner, prov: ethers.AbstractProvider): AppSigner {
  if (signer.__oraGuarded) return signer;
  const orig = signer.sendTransaction.bind(signer);
  signer.sendTransaction = (async (txReq: ethers.TransactionRequest) => {
    let simulationPassed = true;
    try {
      await prov.call({ ...txReq, from: signer.address });
    } catch (e: unknown) {
      const ee = e as { code?: string; data?: unknown };
      if (e && (ee.code === "CALL_EXCEPTION" || ee.data)) {
        throw new Error("rejected in pre-flight simulation — " + reason(e));
      }
      // Non-revert RPC hiccups never block a send; disclose the uncertainty.
      simulationPassed = false;
    }
    if (state.activeActivityId) {
      updateActivity(state.activeActivityId, {
        status: "awaiting-wallet",
        message: simulationPassed
          ? "Simulation passed. Confirm the transaction in your wallet."
          : "Simulation was unavailable. Review the transaction details carefully in your wallet.",
      });
    }
    return orig(txReq);
  }) as typeof signer.sendTransaction;
  signer.__oraGuarded = true;
  return signer;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tx(
  label: string,
  fn: () => Promise<any>,
  reconcileState: () => Promise<boolean> = refresh,
): Promise<boolean> {
  if (!state.wallet) {
    toast("Connect a wallet first");
    return false;
  }
  if (state.busy) return false;
  state.busy = true;
  const activityId = addActivity(label, state.netMode);
  state.activeActivityId = activityId;
  updateActivity(activityId, {
    status: "preparing",
    message: "Checking protocol state and preparing the transaction…",
  });
  let succeeded = false;

  const markConfirmed = (hash: string | undefined, reconciled: boolean): void => {
    updateActivity(activityId, {
      status: "confirmed",
      hash,
      message: reconciled
        ? "Confirmed on-chain. Your latest position and balances have been refreshed."
        : "Confirmed on-chain, but the latest account data could not be refreshed. The page will keep retrying.",
    });
    toast(reconciled
      ? `✓ ${label} confirmed; account data updated`
      : `✓ ${label} confirmed; account data is still refreshing`, 8000);
  };

  try {
    toast(`${label} — preparing transaction…`, 60000);
    const response = await fn();
    if (!response || typeof response.wait !== "function") {
      throw new Error("The wallet did not return a transaction response.");
    }
    const hash = typeof response.hash === "string" ? response.hash : undefined;
    updateActivity(activityId, {
      status: "submitted", hash,
      message: "Transaction submitted to the network.",
    });
    updateActivity(activityId, {
      status: "confirming", hash,
      message: "Waiting for on-chain confirmation…",
    });
    const receipt = await response.wait();
    if (receipt?.status === 0) throw new Error("Transaction was included but reverted.");

    updateActivity(activityId, {
      status: "processing", hash,
      message: "Transaction confirmed. Refreshing your ORA position and balances…",
    });
    succeeded = true;
    const reconciled = await reconcileState();
    markConfirmed(hash, reconciled);
  } catch (e) {
    const txError = e as {
      code?: string | number;
      cancelled?: boolean;
      replacement?: { hash?: string };
      receipt?: { status?: number };
    };
    if (txError?.code === "TRANSACTION_REPLACED") {
      const replacedHash = txError.replacement?.hash;
      if (txError.cancelled) {
        updateActivity(activityId, {
          status: "cancelled", hash: replacedHash,
          message: "The wallet cancelled this transaction replacement.",
          errorCode: "TRANSACTION_REPLACED_CANCELLED",
          recovery: "No replacement was confirmed. Review recent activity before submitting again.",
          technical: mapTransactionError(e).technical,
        });
        toast(`✗ ${label} cancelled in wallet`, 8000);
      } else if (txError.receipt?.status === 1) {
        updateActivity(activityId, {
          status: "processing", hash: replacedHash,
          message: "Replacement confirmed. Refreshing your ORA position and balances…",
        });
        succeeded = true;
        const reconciled = await reconcileState();
        markConfirmed(replacedHash, reconciled);
      } else {
        updateActivity(activityId, {
          status: "replaced", hash: replacedHash,
          message: "The wallet replaced this transaction. Check the linked transaction for its final status.",
          errorCode: "TRANSACTION_REPLACED",
          recovery: "Use the linked transaction to confirm its outcome before retrying.",
          technical: mapTransactionError(e).technical,
        });
        toast("Transaction replaced — check Recent activity", 8000);
      }
    } else {
      const appError = mapTransactionError(e);
      const rejected = appError.code === "USER_REJECTED";
      updateActivity(activityId, {
        status: rejected ? "cancelled" : "failed",
        message: appError.message,
        errorCode: appError.code,
        recovery: appError.recovery,
        technical: appError.technical,
      });
      toast(`${appError.title}: ${appError.message}`, 8000);
    }
  } finally {
    if (state.activeActivityId === activityId) state.activeActivityId = null;
    state.busy = false;
  }
  return succeeded;
}
