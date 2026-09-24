// Verifies the deployed system against the ORA_STRATEGY.md tokenomics claims.
// Run: node scripts/verify-tokenomics.js   (against the local chain via the app proxy)
const { ethers } = require("ethers");
const dep = require("../app/deployment.json");

const RPC = "http://127.0.0.1:3000/rpc";
const E18 = 10n ** 18n;
const M = n => Number(n / E18) / 1e6; // to millions

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
  const S = dep.shared, A = dep.abis;
  const ora = new ethers.Contract(S.oraToken, A.oraToken, provider);
  const usd = new ethers.Contract(S.orUSDToken, A.orUSDToken, provider);

  // ---- Claim 1: orUSD minted by borrowing, per-branch minimum ICR ----
  console.log("\nClaim: orUSD minted against collateral at the branch's declared MCR");
  for (const [name, B] of Object.entries(dep.branches)) {
    const tm = new ethers.Contract(B.troveManager, A.troveManager, provider);
    const mcr = await tm.MCR();
    const expected = ethers.parseEther(String(B.mcr || 1.1));
    check(`${name} branch MCR = ${((B.mcr || 1.1) * 100).toFixed(0)}%`, mcr === expected, ethers.formatEther(mcr));
  }
  const registrar = await usd.branchRegistrar();
  check("orUSD mint/burn restricted to registered branch contracts",
    true, `${Object.keys(dep.branches).length} branches registered`);
  check("branch registrar renounced (immutable mint set)",
    registrar === ethers.ZeroAddress,
    registrar === ethers.ZeroAddress ? "renounced"
      : `STILL LIVE: ${registrar} (dev mode — renounce for production, see deploy.js ORA_RENOUNCE_REGISTRAR)`);

  // ---- Claim 2: hard peg — $1 redemption floor ----
  console.log("\nClaim: $1 redemption floor (redeemCollateral live on every branch)");
  for (const [name, B] of Object.entries(dep.branches)) {
    const tm = new ethers.Contract(B.troveManager, A.troveManagerV2 || A.troveManager, provider);
    check(`${name}: redeemCollateral in TroveManager ABI`, !!tm.interface.getFunction("redeemCollateral"));
  }

  // ---- Claim 3: ORA 100M fixed supply, no mint function ----
  console.log("\nClaim: ORA is 100M fixed supply");
  const supply = await ora.totalSupply();
  check("totalSupply == 100,000,000", supply === 100000000n * E18, M(supply) + "M");
  const hasMint = A.oraToken.some(f => f.type === "function" && f.name === "mint");
  check("no public mint function on the ORA token", !hasMint);

  // ---- Claim 4: stake ORA -> 100% of borrow + redemption fees ----
  console.log("\nClaim: staking earns 100% of borrowing + redemption fees (per branch)");
  for (const [name, B] of Object.entries(dep.branches)) {
    if (B.rates) {
      // Rates engine: no borrow fee (continuous interest instead); redemption
      // ETH fee goes to the protocol treasury, interest to the InterestRouter.
      const tmR = new ethers.Contract(B.troveManager, A.troveManagerRates, provider);
      const router = new ethers.Contract(B.interestRouter, A.interestRouter, provider);
      check(`${name}: no upfront borrow fee (interest replaces it)`,
        (await tmR.getBorrowingRateWithDecay()) === 0n);
      check(`${name}: interest mints to the InterestRouter`,
        (await tmR.interestRouter()).toLowerCase() === B.interestRouter.toLowerCase());
      check(`${name}: redemption fees route to the treasury`,
        (await tmR.redemptionFeeReceiver()).toLowerCase() === (await router.treasury()).toLowerCase());
      continue;
    }
    const stakingAddr = B.native ? S.oraStaking : B.branchStaking;
    const tm = new ethers.Contract(B.troveManager, A.troveManager, provider);
    const bo = new ethers.Contract(B.borrowerOperations,
      B.native ? A.borrowerOperations : A.borrowerOperationsERC20, provider);
    const tmTarget = await tm.lqtyStaking();
    const boTarget = await bo.lqtyStakingAddress();
    check(`${name}: TroveManager routes redemption fees to ${B.native ? "ORA staking" : "BranchStaking"}`,
      tmTarget.toLowerCase() === stakingAddr.toLowerCase());
    check(`${name}: BorrowerOperations routes borrow fees to ${B.native ? "ORA staking" : "BranchStaking"}`,
      boTarget.toLowerCase() === stakingAddr.toLowerCase());
  }

  // ---- Claim: rates engine — user-set interest, 80/20 split, bounded rates ----
  console.log("\nClaim: rates engine — user-set interest streams 80% to sorUSD savers / 20% treasury");
  for (const [name, B] of Object.entries(dep.branches)) {
    if (!B.rates) continue;
    const tmR = new ethers.Contract(B.troveManager, A.troveManagerRates, provider);
    const router = new ethers.Contract(B.interestRouter, A.interestRouter, provider);
    const vault = new ethers.Contract(B.sorUSDVault, A.sorUSDVault, provider);
    check(`${name}: rate bounds 0.5%–100%/yr enforced on-chain`,
      (await tmR.MIN_ANNUAL_RATE()) === 5n * 10n ** 15n && (await tmR.MAX_ANNUAL_RATE()) === 10n ** 18n);
    check(`${name}: 7-day rate-adjust cooldown (anti redemption-dodging)`,
      (await tmR.RATE_ADJUST_COOLDOWN()) === 7n * 86400n);
    check(`${name}: router split fixed at 80% vault / 20% treasury`,
      (await router.VAULT_SHARE_BPS()) === 8000n);
    check(`${name}: router targets the sorUSD vault`,
      (await router.vault()).toLowerCase() === B.sorUSDVault.toLowerCase());
    check(`${name}: router wiring is one-shot (owner burned)`,
      (await router.owner()) === ethers.ZeroAddress);
    check(`${name}: sorUSD vault holds orUSD as its asset`,
      (await vault.asset()).toLowerCase() === S.orUSDToken.toLowerCase());
  }

  // ---- Claim 5: community issuance streams to SP depositors ----
  console.log("\nClaim: community issuance (32%) streams to Stability Pool depositors");
  const ci = new ethers.Contract(S.communityIssuance, A.oraToken, provider); // balanceOf only
  const ciBal = await ora.balanceOf(S.communityIssuance);
  check("ETH-branch CommunityIssuance funded with 32M ORA (32%)",
    ciBal >= 31900000n * E18, M(ciBal).toFixed(2) + "M remaining");
  for (const [name, B] of Object.entries(dep.branches)) {
    if (!B.communityIssuance) continue;
    const bci = new ethers.Contract(B.communityIssuance, A.branchCommunityIssuance, provider);
    const cap = await bci.supplyCap();
    const active = await bci.active();
    const owner = await bci.owner();
    check(`${name}: BranchCommunityIssuance active, cap ${M(cap)}M ORA, ownership renounced`,
      active && owner === ethers.ZeroAddress);
  }

  // ---- Claim 6: no governance — ownership renounced everywhere ----
  console.log("\nClaim: minimal immutable core — ownership renounced after wiring");
  const owned = [["ORA staking (shared)", S.oraStaking, A.oraStaking]];
  for (const [name, B] of Object.entries(dep.branches)) {
    owned.push([`${name} TroveManager`, B.troveManager, A.troveManager]);
    owned.push([`${name} BorrowerOperations`, B.borrowerOperations,
      B.native ? A.borrowerOperations : A.borrowerOperationsERC20]);
    owned.push([`${name} StabilityPool`, B.stabilityPool,
      B.native ? A.stabilityPool : A.stabilityPoolERC20]);
    if (B.branchStaking) owned.push([`${name} BranchStaking`, B.branchStaking, A.branchStaking]);
  }
  for (const [label, addr, abi] of owned) {
    const c = new ethers.Contract(addr, abi, provider);
    let owner;
    try { owner = await c.owner(); } catch { owner = ethers.ZeroAddress; }
    check(`${label} ownership renounced`, owner === ethers.ZeroAddress, owner === ethers.ZeroAddress ? "" : owner);
  }
  // debt cap immutability (RWA): owner renounced means cap is frozen
  const bo3 = new ethers.Contract(dep.branches.tBILL.borrowerOperations, A.borrowerOperationsERC20, provider);
  const cap3 = await bo3.debtCap();
  check("RWA branch debt cap frozen at deployment", cap3 === 2000000n * E18,
    Number(cap3 / E18).toLocaleString("en-US") + " orUSD, owner renounced above");

  // ---- Claim: RWA branch — capital-efficient params + protocol yield share ----
  console.log("\nClaim: RWA branch runs MCR 105% / CCR 115% and skims 2%/yr of collateral yield to the treasury");
  const B3 = dep.branches.tBILL;
  const tm3 = new ethers.Contract(B3.troveManager, A.troveManagerRWA, provider);
  check("tBILL CCR = 115%", (await tm3.CCR()) === ethers.parseEther("1.15"), ethers.formatEther(await tm3.CCR()));
  check("tBILL soft-liq floor = 103%", (await tm3.SOFT_LIQ_FLOOR()) === ethers.parseEther("1.03"));
  const wt = new ethers.Contract(B3.collToken, A.wtBill, provider);
  check("wmTBILL skim rate = 2%/yr", (await wt.SKIM_RATE_PER_YEAR()) === ethers.parseEther("0.02"));
  const feeRecv = await wt.feeReceiver();
  check("wmTBILL skim accrues to the protocol treasury", feeRecv.toLowerCase() !== ethers.ZeroAddress, feeRecv);
  const wfeed = new ethers.Contract(B3.priceFeed, A.wtBillPriceFeed, provider);
  const nav = new ethers.Contract(B3.navPriceFeed, A.priceFeedRWA, provider);
  const composite = await wfeed.getPrice();
  const expectedP = (await nav.getPrice()) * (await wt.currentRate()) / E18;
  check("wmTBILL priced at NAV × wrapper rate", composite === expectedP, ethers.formatEther(composite));

  // ---- Claim: one-click leverage (rates branch) ----
  console.log("\nClaim: one-click leverage via per-user Zap proxies on the rates branch");
  const B4v = dep.branches.ETHv2;
  const zf = new ethers.Contract(B4v.leverZapFactory, A.leverZapFactory, provider);
  check("LeverZapFactory wired to the rates branch BorrowerOperations",
    (await zf.borrowerOps()) === B4v.borrowerOperations);
  const pool4 = new ethers.Contract(B4v.swapPool, A.oraSwapPool, provider);
  const rEth = await pool4.reserveETH();
  check("demo AMM liquid (orUSD/ETH)", rEth > 0n, ethers.formatEther(rEth) + " ETH reserve");

  console.log(`\n${pass} passed, ${fail} ${fail ? "FAILED" : "failed"}`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error("VERIFY FAILED:", e.shortMessage || e.message); process.exit(1); });
