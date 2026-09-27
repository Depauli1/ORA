// @vitest-environment jsdom
// main.ts auto-boot: outside test mode the module boots itself, and a broken
// DOM must surface as an "Init failed" toast rather than an unhandled crash.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { bootApp } from "./full-harness";

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

let restore: () => void = () => {};
beforeEach(async () => {
  const app = await bootApp();
  restore = app.restore;
});
afterEach(() => restore());

describe("auto-boot", () => {
  it("boots automatically outside test mode and toasts instead of crashing on a broken DOM", async () => {
    vi.resetModules();
    vi.stubEnv("MODE", "production");
    document.documentElement.innerHTML = html;
    document.getElementById("networkSelect")!.remove();
    await import("../src/main");
    const toast = document.getElementById("toast")!;
    const deadline = Date.now() + 5000;
    while (!toast.textContent && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(toast.textContent).toContain("Init failed:");
    expect(toast.textContent).toContain("networkSelect");
    vi.unstubAllEnvs();
  });
});
