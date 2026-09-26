// @vitest-environment jsdom
// main.ts's adaptive poll scheduler: overlapping polls must clear the pending
// timer instead of stacking refreshes, and a hidden tab must not refresh at
// all. refresh() is replaced with manually-resolved deferreds so the interleaving
// is exact.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../src/views", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/views")>();
  return { ...actual, refresh: vi.fn() };
});

import * as views from "../src/views";
import { boot } from "../src/main";
import { state } from "../src/state";
import type { Deployment } from "../src/config";

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const deployment: Deployment = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "deployment.json"), "utf8"),
);

const refreshMock = vi.mocked(views.refresh);

beforeEach(async () => {
  document.documentElement.innerHTML = html;
  try { localStorage.clear(); } catch { /* fresh jsdom */ }
  vi.stubGlobal("fetch", (async (url: unknown) => {
    const u = String(url).split("?")[0];
    if (u === "/config") return { ok: true, status: 200, json: async () => ({ faucet: true }) };
    if (u.startsWith("deployment")) return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(deployment)) };
    if (u.startsWith("/log")) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: false, status: 404, json: async () => ({}) };
  }) as typeof fetch);
  await boot("localhost");
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  state.refreshTimer = null;
  state.reset("localhost");
  refreshMock.mockReset();
});

function deferred(): { promise: Promise<boolean>; resolve: (v: boolean) => void } {
  let resolve!: (v: boolean) => void;
  const promise = new Promise<boolean>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("poll scheduler", () => {
  it("swallows /log upload failures when reporting an error", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", (async (url: unknown) => {
      seen.push(String(url));
      throw new Error("offline");
    }) as typeof fetch);
    window.dispatchEvent(new ErrorEvent("error", { message: "boom", error: new Error("boom") }));
    await new Promise((r) => setTimeout(r, 30));
    expect(seen.some((u) => u.includes("/log"))).toBe(true);
  });

  it("a hidden tab skips refreshing entirely", async () => {
    const spy = vi.spyOn(Document.prototype, "hidden", "get").mockReturnValue(true);
    const timerBefore = state.refreshTimer;
    refreshMock.mockClear();
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 40));
    expect(refreshMock).not.toHaveBeenCalled();
    expect(state.refreshTimer).toBe(timerBefore); // not even rescheduled
    spy.mockRestore();
  });

  it("an overlapping poll clears the previous pending timer instead of stacking", async () => {
    expect(state.networkReady).toBe(true);
    const a = deferred();
    const b = deferred();
    refreshMock.mockImplementationOnce(() => a.promise);
    refreshMock.mockImplementationOnce(() => b.promise);

    // Two synchronous visibilitychange events → two overlapping polls.
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 20));
    expect(refreshMock).toHaveBeenCalledTimes(2);

    a.resolve(true); // poll A finishes first and schedules a timer
    await new Promise((r) => setTimeout(r, 20));
    const timerA = state.refreshTimer;
    expect(timerA).not.toBeNull();

    b.resolve(true); // poll B must CLEAR that pending timer and schedule its own
    await new Promise((r) => setTimeout(r, 20));
    expect(state.refreshTimer).not.toBeNull();
    expect(state.refreshTimer).not.toBe(timerA);
  });
});
