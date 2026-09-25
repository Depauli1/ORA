// @vitest-environment jsdom
// WalletConnect: lazy provider init, QR modal lifecycle, failure path.
import { describe, it, expect, vi } from "vitest";
import { connectWalletConnect, hideWcModal } from "../src/walletconnect";

function fakeModule(hooks: { listeners?: Record<string, (uri: string) => void> } = {}) {
  const listeners: Record<string, (uri: string) => void> = {};
  if (hooks.listeners) Object.assign(listeners, hooks.listeners);
  const provider = {
    on: vi.fn((ev: string, fn: (uri: string) => void) => { listeners[ev] = fn; }),
    connect: vi.fn(async () => {}),
  };
  return {
    listeners,
    provider,
    mod: { EthereumProvider: { init: vi.fn(async (_opts: unknown) => provider) } },
  };
}

describe("connectWalletConnect", () => {
  it("inits the provider lazily and returns it", async () => {
    const f = fakeModule();
    const wc = await connectWalletConnect({
      projectId: "test-pid",
      chainId: 84532,
      importProvider: async () => f.mod,
      notify: () => {},
    });
    expect(f.mod.EthereumProvider.init).toHaveBeenCalledTimes(1);
    expect(f.mod.EthereumProvider.init.mock.calls[0][0]).toMatchObject({
      projectId: "test-pid",
      chains: [84532],
      showQrModal: false,
    });
    expect(f.provider.connect).toHaveBeenCalledTimes(1);
    expect(wc).toBe(f.provider);
    expect(document.getElementById("wcModal")).toBeNull();
  });

  it("shows a scannable QR modal on display_uri, closes on cancel", async () => {
    const f = fakeModule();
    // emit display_uri during connect()
    f.provider.connect = vi.fn(async () => { f.listeners["display_uri"]?.("wc:test-pairing-uri"); });
    const done = connectWalletConnect({
      projectId: "test-pid",
      chainId: 1,
      importProvider: async () => f.mod,
      notify: () => {},
    });
    // modal appears while connecting (async QR render)
    const deadline = Date.now() + 5000;
    while (!document.getElementById("wcModal") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const modal = document.getElementById("wcModal");
    expect(modal).not.toBeNull();
    expect(modal!.querySelector("svg")).not.toBeNull();
    (modal!.querySelector("#wcClose") as HTMLButtonElement).click();
    expect(document.getElementById("wcModal")).toBeNull();
    await done;
    expect(document.getElementById("wcModal")).toBeNull();
  });

  it("returns null and notifies when the import fails", async () => {
    const notes: string[] = [];
    const wc = await connectWalletConnect({
      projectId: "test-pid",
      chainId: 1,
      importProvider: async () => { throw new Error("chunk load failed"); },
      notify: (m) => notes.push(m),
    });
    expect(wc).toBeNull();
    expect(notes.join("\n")).toMatch(/WalletConnect failed/);
    hideWcModal();
  });
});
