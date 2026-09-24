// On-chain tests for the RWA parameter branch (MCR 105% + wmTBILL yield share)
// and the LeverZap one-click leverage flow. Run against a freshly seeded chain;
// POLLUTES STATE — hardhat_reset + redeploy + reseed afterwards.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethers, network } = hre;

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log(`  PASS  ${label}${extra ? " — " + extra : ""}`); }
  else { failed++; console.log(`  FAIL  ${label}${extra ? " — " + extra : ""}`); }
}
const F = ethers.formatEther;
const E = ethers.parseEther;

async function expectRevert(promise, label) {
  try { await (await promise).wait(); ok(false, label, "did NOT revert"); }
  catch (e) { ok(true, label, "reverted as expected"); }
}

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "deployment.json")));
  const signers = await ethers.getSigners();
  const Z = ethers.ZeroAddress;
  const maxFee = E("0.05");
  const B3 = dep.branches.tBILL, B4 = dep.branches.ETHv2;

  const wtbill = await ethers.getContractAt("WTBill", B3.collToken);
  const tbill = await ethers.getContractAt("MockTBill", B3.underlyingToken);
  const tm3 = await ethers.getContractAt("TroveManagerRWA", B3.troveManager);
  const bo3 = await ethers.getContractAt("BorrowerOperationsRWA", B3.borrowerOperations);
  const feed3 = await ethers.getContractAt("WTBillPriceFeed", B3.priceFeed);
  const aggNav = await ethers.getContractAt("SettableAggregator", B3.navAggregator);

  console.log("\n=== RWA branch: MCR 105% / CCR 115% ===");
  ok((await tm3.MCR()) === E("1.05"), "TroveManagerRWA.MCR = 1.05");
  ok((await tm3.CCR()) === E("1.15"), "TroveManagerRWA.CCR = 1.15");
  ok((await tm3.SOFT_LIQ_FLOOR()) === E("1.03"), "soft-liq floor = 1.03");
  // the wrapper rate decays continuously, so seconds after deploy the price is a hair under $1.05
  const p0 = await feed3.getPrice();
  ok(p0 > E("1.0498") && p0 <= E("1.05"), "composite price = NAV x rate ~ $1.05", `$${F(p0)}`);

  // A trove at ~107% ICR — impossible on the 110%-MCR branches, fine here
  const s19 = signers[19];
  await (await wtbill.connect(s19).faucet(E("10000"))).wait();
  await (await wtbill.connect(s19).approve(B3.borrowerOperations, ethers.MaxUint256)).wait();
  await (await bo3.connect(s19).openTrove(maxFee, E("9600"), E("10000"), Z, Z)).wait();
  const icr19 = await tm3.getCurrentICR(s19.address, p0);
  ok(icr19 < E("1.10") && icr19 >= E("1.05"), "opened trove between 105% and 110% ICR", `${(Number(icr19) / 1e16).toFixed(2)}%`);

  // Above MCR: not liquidatable (bait s14 sits ~106.8%)
  const s14 = signers[14];
  await expectRevert(tm3.connect(signers[0]).liquidate(s14.address), "liquidate at ~106.8% ICR reverts (MCR 105)");

  // NAV −2% -> bait drops into the [103%, 105%) soft band (a deeper drop would
  // leave too little remainder debt for a partial liq -> full liquidation path)
  await (await aggNav.setAnswer(102900000n)).wait(); // $1.029, 8 decimals
  const p1 = await feed3.fetchPrice.staticCall();
  const icr14 = await tm3.getCurrentICR(s14.address, p1);
  ok(icr14 < E("1.05") && icr14 >= E("1.03"), "NAV shock puts bait trove in soft band", `${(Number(icr14) / 1e16).toFixed(2)}%`);
  const debtBefore = (await tm3.getEntireDebtAndColl(s14.address))[0];
  await (await tm3.connect(signers[0]).liquidatePartial(s14.address)).wait();
  const [debtAfter, ,] = await tm3.getEntireDebtAndColl(s14.address);
  const icrAfter = await tm3.getCurrentICR(s14.address, p1);
  ok((await tm3.getTroveStatus(s14.address)) === 1n, "soft-liquidated trove stays ACTIVE");
  ok(debtAfter < debtBefore, "soft liquidation reduced debt", `${F(debtBefore)} -> ${F(debtAfter)}`);
  ok(icrAfter >= E("1.0499") && icrAfter <= E("1.0501"), "trove restored to exactly MCR (105%)", `${(Number(icrAfter) / 1e16).toFixed(3)}%`);
  await (await aggNav.setAnswer(105000000n)).wait(); // restore NAV

  console.log("\n=== wmTBILL yield share: 2%/yr skim to treasury ===");
  const rate0 = await wtbill.currentRate();
  ok(rate0 <= E("1") && rate0 > E("0.99999"), "wrapper rate ~1.0 shortly after deploy", F(rate0));
  await network.provider.send("evm_increaseTime", [180 * 24 * 3600]);
  await network.provider.send("evm_mine");
  const rate1 = await wtbill.currentRate();
  const expected = E("1") - (E("1") * 2n * 180n * 86400n) / (100n * 365n * 86400n);
  ok(rate1 >= expected - 10n ** 12n && rate1 <= expected + 10n ** 12n,
    "rate decayed ~2%/yr after 180d", `rate=${F(rate1)}`);

  await (await wtbill.settle()).wait();
  const skim = await wtbill.skimAccrued();
  const supply = await wtbill.totalSupply();
  ok(skim > 0n, "skim accrued in mTBILL", `${F(skim)} mTBILL on ${F(supply)} shares`);

  // Invariant: underlying custody = shares x rate + skimAccrued (faucet adds +1 wei dust per mint)
  const custody = await tbill.balanceOf(B3.collToken);
  const needed = (supply * (await wtbill.rate())) / E("1") + skim;
  ok(custody >= needed && custody - needed < 1000n, "custody invariant: balance = shares*rate + skim", `dust=${(custody - needed).toString()} wei`);

  const treasuryAddr = signers[4].address;
  const tBefore = await tbill.balanceOf(treasuryAddr);
  await (await wtbill.claimSkim()).wait();
  const tAfter = await tbill.balanceOf(treasuryAddr);
  ok(tAfter - tBefore >= skim, "claimSkim sends mTBILL to treasury", `+${F(tAfter - tBefore)} mTBILL`);
  ok((await wtbill.skimAccrued()) === 0n, "skimAccrued zeroed after claim");

  // Composite price now reflects the decayed rate. Refresh the NAV feed after
  // the warp and fetch twice: the +2%/fetch upside ratchet needs two steps to
  // climb back from the shock print ($1.029) to $1.05.
  await (await aggNav.setAnswer(105000000n)).wait();
  await (await feed3.fetchPrice()).wait();
  await (await feed3.fetchPrice()).wait();
  const p2 = await feed3.getPrice();
  const expP = (E("1.05") * (await wtbill.rate())) / E("1");
  ok(p2 >= expP - 10n ** 10n && p2 <= expP + 10n ** 10n, "composite price = NAV x decayed rate", `$${F(p2)}`);

  console.log("\n=== LeverZap: one-click leverage on ETHv2 ===");
  // refresh the ETH/USD aggregator after the 180d warp (Chainlink staleness)
  const aggEth = await ethers.getContractAt("SettableAggregator", B4.ethUsdAggregator);
  await (await aggEth.setAnswer(2000n * 10n ** 8n)).wait();

  const factory = await ethers.getContractAt("LeverZapFactory", B4.leverZapFactory);
  const pool = await ethers.getContractAt("OraSwapPool", B4.swapPool);
  const spotBefore = await pool.spotPrice();
  ok(spotBefore >= E("1990") && spotBefore <= E("2010"), "swap pool spot ~ $2000/ETH", `$${F(spotBefore)}`);

  const user = signers[19];
  await (await factory.connect(user).createZap()).wait();
  const zapAddr = await factory.zapOf(user.address);
  ok(zapAddr !== Z, "per-user zap deployed", zapAddr);
  const zap = await ethers.getContractAt("LeverZap", zapAddr);
  const tm4 = await ethers.getContractAt("TroveManagerRates", B4.troveManager);

  await expectRevert(zap.connect(signers[0]).leverOpen(E("0.05"), 6000, 6, { value: E("1") }),
    "non-owner cannot drive the zap");

  const ethBefore = await ethers.provider.getBalance(user.address);
  await (await zap.connect(user).leverOpen(E("0.05"), 6000, 6, { value: E("2") })).wait();
  const [debt, coll, zRate, status] = await zap.position();
  ok(status === 1n, "leveraged trove is active");
  ok(zRate === E("0.05"), "trove pays the chosen 5% rate");
  ok(coll >= E("3.5"), "2 ETH deposit levered to >= 3.5 ETH exposure", `coll=${F(coll)} ETH, debt=${F(debt)} orUSD`);
  const icrZap = await tm4.getCurrentICR(zapAddr, E("2000"));
  ok(icrZap > E("1.1"), "leveraged position above MCR", `${(Number(icrZap) / 1e16).toFixed(1)}%`);

  await (await zap.connect(user).leverClose()).wait();
  ok((await tm4.getTroveStatus(zapAddr)) !== 1n, "leverClose fully unwinds the trove");
  const ethAfter = await ethers.provider.getBalance(user.address);
  const back = ethAfter - ethBefore + E("2"); // net of the 2 ETH deposit
  ok(back >= E("1.5") && back <= E("2.1"), "ETH returned to owner (minus swap fees/slippage)", `${F(back)} of 2 ETH`);
  ok((await ethers.provider.getBalance(zapAddr)) === 0n && (await (await ethers.getContractAt("LUSDToken", dep.shared.orUSDToken)).balanceOf(zapAddr)) === 0n,
    "zap holds no leftover funds");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
