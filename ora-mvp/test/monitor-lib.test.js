// Finding 8: the realtime monitor's alerting logic, pinned by unit tests.
const { expect } = require("chai");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");
const { E18, tcrBand, newAlertBus, heartbeatStatus, isLargeRedemption } = require("../scripts/monitor-lib");

const WATCH = path.join(__dirname, "..", "scripts", "watch-invariants.js");

describe("realtime monitor logic", () => {
  it("tcrBand classifies bands with exact-boundary semantics", () => {
    const W = 15n * 10n ** 17n, C = 125n * 10n ** 16n; // 1.5 / 1.25
    expect(tcrBand(2n * E18, W, C)).to.equal("ok");
    expect(tcrBand(W, W, C)).to.equal("ok");          // boundary belongs up
    expect(tcrBand(W - 1n, W, C)).to.equal("warn");
    expect(tcrBand(C, W, C)).to.equal("warn");
    expect(tcrBand(C - 1n, W, C)).to.equal("crit");
    expect(tcrBand(E18 + 1n, W, C)).to.equal("crit");
    expect(tcrBand(E18, W, C)).to.equal("insolvent");
    expect(tcrBand(E18 / 2n, W, C)).to.equal("insolvent");
  });

  it("alert bus fires once then respects cooldown; force bypasses", () => {
    const bus = newAlertBus(30 * 60 * 1000);
    const t0 = 1_700_000_000_000;
    expect(bus.shouldFire("k", t0)).to.equal(true);
    expect(bus.shouldFire("k", t0 + 1000)).to.equal(false);
    expect(bus.shouldFire("other", t0 + 1000)).to.equal(true); // keys independent
    expect(bus.shouldFire("k", t0 + 30 * 60 * 1000)).to.equal(true); // cooldown elapsed
    expect(bus.shouldFire("k", t0 + 30 * 60 * 1000 + 1)).to.equal(false);
    expect(bus.shouldFire("k", t0 + 30 * 60 * 1000 + 2, true)).to.equal(true); // recovery goes through
    bus.reset("k");
    expect(bus.shouldFire("k", t0 + 30 * 60 * 1000 + 3)).to.equal(true);
  });

  it("heartbeatStatus reads keeper heartbeats and flags staleness", () => {
    const f = path.join(os.tmpdir(), `ora-hb-${Date.now()}.json`);
    const now = 1_700_000_000_000;
    fs.writeFileSync(f, JSON.stringify({ ts: now - 60_000 }));
    expect(heartbeatStatus(fs, f, 300_000, now)).to.deep.equal({ ageMs: 60_000, stale: false });
    fs.writeFileSync(f, JSON.stringify({ ts: now - 301_000 }));
    const s = heartbeatStatus(fs, f, 300_000, now);
    expect(s.stale).to.equal(true);
    expect(heartbeatStatus(fs, f + ".nope", 300_000, now)).to.deep.equal({ missing: true, reason: "file not found" });
    fs.writeFileSync(f, "not json");
    expect(heartbeatStatus(fs, f, 300_000, now).missing).to.equal(true);
  });

  it("large-redemption filter uses >= threshold (boundary alerts)", () => {
    const T = ethers.parseEther("100000");
    expect(isLargeRedemption(T, T)).to.equal(true);
    expect(isLargeRedemption(T - 1n, T)).to.equal(false);
    expect(isLargeRedemption(T + 1n, T)).to.equal(true);
    expect(isLargeRedemption(0n, T)).to.equal(false);
  });

  it("one-shot with a missing deployment skips cleanly (exit 0)", () => {
    const out = execFileSync("node", [WATCH], {
      encoding: "utf8",
      env: { ...process.env, ORA_DEPLOYMENT: path.join(os.tmpdir(), "ora-nope-missing.json") },
    });
    expect(out).to.include("nothing to monitor");
  });
});
