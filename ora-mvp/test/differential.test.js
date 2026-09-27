// ---------------------------------------------------------------------------
// Tier-2 differential suite — the fork-kill-zone defense.
//
// The ERC20/wstETH branch suite (branches/*, Tier 2 in AUDIT_DIFF.md) is a
// textual fork of the audited v1 engine with bounded deltas: ERC20 custody,
// soft liquidations, branch tokenomics. Historically that is exactly where
// forks die — small deltas colliding with old assumptions. This suite attacks
// the zone three ways:
//
//  1. Differential equality: the SAME operation sequence is replayed on the
//     v1 ETH branch (Tier 0, byte-identical to audited Liquity) and on the
//     Tier-2 ERC20 branch; every trove debt, ICR, TCR, SP deposit and the
//     orUSD supply must match to the wei after each step, and both branches
//     must accept/reject each op identically (revert parity).
//  2. Conservation invariants (both branches, after every op):
//       - orUSD supply == ActivePool.debt + DefaultPool.debt
//         (every minted orUSD is accounted for as recorded system debt)
//       - Σ (recorded + pending) trove debt  == AP.debt + DP.debt  (sub-dust)
//       - Σ (recorded + pending) trove coll  == AP.coll + DP.coll  (sub-dust)
//       - SP collateral balance == Σ depositors' unclaimed gains
//  3. Soft-liquidation exactness (V2 only): liquidatePartial restores the
//     trove to exactly MCR (the documented Phase-2 property), mirrored here
//     in integer math, with SP/pool accounting asserted to the wei.
//
// Collateral value parity: MockWstETH prices at 1.2 ETH (stEthPerToken), so
// the sequence uses 6:5 amounts — 6 ETH on branch 1 == 5 wstETH on branch 2
// in USD value, making every debt/ICR/TCR figure directly comparable.
// Protocol constants (gas comp etc.) are unit-agnostic and therefore NOT
// compared across branches, only conserved within them.
//
// Redemptions are out of scope here: they exercise hint plumbing whose
// cross-branch equivalence is covered by test/redemption-ordering.test.js.
// ---------------------------------------------------------------------------
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { E, Z, MAX_FEE, ethFixture, v2Fixture, rng } = require("./helpers");

const ACTIVE = 1n;
const CLOSED_BY_LIQUIDATION = 3n;
// Sub-dust tolerances: redistribution uses error-corrected per-unit-staked
// math, so aggregate drift is bounded by ~1 wei per redistributed trove.
const DEBT_DUST = 64n;      // per-invariant wei budget (lists are small)
// SP gain snapshots compound floor divisions at deposit scale: per depositor,
// error ≲ initialDeposit/1e18 per offset event (5,533 wei observed on a 10k
// deposit) — six orders of magnitude below any economic quantity.
const SP_DUST = 100000n;
const ICR_REL_DUST = 10n ** 9n; // 1e-9 relative — "exactly MCR" up to rounding

// --- shared plumbing -------------------------------------------------------

// Effective trove figures: recorded struct + pending redistribution rewards.
async function effectiveTrove(tm, who) {
  const debt = (await tm.getTroveDebt(who)) + (await tm.getPendingLUSDDebtReward(who));
  const coll = (await tm.getTroveColl(who)) + (await tm.getPendingETHReward(who));
  return { debt, coll };
}

async function openTroveOn(f, signer, collEth, wstEth, debt) {
  if (f.wstETH) {
    await f.wstETH.connect(signer).faucet(E(wstEth));
    await f.wstETH.connect(signer).approve(await f.bo.getAddress(), ethers.MaxUint256);
    await f.bo.connect(signer).openTrove(MAX_FEE, E(debt), E(wstEth), Z, Z);
  } else {
    await f.bo.connect(signer).openTrove(MAX_FEE, E(debt), Z, Z, { value: E(collEth) });
  }
}

// All conservation invariants, on one branch. `label` names the failing step.
async function conservation(f, label) {
  const { tm, ap, dp, orUSD, sp, sorted } = f;

  // Walk the sorted list once.
  const rows = [];
  let cur = await sorted.getFirst();
  while (cur !== Z) {
    const eff = await effectiveTrove(tm, cur);
    const status = (await tm.Troves(cur))[3];
    rows.push({ who: cur, ...eff, status });
    cur = await sorted.getNext(cur);
  }
  const open = rows.filter(r => r.status === ACTIVE);

  const apDebt = await ap.getLUSDDebt(), dpDebt = await dp.getLUSDDebt();
  const apColl = await ap.getETH(), dpColl = await dp.getETH();

  // 1. Token accounting: every orUSD in existence is a claim on recorded
  //    system debt (borrower wallets, GasPool, SP and staking fee wallets).
  expect(await orUSD.totalSupply(), `${label}: orUSD supply != AP+DP debt`)
    .to.equal(apDebt + dpDebt);

  // 2. Debt conservation to sub-dust precision.
  const debtSum = open.reduce((a, r) => a + r.debt, 0n);
  expect(debtSum - (apDebt + dpDebt), `${label}: |Σ trove debt - system debt| > dust`)
    .to.be.at.most(DEBT_DUST);

  // 3. Collateral conservation to sub-dust precision.
  const collSum = open.reduce((a, r) => a + r.coll, 0n);
  expect(collSum - (apColl + dpColl), `${label}: |Σ trove coll - system coll| > dust`)
    .to.be.at.most(DEBT_DUST);

    // 4. SP collateral backing: everything the SP holds is a depositor gain.
  if (f.depositors?.length) {
    let gains = 0n;
    for (const d of f.depositors) gains += await sp.getDepositorETHGain(d.address);
    const spColl = f.wstETH
      ? await f.wstETH.balanceOf(await sp.getAddress())
      : await ethers.provider.getBalance(await sp.getAddress());
    expect(spColl - gains, `${label}: SP collateral != Σ depositor gains`).to.be.at.most(SP_DUST);
  }
}

// Cross-branch state equality after a shared op (debt/ICR/TCR are
// denomination-free; collateral raw units differ by the 6:5 parity choice).
async function equality(f1, f2, label, tracked) {
  await f1.feed.fetchPrice();
  await f2.feed.fetchPrice();
  const p1 = await f1.feed.getPrice(), p2 = await f2.feed.getPrice();

  const tcr1 = await f1.tm.getTCR(p1), tcr2 = await f2.tm.getTCR(p2);
  expect(tcr1, `${label}: TCR diverged (${tcr1} vs ${tcr2})`).to.equal(tcr2);

  for (const who of tracked) {
    const e1 = await effectiveTrove(f1.tm, who);
    const e2 = await effectiveTrove(f2.tm, who);
    expect(e1.debt, `${label}: debt diverged for ${who}`).to.equal(e2.debt);
    expect(e1.coll * p1, `${label}: collateral VALUE diverged for ${who}`)
      .to.equal(e2.coll * p2);
  }
  expect(await f1.sp.getTotalLUSDDeposits(), `${label}: SP deposits diverged`)
    .to.equal(await f2.sp.getTotalLUSDDeposits());
  expect(await f1.orUSD.totalSupply(), `${label}: orUSD supply diverged`)
    .to.equal(await f2.orUSD.totalSupply());
}

// Set the ETH/USD answer on both branches' aggregators (8-dec Chainlink).
async function setUsd(f1, f2, usd) {
  const answer = BigInt(Math.round(usd * 1e8));
  await f1.agg.setAnswer(answer);
  if (f2) await f2.agg.setAnswer(answer);
}

// Extract the revert reason from a Hardhat/ethers error (transaction errors
// embed it in the message; staticCall errors expose revert data instead).
function reason(e) {
  const msg = String(e.message || "");
  let m = msg.match(/reverted with reason string '([^']*)'/);
  if (m) return m[1];
  m = msg.match(/reverted with panic code (0x[0-9a-f]+)/i);
  if (m) return "panic " + m[1].toLowerCase();
  return e.shortMessage || e.code || "unknown";
}

// Replay one op on both branches; assert parity of outcome (including the
// revert reason — Tier 2 keeps upstream revert strings, so a divergence is a
// behavioral delta that must be explained, not silenced).
async function parity(f1, f2, op, label) {
  const r1 = await op(f1).then(() => null, e => e);
  const r2 = await op(f2).then(() => null, e => e);
  if (!r1 && !r2) return { ok: true };
  if (r1 && r2) {
    const m1 = reason(r1);
    const m2 = reason(r2);
    expect(m2, `${label}: revert divergence (${m1} vs ${m2})`).to.equal(m1);
    return { ok: false };
  }
  expect.fail(`${label}: outcome divergence — ${r1 ? "v1 reverted" : "v2 reverted"} `
    + `(${reason(r1 || r2)})`);
}

// ---------------------------------------------------------------------------
describe("differential: v1 ETH branch vs Tier-2 ERC20 branch", () => {
  it("identical scripted sequences keep both engines in lock-step", async () => {
    const f1 = await loadFixture(ethFixture);
    const f2 = await loadFixture(v2Fixture);
    const { alice, bob, carol, deployer } = f1;
    const tracked = [alice.address, bob.address, carol.address];
    f1.depositors = [alice]; f2.depositors = [alice];

    const step = (name, fn) => ({ name, fn });

    const script = [
      step("whale open 120 ETH / 100 wstETH, 40k", f =>
        openTroveOn(f, f.alice, "120", "100", "40000")),
      step("bob open 12 ETH / 10 wstETH, 15k", f =>
        openTroveOn(f, f.bob, "12", "10", "15000")),
      step("carol open 12 ETH / 10 wstETH, 8k", f =>
        openTroveOn(f, f.carol, "12", "10", "8000")),
      step("alice SP deposit 30k", async f => {
        await f.orUSD.connect(f.alice).approve(await f.sp.getAddress(), ethers.MaxUint256);
        await f.sp.connect(f.alice).provideToSP(E("30000"), Z);
      }),
      step("bob addColl 3 ETH / 2.5 wstETH", async f => {
        if (f.wstETH) {
          await f.wstETH.connect(f.bob).faucet(E("2.5"));
          await f.bo.connect(f.bob).adjustTrove(MAX_FEE, E("2.5"), 0, 0, false, Z, Z);
        } else {
          await f.bo.connect(f.bob).adjustTrove(MAX_FEE, 0, 0, false, Z, Z, { value: E("3") });
        }
      }),
      step("carol repay 2000", f =>
        f.wstETH
          ? f.bo.connect(f.carol).adjustTrove(MAX_FEE, 0, 0, E("2000"), false, Z, Z)
          : f.bo.connect(f.carol).adjustTrove(MAX_FEE, 0, E("2000"), false, Z, Z)),
      step("bob withdraw 1.2 ETH / 1 wstETH", f =>
        f.wstETH
          ? f.bo.connect(f.bob).adjustTrove(MAX_FEE, 0, E("1"), 0, false, Z, Z)
          : f.bo.connect(f.bob).adjustTrove(MAX_FEE, E("1.2"), 0, false, Z, Z)),
      step("carol borrow +500", f =>
        f.wstETH
          ? f.bo.connect(f.carol).adjustTrove(MAX_FEE, 0, 0, E("500"), true, Z, Z)
          : f.bo.connect(f.carol).adjustTrove(MAX_FEE, 0, E("500"), true, Z, Z)),
      step("price 2000 -> 1600", f => setUsd(f, null, 1600)),
      step("price 1600 -> 1100 (bob < 105%)", f => setUsd(f, null, 1100)),
      step("full liquidation of bob", async f =>
        f.tm.connect(f.deployer).liquidate(f.bob.address)),
      step("price 1100 -> 1400 recovery", f => setUsd(f, null, 1400)),
    ];

    for (const { name, fn } of script) {
      if (name.startsWith("price")) {
        await fn(f1); await fn(f2); // price steps act on each branch's own aggregator
        continue;
      }
      await parity(f1, f2, fn, name);
      await conservation(f1, name);
      await conservation(f2, name);
      await equality(f1, f2, name, tracked);
    }

    // The liquidation itself must have closed bob identically on both.
    for (const f of [f1, f2]) {
      const status = (await f.tm.Troves(f.bob.address))[3];
      expect(status, `${f.wstETH ? "v2" : "v1"}: bob not closed by liquidation`)
        .to.equal(CLOSED_BY_LIQUIDATION);
    }
    // SP absorbed the liquidation on both branches (30k deposits >> 15.1k debt).
    expect(await f1.sp.getTotalLUSDDeposits()).to.be.below(E("30000"));
    expect(await f1.sp.getTotalLUSDDeposits()).to.equal(await f2.sp.getTotalLUSDDeposits());
  });

  it("identical RANDOM sequences stay in lock-step (seeded, 60 ops)", async () => {
    const f1 = await loadFixture(ethFixture);
    const f2 = await loadFixture(v2Fixture);
    const { alice, bob, carol } = f1;
    const tracked = [alice.address, bob.address, carol.address];
    f1.depositors = [alice]; f2.depositors = [alice];

    // Genesis state: whale + two mid troves + SP cover (all 6:5 parity).
    for (const f of [f1, f2]) {
      await openTroveOn(f, f.alice, "120", "100", "40000");
      await openTroveOn(f, f.bob, "12", "10", "15000");
      await openTroveOn(f, f.carol, "12", "10", "8000");
      await f.orUSD.connect(f.alice).approve(await f.sp.getAddress(), ethers.MaxUint256);
      await f.sp.connect(f.alice).provideToSP(E("30000"), Z);
    }
    await conservation(f1, "genesis"); await conservation(f2, "genesis");
    await equality(f1, f2, "genesis", tracked);

    const next = rng(0xd1ffe2e5); // differential-seed
    let usd = 2000;
    let succeeded = 0, revertedInLockStep = 0;
    for (let i = 0; i < 60; i++) {
      const who = [bob, carol][Number(next() % 2n)];
      const kind = Number(next() % 7n);
      // 0.6-ETH steps (exact integer wei; no float math) keep the 6:5
      // collateral conversion exact.
      const amt = BigInt(6 * (1 + Number(next() % 5n))) * 10n ** 17n; // 0.6..3.0
      let op;
      switch (kind) {
        case 0: // add collateral, 6 ETH : 5 wstETH (faucet fresh wstETH first)
          op = f => f.wstETH
            ? (async () => {
                await f.wstETH.connect(who).faucet(amt * 5n / 6n);
                await f.bo.connect(who).adjustTrove(MAX_FEE, amt * 5n / 6n, 0, 0, false, Z, Z);
              })()
            : f.bo.connect(who).adjustTrove(MAX_FEE, 0, 0, false, Z, Z, { value: amt });
          break;
        case 1: // withdraw collateral (value-parity amounts)
          op = f => f.wstETH
            ? f.bo.connect(who).adjustTrove(MAX_FEE, 0, amt * 5n / 6n, 0, false, Z, Z)
            : f.bo.connect(who).adjustTrove(MAX_FEE, amt, 0, false, Z, Z);
          break;
        case 2: // borrow more
          op = f => f.wstETH
            ? f.bo.connect(who).adjustTrove(MAX_FEE, 0, 0, amt * 100n, true, Z, Z)
            : f.bo.connect(who).adjustTrove(MAX_FEE, 0, amt * 100n, true, Z, Z);
          break;
        case 3: // repay
          op = f => f.wstETH
            ? f.bo.connect(who).adjustTrove(MAX_FEE, 0, 0, amt * 100n, false, Z, Z)
            : f.bo.connect(who).adjustTrove(MAX_FEE, 0, amt * 100n, false, Z, Z);
          break;
        case 4: // SP deposit
          op = f => f.sp.connect(who).provideToSP(amt * 10n, Z);
          break;
        case 5: // SP withdrawal
          op = f => f.sp.connect(who).withdrawFromSP(amt * 10n);
          break;
        default: { // price wiggle ≤5%, clamped to [800, 2600]
          const pct = (Number(next() % 11n) - 5) / 100;
          usd = Math.min(2600, Math.max(800, usd * (1 + pct)));
          op = f => f.agg.setAnswer(BigInt(Math.round(usd * 1e8)));
        }
      }
      const label = `op#${i} kind=${kind} who=${who === bob ? "bob" : "carol"} amt=${amt}`;
      const r = await parity(f1, f2, op, label);
      if (r.ok) succeeded++; else revertedInLockStep++;
      await conservation(f1, label); await conservation(f2, label);
      await equality(f1, f2, label, tracked);
      if (!r.ok) continue; // reverted identically on both: nothing to compare
    }
    // Guard against a vacuous suite: the menu must actually exercise both
    // engines (and revert-parity must be observed too, but not dominate).
    expect(succeeded, "differential fuzz degraded: too few ops succeeded").to.be.at.least(25);
    expect(revertedInLockStep, "differential fuzz: expected some identical reverts").to.be.at.least(3);
  });
});

// ---------------------------------------------------------------------------
describe("soft liquidation exactness (Tier-2 TroveManagerV2)", () => {
  it("liquidatePartial restores the trove to exactly MCR and conserves everything", async () => {
    const f = await loadFixture(v2Fixture);
    const { alice, bob, carol, deployer } = f;
    f.depositors = [alice];

    // Whale anchors TCR far above CCR; bob sits at ~148% ICR.
    await openTroveOn(f, alice, null, "100", "40000");
    await openTroveOn(f, bob, null, "2.5", "4000");
    await f.orUSD.connect(alice).approve(await f.sp.getAddress(), ethers.MaxUint256);
    await f.sp.connect(alice).provideToSP(E("10000"), Z);
    await conservation(f, "genesis");

    const MCR = await f.tm.MCR();
    const PREMIUM = await f.tm.SOFT_LIQ_PREMIUM();
    const FLOOR = await f.tm.SOFT_LIQ_FLOOR();
    const MIN_NET_DEBT = await f.tm.MIN_NET_DEBT();
    const GAS_COMP = await f.tm.LUSD_GAS_COMPENSATION();

    // Compute the exact ETH/USD answer that lands bob in the middle of the
    // soft band [FLOOR, MCR), from his OBSERVED debt (robust to the branch's
    // fee/gas-comp schedule). wstETH price = ETH/USD × 1.2 (mock rate), and
    // the aggregator is 8-decimals: answer = wstPrice / 1.2 / 1e10.
    const bobEff = await effectiveTrove(f.tm, bob.address);
    const targetIcr = (FLOOR + MCR) / 2n;
    const wstPrice = targetIcr * bobEff.debt / bobEff.coll;   // 18-dec
    const answer = wstPrice * 10n ** 18n / (12n * 10n ** 17n) / 10n ** 10n;
    await f.agg.setAnswer(answer);
    await f.feed.fetchPrice();
    const price = await f.feed.getPrice();

    const before = await effectiveTrove(f.tm, bob.address);
    const icrBefore = before.coll * price / before.debt;
    expect(icrBefore).to.be.at.least(FLOOR);
    expect(icrBefore).to.be.below(MCR);

    // Integer mirror of the on-chain formula (TroveManagerV2.liquidatePartial).
    const debtToOffset = before.debt * (MCR - icrBefore) / (MCR - PREMIUM);
    const remainingDebt = before.debt - debtToOffset;
    const collSeized = debtToOffset * PREMIUM / price;
    const collToLiquidator = collSeized / 200n;
    const expectedColl = before.coll - collSeized;

    await expect(f.tm.connect(carol).liquidatePartial(bob.address))
      .to.emit(f.tm, "TroveSoftLiquidated");

    // --- the documented property: restored to exactly MCR (up to integer
    // rounding, never below).
    const after = await effectiveTrove(f.tm, bob.address);
    const icrAfter = after.coll * price / after.debt;
    expect(after.debt, "soft-liq: debt != mirror").to.equal(remainingDebt);
    expect(after.coll, "soft-liq: coll != mirror").to.equal(expectedColl);
    expect(icrAfter, "soft-liq: ICR != mirror")
      .to.equal(expectedColl * price / remainingDebt);
    expect(icrAfter, "soft-liq: restored below MCR").to.be.at.least(MCR);
    expect(icrAfter - MCR, "soft-liq: restored more than dust above MCR")
      .to.be.at.most(icrAfter / ICR_REL_DUST + 1n);
    expect(remainingDebt, "soft-liq: remainder below MIN_NET_DEBT+comp")
      .to.be.at.least(MIN_NET_DEBT + GAS_COMP);

    // --- SP absorbed the offset exactly; the caller got the 0.5% incentive.
    expect(await f.sp.getTotalLUSDDeposits(), "soft-liq: SP debt burn mismatch")
      .to.equal(E("10000") - debtToOffset);
    const spCollAfter = await f.wstETH.balanceOf(await f.sp.getAddress());
    expect(spCollAfter, "soft-liq: SP collateral gain mismatch")
      .to.equal(collSeized - collToLiquidator);
    expect(await f.wstETH.balanceOf(carol.address), "soft-liq: liquidator incentive mismatch")
      .to.equal(collToLiquidator);

    // --- the trove is still open, still in the sorted list, above MCR.
    const status = (await f.tm.Troves(bob.address))[3];
    expect(status).to.equal(ACTIVE);
    expect(await f.sorted.contains(bob.address)).to.equal(true);
    expect(await f.sorted.getSize()).to.equal(2n);

    // --- conservation still holds branch-wide.
    await conservation(f, "after soft-liq");

    // --- idempotence guard: a second soft liquidation must revert (ICR == MCR).
    await expect(f.tm.connect(deployer).liquidatePartial(bob.address)).to.be.reverted;
  });
});
