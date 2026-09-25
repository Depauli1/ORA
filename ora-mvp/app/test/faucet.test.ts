// Server-faucet client: success, quota errors, and network failure.
// (Rate-limit buckets and the drip itself are covered server-side in
// app/test/server.test.ts.)
import { describe, it, expect, vi, afterEach } from "vitest";
import { requestFaucet } from "../src/faucet";

afterEach(() => vi.unstubAllGlobals());

function notifyMock() {
  const calls: Array<[string, number | undefined]> = [];
  const notify = (msg: string, ms?: number) => { calls.push([msg, ms]); };
  return { notify, calls };
}

describe("requestFaucet", () => {
  it("returns the tx hash and announces the drip", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true, json: async () => ({ txHash: "0xabc" }),
    }));
    const { notify, calls } = notifyMock();
    const h = await requestFaucet("0x70997970C51812dc3A010C7d01b50e0d17dc79C8", notify);
    expect(h).toBe("0xabc");
    expect(calls.map((c) => c[0]).join("\n")).toMatch(/100 test ORA on the way/);
  });

  it("surfaces quota errors without throwing", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false, status: 429, json: async () => ({ error: "faucet hourly quota exceeded" }),
    }));
    const { notify, calls } = notifyMock();
    const h = await requestFaucet("0xabc", notify);
    expect(h).toBeNull();
    expect(calls.map((c) => c[0]).join("\n")).toMatch(/quota exceeded/);
  });

  it("surfaces server-down as a friendly failure", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("socket hang up"); });
    const { notify, calls } = notifyMock();
    const h = await requestFaucet("0xabc", notify);
    expect(h).toBeNull();
    expect(calls.map((c) => c[0]).join("\n")).toMatch(/Faucet failed/);
  });
});
