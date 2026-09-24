// Seeds the ORA testnet with a realistic market: several Troves at varied
// collateral ratios + Stability Pool deposits, so the app demos liquidations.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethers } = hre;

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "deployment.json")));
  const signers = await ethers.getSigners();

  const bo = await ethers.getContractAt("BorrowerOperations", dep.addresses.borrowerOperations);
  const sp = await ethers.getContractAt("StabilityPool", dep.addresses.stabilityPool);

  const maxFee = ethers.parseEther("0.05");
  const Z = ethers.ZeroAddress;

  const troves = [
    { s: 5, coll: "400", debt: "300000" }, // whale, ~266% ICR
    { s: 6, coll: "10",  debt: "12000"  }, // ~163%
    { s: 7, coll: "5",   debt: "7000"   }, // ~138% (risky)
    { s: 8, coll: "3",   debt: "4800"   }  // ~119% (liquidatable on a dip)
  ];

  for (const t of troves) {
    const signer = signers[t.s];
    const tx = await bo.connect(signer).openTrove(
      maxFee, ethers.parseEther(t.debt), Z, Z,
      { value: ethers.parseEther(t.coll) }
    );
    await tx.wait();
    console.log(`Trove opened by ${signer.address}: ${t.coll} ETH / ${t.debt} orUSD`);
  }

  // Stability Pool deposits
  await (await sp.connect(signers[5]).provideToSP(ethers.parseEther("150000"), Z)).wait();
  await (await sp.connect(signers[6]).provideToSP(ethers.parseEther("8000"), Z)).wait();
  console.log("Stability Pool seeded with 158,000 orUSD");
}

main().catch(e => { console.error(e); process.exit(1); });
