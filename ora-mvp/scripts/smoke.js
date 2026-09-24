// End-to-end smoke test through the app's RPC proxy (same path the browser uses).
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

  const bo = new ethers.Contract(dep.addresses.borrowerOperations, dep.abis.borrowerOperations, alice);
  const tm = new ethers.Contract(dep.addresses.troveManager, dep.abis.troveManager, carol);
  const sp = new ethers.Contract(dep.addresses.stabilityPool, dep.abis.stabilityPool, alice);
  const pf = new ethers.Contract(dep.addresses.priceFeed, dep.abis.priceFeed, treasury);
  const usd = new ethers.Contract(dep.addresses.orUSDToken, dep.abis.orUSDToken, provider);
  const ora = new ethers.Contract(dep.addresses.oraToken, dep.abis.oraToken, treasury);
  const stk = new ethers.Contract(dep.addresses.oraStaking, dep.abis.oraStaking, alice);

  console.log("orUSD token:", await usd.name(), "/", await usd.symbol());
  console.log("ORA token:  ", await ora.name(), "/", await ora.symbol());

  // 1. Alice opens a trove: 5 ETH, borrow 4000 orUSD
  await (await bo.openTrove(E("0.05"), E("4000"), Z, Z, { value: E("5") })).wait();
  console.log("1. Alice opened trove — orUSD balance:", f(await usd.balanceOf(await alice.getAddress())));

  // 2. Alice deposits 2000 orUSD to the Stability Pool
  await (await sp.provideToSP(E("2000"), Z)).wait();
  console.log("2. Alice SP deposit:", f(await sp.getCompoundedLUSDDeposit(await alice.getAddress())));

  // 3. Faucet: treasury sends Alice 100 ORA, Alice stakes it
  await (await ora.transfer(await alice.getAddress(), E("100"))).wait();
  await (await stk.stake(E("100"))).wait();
  console.log("3. Alice staked 100 ORA — stake:", f(await stk.stakes(await alice.getAddress())));

  // 4. Crash ETH 15% -> $1700; the 3 ETH / ~5000 debt trove goes under 110%
  await (await pf.setPrice(E("1700"))).wait();
  const victim = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f";
  const icr = await tm.getCurrentICR(victim, E("1700"));
  console.log("4. Price crashed to $1700 — victim ICR:", (Number(icr) / 1e16).toFixed(1) + "%");

  // 5. Carol liquidates
  await (await tm.liquidate(victim)).wait();
  console.log("5. Liquidated! Troves left:", (await tm.getTroveOwnersCount()).toString());
  console.log("   Alice SP ETH gain:", f(await sp.getDepositorETHGain(await alice.getAddress())), "ETH");
  console.log("   Alice SP ORA gain:", f(await sp.getDepositorLQTYGain(await alice.getAddress())), "ORA");
  console.log("   Alice staking orUSD fees:", f(await stk.getPendingLUSDGain(await alice.getAddress())));

  // 6. Restore price for the live demo
  await (await pf.setPrice(E("2000"))).wait();
  console.log("6. Price restored to $2000 — TCR:", (Number(await tm.getTCR(E("2000"))) / 1e16).toFixed(1) + "%");
  console.log("\nSMOKE TEST PASSED ✓");
}

main().catch(e => { console.error("SMOKE TEST FAILED:", e.shortMessage || e.message); process.exit(1); });
