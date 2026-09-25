// Lazy WalletConnect (mobile wallets). The provider library is dynamically
// imported on first use so desktop visitors never download it; our own QR
// modal (SVG, no canvas) keeps the dependency surface to the provider + a
// QR encoder instead of a full modal SDK.
import { toast } from "./dom";
import { reason } from "./format";
import type { Eip1193 } from "./state";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProviderImporter = () => Promise<any>;

let modal: HTMLElement | null = null;

export function hideWcModal(): void {
  modal?.remove();
  modal = null;
}

async function showWcModal(uri: string): Promise<void> {
  hideWcModal();
  const { default: QRCode } = await import("qrcode");
  const svg = await QRCode.toString(uri, { type: "svg", margin: 2 });
  const overlay = document.createElement("div");
  overlay.id = "wcModal";
  overlay.className = "wc-overlay";
  overlay.innerHTML =
    `<div class="wc-card"><h3>Scan with your mobile wallet</h3>` +
    `<div class="wc-qr">${svg}</div>` +
    `<div class="wc-row"><button class="mini" id="wcCopy">Copy pairing link</button> ` +
    `<button class="mini" id="wcClose">Cancel</button></div></div>`;
  document.body.appendChild(overlay);
  modal = overlay;
  document.getElementById("wcClose")?.addEventListener("click", hideWcModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) hideWcModal(); });
  document.getElementById("wcCopy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(uri);
      toast("Pairing link copied — paste it in your wallet app");
    } catch {
      toast("Copy failed — long-press the link in your wallet app instead", 6000);
    }
  });
}

export interface WcOpts {
  projectId: string;
  chainId: number;
  importProvider?: ProviderImporter;
  notify?: (msg: string, ms?: number) => void;
}

export async function connectWalletConnect(opts: WcOpts): Promise<Eip1193 | null> {
  const notify = opts.notify ?? toast;
  try {
    const mod = opts.importProvider
      ? await opts.importProvider()
      : await import("@walletconnect/ethereum-provider");
    const EthereumProvider = mod.EthereumProvider ?? mod.default?.EthereumProvider ?? mod.default;
    const wc = await EthereumProvider.init({
      projectId: opts.projectId,
      chains: [opts.chainId],
      showQrModal: false, // our own modal (display_uri below)
      methods: ["eth_sendTransaction", "eth_signTransaction", "eth_sign", "personal_sign", "eth_signTypedData"],
      events: ["chainChanged", "accountsChanged"],
      metadata: {
        name: "ORA Protocol",
        description: "Interest-free borrowing, hard-pegged orUSD",
        url: location.origin,
        icons: [`${location.origin}/logo.png`],
      },
    });
    wc.on("display_uri", (uri: string) => void showWcModal(uri));
    await wc.connect();
    hideWcModal();
    return wc as Eip1193;
  } catch (e) {
    hideWcModal();
    notify("WalletConnect failed: " + reason(e), 8000);
    return null;
  }
}
