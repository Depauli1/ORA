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
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
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
  const tm2 = new ethers.Contract(B2.troveManager, dep.abis.troveManager, carol);
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

  console.log("\nPHASE 1.5 SMOKE TEST PASSED ✓");
}

main().catch(e => { console.error("SMOKE TEST FAILED:", e.shortMessage || e.message); process.exit(1); });
