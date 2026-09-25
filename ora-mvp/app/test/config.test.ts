// Network registry gating: mainnet stays wallet-only, testnet flags and
// chain ids pinned (a wrong chain id would connect wallets to the wrong net).
import { describe, it, expect } from "vitest";
import { NETWORKS, ACCOUNTS, Z } from "../src/config";
import { canUseDemo, isArenaPreview, isLocalhost } from "../src/wallet-gate";

describe("network registry", () => {
  it("local is a localhost demo net", () => {
    expect(NETWORKS.local).toMatchObject({ testnet: true, local: true, file: "deployment.json" });
  });

  it("Base Sepolia is a public testnet", () => {
    expect(NETWORKS.baseSepolia).toMatchObject({ testnet: true, local: false });
    expect(parseInt(NETWORKS.baseSepolia.chainIdHex!, 16)).toBe(84532);
  });

  it("Base mainnet is wallet-only (no testnet tooling)", () => {
    expect(NETWORKS.base).toMatchObject({ testnet: false, local: false });
    expect(parseInt(NETWORKS.base.chainIdHex!, 16)).toBe(8453);
  });

  it("demo accounts exist for exactly the three picker names", () => {
    expect(Object.keys(ACCOUNTS).sort()).toEqual(["alice", "bob", "carol"]);
  });

  it("zero address constant is well-formed", () => {
    expect(Z).toBe("0x0000000000000000000000000000000000000000");
  });
});

describe("localhost gate", () => {
  it.each(["localhost", "127.0.0.1", "::1", "[::1]", "app.localhost"])("allows %s", (h) => {
    expect(isLocalhost(h)).toBe(true);
  });
  it.each(["example.com", "192.168.1.2", "localhost.evil.com", "", "3000-xyz.e2b.app"])("denies %s", (h) => {
    expect(isLocalhost(h)).toBe(false);
  });

  it("allows only an opted-in port-prefixed Arena preview host for remote demos", () => {
    expect(isArenaPreview("3101-sandbox123.e2b.app")).toBe(true);
    expect(isArenaPreview("sandbox123.e2b.app")).toBe(false);
    expect(isArenaPreview("3101-sandbox123.e2b.app.evil.com")).toBe(false);
    expect(canUseDemo("3101-sandbox123.e2b.app", false)).toBe(false);
    expect(canUseDemo("3101-sandbox123.e2b.app", true)).toBe(true);
    expect(canUseDemo("example.com", true)).toBe(false);
  });
});
