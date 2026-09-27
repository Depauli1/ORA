// Unit tests for the tiered Slither gate (scripts/slither-gate.js).
// The gate encodes the fork-kill-zone policy: Tier-2 (forks of audited code)
// findings must be zero-unacknowledged — Highs are never triageable unless
// mechanically proven inherited from an audited base; Mediums need a written
// triage entry.
const { expect } = require("chai");
const { evaluate, inheritsFromAuditedBase, TIER2_BASE } = require("../scripts/slither-gate");

// Minimal Slither-shaped finding factory. `elements[0].source_mapping.filename_relative`
// is where the gate reads the path from; elements[0].type "function" carries the name.
function finding(impact, check, file, fn) {
  return {
    impact, check,
    elements: [{
      type: fn ? "function" : "variable",
      name: fn || "x",
      source_mapping: { filename_relative: file }
    }]
  };
}

const TROVE_MANAGER_V2 = "contracts/branches/TroveManagerV2.sol";
const TROVE_MANAGER = "contracts/TroveManager.sol"; // Tier 0, audited
const TROVE_MANAGER_RWA = "contracts/rwa/TroveManagerRWA.sol";
const WT_BILL = "contracts/rwa/WTBill.sol"; // Tier 3

describe("slither tier gate", () => {
  it("passes with no findings", () => {
    const r = evaluate([], []);
    expect(r.fail).to.deep.equal([]);
    expect(r.warn).to.deep.equal([]);
  });

  it("fails on a HIGH in Tier 3 (new ORA code) — never triageable", () => {
    const r = evaluate([finding("High", "arbitrary-send-eth", WT_BILL, "claimSkim")], []);
    expect(r.fail).to.have.lengthOf(1);
    expect(r.fail[0]).to.include("TIER 3");
  });

  it("fails on a HIGH introduced by a Tier-2 fork even with a triage entry", () => {
    // liquidatePartial is NEW in TroveManagerV2 — no audited base has it.
    const dets = [finding("High", "reentrancy-eth", TROVE_MANAGER_V2, "liquidatePartial")];
    const triage = [{ check: "reentrancy-eth", impact: "High", path: TROVE_MANAGER_V2,
      inheritedFrom: TROVE_MANAGER, reason: "someone hoped" }];
    const r = evaluate(dets, triage);
    expect(r.fail).to.have.lengthOf(1);
    expect(r.fail[0]).to.include("not provably inherited");
  });

  it("passes an INHERITED Tier-2 HIGH that is triaged and provably anchored upstream", () => {
    // The same detector fires on the same function in the audited base.
    const dets = [
      finding("High", "arbitrary-send-eth", TROVE_MANAGER, "liquidate"),
      finding("High", "arbitrary-send-eth", TROVE_MANAGER_V2, "liquidate")
    ];
    const triage = [{ check: "arbitrary-send-eth", impact: "High", path: TROVE_MANAGER_V2,
      inheritedFrom: TROVE_MANAGER, reason: "audited v1 pattern" }];
    const r = evaluate(dets, triage);
    expect(r.fail).to.deep.equal([]);
    expect(r.warn.some(w => w.includes("INHERITED"))).to.equal(true);
  });

  it("proves inheritance through a fork-of-a-fork chain (RWA -> V2 -> upstream)", () => {
    const dets = [
      finding("High", "some-check", TROVE_MANAGER, "liquidate"),
      finding("High", "some-check", TROVE_MANAGER_V2, "liquidate"),
      finding("High", "some-check", TROVE_MANAGER_RWA, "liquidate")
    ];
    const idx = new Map();
    // Each fork file needs its own triage entry; the gate proves each one.
    const triage = [
      { check: "some-check", impact: "High", path: TROVE_MANAGER_V2,
        inheritedFrom: TROVE_MANAGER, reason: "audited v1 pattern" },
      { check: "some-check", impact: "High", path: TROVE_MANAGER_RWA,
        inheritedFrom: TROVE_MANAGER_V2, reason: "constants-only rebase" }
    ];
    const r = evaluate(dets, triage);
    expect(r.fail).to.deep.equal([]);
    expect(r.warn.filter(w => w.includes("INHERITED"))).to.have.lengthOf(2);
    // and the same finding WITHOUT the upstream anchor is not provable:
    const noAnchor = evaluate(
      [finding("High", "other-check", TROVE_MANAGER_V2, "liquidate"),
       finding("High", "other-check", TROVE_MANAGER_RWA, "liquidate")],
      [{ check: "other-check", impact: "High", path: TROVE_MANAGER_RWA,
         inheritedFrom: TROVE_MANAGER_V2, reason: "chain must anchor in Tier 0/1" }]);
    expect(noAnchor.fail).to.have.lengthOf(2);
  });

  it("fails on an untriaged MEDIUM in Tier 2, passes it once triaged", () => {
    const dets = [finding("Medium", "reentrancy-no-eth", TROVE_MANAGER_V2, "liquidate")];
    expect(evaluate(dets, []).fail).to.have.lengthOf(1);
    const triage = [{ check: "reentrancy-no-eth", impact: "Medium",
      path: "contracts/branches/", reason: "audited CEI ordering" }];
    const r = evaluate(dets, triage);
    expect(r.fail).to.deep.equal([]);
    expect(r.warn.some(w => w.includes("triaged"))).to.equal(true);
  });

  it("never gates the audited Tier 0/1 core, but still gates testnet Mocks (Tier 3)", () => {
    const dets = [
      finding("High", "arbitrary-send-eth", "contracts/StabilityPool.sol", "offset"), // Tier 0
      finding("High", "anything", "contracts/TestContracts/fuzz/VaultHandler.sol", "opDeposit") // scaffold
    ];
    const r = evaluate(dets, []);
    expect(r.fail).to.deep.equal([]);
    expect(r.counts.other).to.equal(2);
    // MockWstETH is deployed to public testnets: the old gate never excluded
    // it, and neither does this one.
    const mock = evaluate([finding("High", "anything", "contracts/branches/MockWstETH.sol", "faucet")], []);
    expect(mock.fail).to.have.lengthOf(1);
  });

  it("inheritsFromAuditedBase walks a fork-of-a-fork chain to its Tier 0 anchor", () => {
    expect(TIER2_BASE[TROVE_MANAGER_RWA]).to.include(TROVE_MANAGER_V2);
    const idx = new Map([[TROVE_MANAGER + "|c", new Set(["f"])],
                         [TROVE_MANAGER_V2 + "|c", new Set(["f"])]]);
    expect(inheritsFromAuditedBase(
      { check: "c", elements: [{ type: "function", name: "f" }] },
      idx, [TROVE_MANAGER_V2])).to.equal(true);
    // Without the Tier 0 anchor the chain does not prove inheritance:
    const idx2 = new Map([[TROVE_MANAGER_V2 + "|c", new Set(["f"])]]);
    expect(inheritsFromAuditedBase(
      { check: "c", elements: [{ type: "function", name: "f" }] },
      idx2, [TROVE_MANAGER_V2])).to.equal(false);
  });
});
