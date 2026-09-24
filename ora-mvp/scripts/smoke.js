// End-to-end smoke test for BOTH branches, through the app's RPC proxy.
const { ethers } = require("ethers");
const dep = require("../app/deployment.json");

const RPC = "http://127.0.0.1:3000/rpc";
const KEYS = {
  alice: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  carol: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  treasury: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"
};
const Z = ethers.ZeroAddress;
const E = ethers.parseEther;
const f = v => Number(ethers.formatEther(v)).toFixed(2);

async function main() {
  // cacheTimeout -1: disable ethers' 250ms request cache — rapid sequential
  // txs otherwise refetch stale nonces after a NonceManager.reset()
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
  const alice = new ethers.NonceManager(new ethers.Wallet(KEYS.alice, provider));
  const carol = new ethers.NonceManager(new ethers.Wallet(KEYS.carol, provider));
  const treasury = new ethers.NonceManager(new ethers.Wallet(KEYS.treasury, provider));
  const aliceAddr = await alice.getAddress();

  const usd = new ethers.Contract(dep.shared.orUSDToken, dep.abis.orUSDToken, provider);
  console.log("orUSD:", await usd.name(), "| branch registrar:", await usd.branchRegistrar());

  // ===== Branch 1: native ETH sanity =====
  const B1 = dep.branches.ETH;
  const bo1 = new ethers.Contract(B1.borrowerOperations, dep.abis.borrowerOperations, alice);
  await (await bo1.openTrove(E("0.05"), E("4000"), Z, Z, { value: E("5") })).wait();
  console.log("[ETH] Alice opened trove — orUSD:", f(await usd.balanceOf(aliceAddr)));

  // ===== Branch 2: wstETH lifecycle =====
  const B2 = dep.branches.wstETH;
  const wst = new ethers.Contract(B2.collToken, dep.abis.mockWstETH, alice);
  const bo2 = new ethers.Contract(B2.borrowerOperations, dep.abis.borrowerOperationsERC20, alice);
  const sp2 = new ethers.Contract(B2.stabilityPool, dep.abis.stabilityPoolERC20, alice);
  const tm2 = new ethers.Contract(B2.troveManager, dep.abis.troveManagerV2, carol);
  const pf1 = new ethers.Contract(dep.branches.ETH.priceFeed, dep.abis.priceFeed, provider);
  const pf2 = new ethers.Contract(B2.priceFeed, dep.abis.priceFeedWstETH, treasury);
  const aggRate = new ethers.Contract(B2.stEthEthAggregator, dep.abis.settableAggregator, treasury);

  // oracle adapters sanity
  console.log("[oracle] ETH/USD:", f(await pf1.getPrice()), "| wstETH/USD:", f(await pf2.getPrice()),
    "| oracleLive:", await pf2.oracleLive());

  // faucet + approve + open trove
  await (await wst.faucet(E("10"))).wait();
  await (await wst.approve(B2.borrowerOperations, ethers.MaxUint256)).wait();
  await (await bo2.openTrove(E("0.05"), E("6000"), E("6"), Z, Z)).wait();
  console.log("[wstETH] Alice opened trove: 6 wstETH / 6000 orUSD — orUSD bal:", f(await usd.balanceOf(aliceAddr)));

  // adjust: add collateral + repay
  await (await bo2.addColl(E("1"), Z, Z)).wait();
  await (await bo2.repayLUSD(E("500"), Z, Z)).wait();
  const ent = await tm2.getEntireDebtAndColl(aliceAddr);
  console.log("[wstETH] after adjust — coll:", f(ent[1]), "debt:", f(ent[0]));

  // SP deposit
  await (await sp2.provideToSP(E("3000"), Z)).wait();
  console.log("[wstETH] Alice SP deposit:", f(await sp2.getCompoundedLUSDDeposit(aliceAddr)));

  // DEPEG: stETH/ETH market rate crashes to 0.80 -> circuit breaker trips,
  // wstETH/USD reprices to 2000 * 0.80 * 1.2 = $1920
  await (await aggRate.setAnswer(E("0.8"))).wait();
  await (await pf2.fetchPrice()).wait();
  console.log("[depeg] rate 0.80 — circuit breaker active:", await pf2.depegged(),
    "| wstETH/USD:", f(await pf2.getPrice()));
  const victim = "0x71bE63f3384f5fb98995898A86B02Fb2426c5788"; // signer 11
  const icr = await tm2.getCurrentICR(victim, E("1920"));
  console.log("[wstETH] victim ICR at depegged price:", (Number(icr) / 1e16).toFixed(1) + "%");
  await (await tm2.liquidate(victim)).wait();
  console.log("[wstETH] liquidated! Alice SP wstETH gain:", f(await sp2.getDepositorETHGain(aliceAddr)));

  // withdraw gains (moves wstETH to Alice's wallet)
  await (await sp2.withdrawFromSP(E("0"))).wait();
  console.log("[wstETH] Alice wstETH balance after claiming:", f(await wst.balanceOf(aliceAddr)));

  // cross-branch: orUSD minted on wstETH branch repays ETH-branch trove
  await (await bo1.repayLUSD(E("1000"), Z, Z)).wait();
  console.log("[cross] repaid 1000 orUSD (minted on wstETH branch) into ETH-branch trove ✓");

  // restore peg -> circuit breaker resets
  await (await aggRate.setAnswer(E("1"))).wait();
  await (await pf2.fetchPrice()).wait();
  console.log("[depeg] peg restored — circuit breaker active:", await pf2.depegged(),
    "| wstETH/USD:", f(await pf2.getPrice()));
  console.log("[wstETH] branch TCR:", (Number(await tm2.getTCR(E("2400"))) / 1e16).toFixed(1) + "%");

  // STALENESS: age the stETH/ETH round past the 48h timeout -> fallback to lastGoodPrice
  await (await aggRate.makeStale(60 * 3600)).wait();
  await (await pf2.fetchPrice()).wait();
  console.log("[stale] feed aged 60h — oracleLive:", await pf2.oracleLive(),
    "| price falls back to lastGoodPrice:", f(await pf2.getPrice()));
  await (await aggRate.setAnswer(E("1"))).wait();
  await (await pf2.fetchPrice()).wait();
  console.log("[stale] feed refreshed — oracleLive:", await pf2.oracleLive());

  // ===== PHASE 2 =====

  // --- 2a. SP depositors on the wstETH branch earn ORA (BranchCommunityIssuance) ---
  const ora = new ethers.Contract(dep.shared.oraToken, dep.abis.oraToken, alice);
  await provider.send("evm_increaseTime", [3600]);
  await provider.send("evm_mine", []);
  const oraBefore = await ora.balanceOf(aliceAddr);
  await (await sp2.provideToSP(E("10"), Z)).wait(); // any SP op triggers issuance + pays accrued ORA
  const oraGain = await ora.balanceOf(aliceAddr) - oraBefore;
  console.log("[phase2] Alice SP ORA reward paid after 1h:", f(oraGain));
  if (oraGain === 0n) throw new Error("expected ORA gain for SP depositor");

  // --- 2b. BranchStaking: stake ORA, earn wstETH-branch fees ---
  const staking = new ethers.Contract(B2.branchStaking, dep.abis.branchStaking, alice);
  await (await ora.connect(treasury).transfer(aliceAddr, E("100"))).wait();
  await (await ora.approve(B2.branchStaking, ethers.MaxUint256)).wait();
  await (await staking.stake(E("100"))).wait();
  console.log("[phase2] Alice staked 100 ORA — total staked:", f(await staking.totalLQTYStaked()));
  await (await bo2.withdrawLUSD(E("0.05"), E("500"), Z, Z)).wait(); // borrow fee flows to BranchStaking
  const usdGain = await staking.getPendingLUSDGain(aliceAddr);
  console.log("[phase2] pending orUSD fee gain from borrow:", f(usdGain));
  if (usdGain === 0n) throw new Error("expected orUSD fee gain for staker");
  const usdBefore = await usd.balanceOf(aliceAddr);
  await (await staking.unstake(E("100"))).wait();
  console.log("[phase2] unstaked — orUSD fee claimed:", f(await usd.balanceOf(aliceAddr) - usdBefore),
    "| ORA back:", f(await ora.balanceOf(aliceAddr)));

  // --- 2c. Soft liquidation: partial offset restores trove to 110% at only a 3% premium ---
  const aggEth = new ethers.Contract(B2.ethUsdAggregator, dep.abis.settableAggregator, treasury);
  const wstC = wst.connect(carol);
  const bo2C = bo2.connect(carol);
  await (await wstC.faucet(E("2.3"))).wait();
  await (await wstC.approve(B2.borrowerOperations, ethers.MaxUint256)).wait();
  await (await bo2C.openTrove(E("0.05"), E("4700"), E("2.3"), Z, Z)).wait();
  const carolAddr = await carol.getAddress();
  console.log("[softliq] Carol trove: 2.3 wstETH / debt", f((await tm2.getEntireDebtAndColl(carolAddr))[0]),
    "— ICR:", (Number(await tm2.getCurrentICR(carolAddr, E("2400"))) / 1e16).toFixed(1) + "%");

  // ETH dips $2000 -> $1908, wstETH/USD = 1908 * 1.2 = $2289.60; Carol lands in the soft band [105%,110%)
  await (await aggEth.setAnswer(1908n * 10n ** 8n)).wait();
  await (await pf2.fetchPrice()).wait();
  const px = await pf2.getPrice();
  const icrBefore = await tm2.getCurrentICR(carolAddr, px);
  console.log("[softliq] ETH -> $1908 | wstETH/USD:", f(px),
    "| Carol ICR:", (Number(icrBefore) / 1e16).toFixed(2) + "%",
    "| branch TCR:", (Number(await tm2.getTCR(px)) / 1e16).toFixed(1) + "%");

  const wstBefore = await wst.balanceOf(aliceAddr);
  await (await tm2.connect(alice).liquidatePartial(carolAddr)).wait();
  const after = await tm2.getEntireDebtAndColl(carolAddr);
  const icrAfter = await tm2.getCurrentICR(carolAddr, px);
  console.log("[softliq] partial liquidation ✓ — Carol still active:", (await tm2.getTroveStatus(carolAddr)) === 1n,
    "| debt:", f(after[0]), "| coll:", f(after[1]),
    "| ICR restored to:", (Number(icrAfter) / 1e16).toFixed(2) + "%");
  const callerReward = await wst.balanceOf(aliceAddr) - wstBefore;
  console.log("[softliq] Alice caller reward (0.5% of seized coll):", Number(ethers.formatEther(callerReward)).toFixed(4), "wstETH");
  if ((await tm2.getTroveStatus(carolAddr)) !== 1n) throw new Error("trove should stay active");
  if (icrAfter < 1099000000000000000n) throw new Error("ICR not restored to ~110%");
  if (callerReward === 0n) throw new Error("expected caller reward");

  // restore ETH price
  await (await aggEth.setAnswer(2000n * 10n ** 8n)).wait();
  await (await pf2.fetchPrice()).wait();
  console.log("[softliq] ETH price restored to $2000");

  // ===== PHASE 4: RWA branch (mTBILL) =====
  alice.reset(); carol.reset(); treasury.reset(); // resync NonceManagers after the long Phase 2 run
  const B3 = dep.branches.tBILL;
  const tb = new ethers.Contract(B3.collToken, dep.abis.mockTBill, alice);
  const bo3 = new ethers.Contract(B3.borrowerOperations, dep.abis.borrowerOperationsERC20, alice);
  const sp3 = new ethers.Contract(B3.stabilityPool, dep.abis.stabilityPoolERC20, alice);
  const tm3 = new ethers.Contract(B3.troveManager, dep.abis.troveManagerV2, alice);
  const pf3 = new ethers.Contract(B3.priceFeed, dep.abis.priceFeedRWA, treasury);
  const aggNav = new ethers.Contract(B3.navAggregator, dep.abis.settableAggregator, treasury);

  console.log("[rwa] mTBILL NAV:", f(await pf3.getPrice()), "| debt cap:", f(await bo3.debtCap()),
    "| branch TCR:", (Number(await tm3.getTCR(await pf3.getPrice())) / 1e16).toFixed(1) + "%");

  // open an RWA trove + join the RWA Stability Pool
  await (await tb.faucet(E("20000"))).wait();
  await (await tb.approve(B3.borrowerOperations, ethers.MaxUint256)).wait();
  await (await bo3.openTrove(E("0.05"), E("10000"), E("20000"), Z, Z)).wait();
  await (await sp3.provideToSP(E("2000"), Z)).wait();
  console.log("[rwa] Alice: 20,000 mTBILL / 10,000 orUSD trove + 2,000 orUSD SP deposit");

  // --- 4a. Debt cap: the branch can NEVER mint past its ceiling ---
  const tbC = tb.connect(carol), bo3C = bo3.connect(carol);
  for (let i = 0; i < 24; i++) await (await tbC.faucet(E("100000"))).wait();
  await (await tbC.approve(B3.borrowerOperations, ethers.MaxUint256)).wait();
  let capBlocked = false;
  try {
    await (await bo3C.openTrove(E("0.05"), E("1700000"), E("2400000"), Z, Z)).wait();
  } catch (e) { capBlocked = true; carol.reset(); }
  if (!capBlocked) throw new Error("debt cap should have blocked a 1.7M borrow");
  console.log("[rwa] 1.7M orUSD borrow rejected — branch debt cap enforced ✓");
  await (await bo3C.openTrove(E("0.05"), E("1500000"), E("2400000"), Z, Z)).wait();
  console.log("[rwa] 1.5M orUSD borrow accepted (under cap) — total branch debt:",
    f(await tm3.getEntireSystemDebt()), "/ cap", f(await bo3.debtCap()));

  // --- 4b. NAV lifecycle: yield accrual, manipulation clamp, break-the-buck shock ---
  alice.reset(); carol.reset(); treasury.reset();
  await (await aggNav.setAnswer(105420000n)).wait(); // +0.4% — a month of T-bill yield
  await (await pf3.fetchPrice()).wait();
  console.log("[rwa] NAV accrual +0.4% — price:", f(await pf3.getPrice()), "| navShock:", await pf3.navShock());

  await (await aggNav.setAnswer(120000000n)).wait(); // manipulated +14% spike
  await (await pf3.fetchPrice()).wait();
  const clamped = await pf3.lastGoodPrice();
  console.log("[rwa] NAV spike to $1.20 — clamped to:", f(clamped), "(+2% max per update) ✓");
  if (clamped > E("1.0754")) throw new Error("upside clamp failed");
  await (await aggNav.setAnswer(105420000n)).wait(); // honest NAV returns
  await (await pf3.fetchPrice()).wait();

  // break the buck: NAV drops 3% below the high-water mark
  treasury.reset(); alice.reset();
  await (await aggNav.setAnswer(102257000n)).wait();
  await (await pf3.fetchPrice()).wait();
  const shockPrice = await pf3.lastGoodPrice();
  console.log("[rwa] NAV shock -3% — price marked down:", f(shockPrice), "| navShock:", await pf3.navShock());
  if (!(await pf3.navShock())) throw new Error("navShock flag should be active");

  // --- 4c. Soft liquidation on the RWA branch (bait trove drops into the band) ---
  const bait = "0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097"; // signer 14
  const baitIcr = await tm3.getCurrentICR(bait, shockPrice);
  console.log("[rwa] bait trove ICR after shock:", (Number(baitIcr) / 1e16).toFixed(2) + "%");
  const tbBefore = await tb.balanceOf(aliceAddr);
  await (await tm3.liquidatePartial(bait)).wait();
  console.log("[rwa] soft-liquidated — ICR restored to:",
    (Number(await tm3.getCurrentICR(bait, shockPrice)) / 1e16).toFixed(2) + "%",
    "| caller reward:", Number(ethers.formatEther(await tb.balanceOf(aliceAddr) - tbBefore)).toFixed(2), "mTBILL");

  // --- 4d. RWA SP depositors earn ORA (own 500k allocation) ---
  await provider.send("evm_increaseTime", [3600]);
  await provider.send("evm_mine", []);
  const oraBefore3 = await ora.balanceOf(aliceAddr);
  await (await sp3.provideToSP(E("10"), Z)).wait();
  const oraGain3 = await ora.balanceOf(aliceAddr) - oraBefore3;
  console.log("[rwa] Alice SP ORA reward after 1h:", f(oraGain3));
  if (oraGain3 === 0n) throw new Error("expected ORA gain for RWA SP depositor");

  // NAV recovers — shock flag clears through the +2% ratchet
  await (await aggNav.setAnswer(105420000n)).wait();
  await (await pf3.fetchPrice()).wait();
  await (await pf3.fetchPrice()).wait();
  console.log("[rwa] NAV recovered — price:", f(await pf3.getPrice()), "| navShock:", await pf3.navShock());
  if (await pf3.navShock()) throw new Error("navShock should clear after recovery");

  console.log("\nPHASE 1.5 + 2 + 4 SMOKE TEST PASSED ✓");
}

main().catch(e => { console.error("SMOKE TEST FAILED:", e.shortMessage || e.message); process.exit(1); });
