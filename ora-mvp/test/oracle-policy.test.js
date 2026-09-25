// Finding 7: the prod oracle policy + its CI gate, covered by the suite so the
// gate itself cannot silently rot (static mode + artifact mode).
const { expect } = require("chai");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { assertProdConfig, isProdChain } = require("../scripts/oracle-policy");

const CHECK = path.join(__dirname, "..", "scripts", "check-oracle-config.js");
const run = (args = []) => {
  try {
    const out = execFileSync("node", [CHECK, ...args], { encoding: "utf8" });
    return { code: 0, out };
  } catch (e) { return { code: e.status, out: (e.stdout || "") + (e.stderr || "") }; }
};

describe("oracle policy (finding 7)", () => {
  it("static CI gate passes on the checked-in config", () => {
    const r = run();
    expect(r.out).to.include("ALL CHECKS PASSED");
    expect(r.code).to.equal(0);
  });

  it("assertProdConfig fails closed on every violation class", () => {
    const good = {
      network: "base", fallback: "0x1111111111111111111111111111111111111111",
      ethDeviationBps: 1000, wstethDeviationBps: 1000, ethHeartbeat: 7200,
      stethHeartbeat: 108000, sequencer: "0x2222222222222222222222222222222222222222",
    };
    expect(() => assertProdConfig(good)).to.not.throw();
    const Z = "0x0000000000000000000000000000000000000000";
    expect(() => assertProdConfig({ ...good, fallback: Z })).to.throw(/fallback aggregator/i);
    expect(() => assertProdConfig({ ...good, ethDeviationBps: 1001 })).to.throw(/deviation/i);
    expect(() => assertProdConfig({ ...good, wstethDeviationBps: 5000 })).to.throw(/deviation/i);
    expect(() => assertProdConfig({ ...good, ethHeartbeat: 86401 })).to.throw(/heartbeat/i);
    expect(() => assertProdConfig({ ...good, sequencer: Z })).to.throw(/sequencer/i);
    expect(isProdChain(8453)).to.equal(true);
    expect(isProdChain(84532)).to.equal(false);
  });

  it("artifact mode: prod chain with zero fallback FAILS, testnet passes advisory", () => {
    const Z = "0x0000000000000000000000000000000000000000";
    const tmp = (o) => {
      const f = path.join(os.tmpdir(), `ora-depl-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
      fs.writeFileSync(f, JSON.stringify(o));
      return f;
    };
    const bad = run(["--deployment", tmp({ chainId: 8453, shared: { ethUsdFallbackAggregator: Z } })]);
    expect(bad.code).to.equal(1);
    expect(bad.out).to.include("fallbackAggregator == address(0)");
    const good = run(["--deployment", tmp({
      chainId: 8453,
      shared: {
        ethUsdFallbackAggregator: "0x1111111111111111111111111111111111111111",
        prodPolicyEnforced: true, ethUsdDeviationBps: 1000, wstethDeviationBps: 800,
      },
    })]);
    expect(good.code).to.equal(0);
    const testnet = run(["--deployment", tmp({ chainId: 84532, shared: { ethUsdFallbackAggregator: Z } })]);
    expect(testnet.code).to.equal(0);
    expect(testnet.out).to.include("advisory only");
  });
});
