// @vitest-environment jsdom
// WalletConnect: lazy provider init, QR modal lifecycle, failure path, and
// the real dynamic-import branch (module mocked at the vitest level).
import { describe, it, expect, vi } from "vitest";
import { connectWalletConnect, hideWcModal } from "../src/walletconnect";

// Shape the production code unwraps via `mod.default?.EthereumProvider`.
const { wcFake } = vi.hoisted(() => {
  const listeners: Record<string, (uri: string) => void> = {};
  const wcFake = {
    on: vi.fn((ev: string, fn: (uri: string) => void) => { listeners[ev] = fn; }),
    connect: vi.fn(async () => {}),
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return ["0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B"];
      if (method === "eth_chainId") return "0x7a69";
      return null;
    }),
    __listeners: listeners,
  };
  return { wcFake };
});

vi.mock("@walletconnect/ethereum-provider", () => ({
  // the real package exposes EthereumProvider as a named export
  EthereumProvider: { init: vi.fn(async () => wcFake) },
}));

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

  it("uses the real (mocked) dynamic import when no importer is injected", async () => {
    const wc = await connectWalletConnect({ projectId: "test-pid", chainId: 1, notify: () => {} });
    expect(wc).toBe(wcFake);
    expect(wcFake.connect).toHaveBeenCalledTimes(1);
  });

  it("unwraps a module whose default export nests EthereumProvider, or IS it", async () => {
    const nested = { default: { EthereumProvider: { init: vi.fn(async () => wcFake) } } };
    const a = await connectWalletConnect({
      projectId: "p", chainId: 1, importProvider: async () => nested, notify: () => {},
    });
    expect(a).toBe(wcFake);

    const direct = { default: { init: vi.fn(async () => wcFake) } };
    const b = await connectWalletConnect({
      projectId: "p", chainId: 1, importProvider: async () => direct, notify: () => {},
    });
    expect(b).toBe(wcFake);
  });
});

describe("WalletConnect QR modal extras", () => {
  function mount(): void {
    document.body.innerHTML = '<div id="toast" role="status" aria-live="polite"></div>';
  }

  async function openModal(): Promise<void> {
    mount();
    const listeners: Record<string, (uri: string) => void> = {};
    const provider = {
      on: vi.fn((ev: string, fn: (uri: string) => void) => { listeners[ev] = fn; }),
      connect: vi.fn(async () => { listeners["display_uri"]?.("wc:pair-uri"); }),
    };
    const done = connectWalletConnect({
      projectId: "p", chainId: 1,
      importProvider: async () => ({ EthereumProvider: { init: vi.fn(async () => provider) } }),
      notify: () => {},
    });
    const deadline = Date.now() + 5000;
    while (!document.getElementById("wcModal") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!document.getElementById("wcModal")) throw new Error("modal never opened");
    await done;
  }

  it("closes when the overlay background itself is clicked", async () => {
    await openModal();
    const modal = document.getElementById("wcModal")!;
    modal.click(); // event target === overlay
    expect(document.getElementById("wcModal")).toBeNull();
  });

  it("copies the pairing link and confirms with a toast", async () => {
    await openModal();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    (document.getElementById("wcCopy") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(writeText).toHaveBeenCalledWith("wc:pair-uri");
    expect(document.getElementById("toast")!.textContent).toContain("Pairing link copied");
  });
});
