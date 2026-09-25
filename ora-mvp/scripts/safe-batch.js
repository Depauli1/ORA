// Safe-ceremony automation: builds a Safe Transaction Builder JSON bundle
// for the multisig-held guardian powers (pause / unpause / rotate), with
// calldata encoded from the manifest so signers never transcribe hex.
//
// The guardian holder SHOULD be a Safe on production (ORA_GUARDIAN at
// deploy time). Import the bundle in the Safe UI (Transaction Builder ->
// import), collect threshold signatures, execute.
//
// Usage:
//   node scripts/safe-batch.js <manifest> --pause ETH [--duration 86400] --out pause.json
//   node scripts/safe-batch.js <manifest> --unpause wstETH --out unpause.json
//   node scripts/safe-batch.js <manifest> --rotate 0xNewGuardian --out rotate.json
//
// Branch names: ETH, wstETH, tBILL, ETHv2 (must exist in the manifest).
// Duration is clamped to (0, 30 days] — the guardian's max pause window.
const fs = require("fs");
const { ethers } = require("ethers");

const MAX_PAUSE = 30 * 86400;

function buildBundle(manifest, ops) {
  const chainId = manifest.meta?.chainId ?? manifest.chainId;
  const guardian = manifest.shared?.guardian;
  if (!guardian) throw new Error("manifest has no shared.guardian");
  const abi = manifest.abis?.guardian;
  if (!abi) throw new Error("manifest has no abis.guardian");
  const iface = new ethers.Interface(abi);
  const txs = [];
  const branchBO = (branch) => {
    const b = manifest.branches?.[branch];
    if (!b?.borrowerOperations) throw new Error(`unknown branch in manifest: ${branch}`);
    return b.borrowerOperations;
  };
  for (const op of ops) {
    if (op.pause) {
      const duration = Number(op.duration ?? 86400);
      if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_PAUSE) {
        throw new Error(`--duration must be in (0, ${MAX_PAUSE}] seconds (got ${op.duration})`);
      }
      const bo = branchBO(op.pause);
      txs.push({
        to: guardian, value: "0",
        data: iface.encodeFunctionData("pauseBorrowing", [bo, duration]),
        contractMethod: { inputs: [{ name: "_borrowerOps", type: "address" }, { name: "_duration", type: "uint256" }], name: "pauseBorrowing", payable: false },
        contractInputsValues: { _borrowerOps: bo, _duration: String(duration) },
      });
    } else if (op.unpause) {
      const bo = branchBO(op.unpause);
      txs.push({
        to: guardian, value: "0",
        data: iface.encodeFunctionData("unpauseBorrowing", [bo]),
        contractMethod: { inputs: [{ name: "_borrowerOps", type: "address" }], name: "unpauseBorrowing", payable: false },
        contractInputsValues: { _borrowerOps: bo },
      });
    } else if (op.rotate) {
      if (!ethers.isAddress(op.rotate)) throw new Error(`not an address: ${op.rotate}`);
      txs.push({
        to: guardian, value: "0",
        data: iface.encodeFunctionData("setGuardian", [op.rotate]),
        contractMethod: { inputs: [{ name: "_newGuardian", type: "address" }], name: "setGuardian", payable: false },
        contractInputsValues: { _newGuardian: op.rotate },
      });
    }
  }
  if (!txs.length) throw new Error("no operations (want --pause B | --unpause B | --rotate ADDR)");
  return {
    version: "1.0", chainId: String(chainId), createdAt: Date.now(),
    meta: {
      name: "ORA guardian ceremony", description: `guardian ${guardian}`,
      txBuilderVersion: "1.16.2", createdFromSafeAddress: manifest.shared.guardianHolder || "",
    },
    transactions: txs,
  };
}

if (require.main === module) {
  const [manifestPath, ...argv] = process.argv.slice(2);
  if (!manifestPath || manifestPath.startsWith("-")) {
    console.error("usage: node scripts/safe-batch.js <manifest> (--pause B|--unpause B|--rotate ADDR) [--duration S] --out file.json");
    process.exit(2);
  }
  const ops = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pause") ops.push({ pause: argv[++i] });
    else if (argv[i] === "--unpause") ops.push({ unpause: argv[++i] });
    else if (argv[i] === "--rotate") ops.push({ rotate: argv[++i] });
    else if (argv[i] === "--duration") ops.push({ duration: argv[++i] });
  }
  // attach duration to the pause op (single-pause bundles only for clarity)
  const pauses = ops.filter((o) => o.pause), durs = ops.filter((o) => o.duration);
  if (durs.length > 1 || (durs.length === 1 && pauses.length !== 1)) {
    console.error("--duration applies to exactly one --pause op"); process.exit(2);
  }
  if (durs.length === 1) pauses[0].duration = durs[0].duration;
  const outIdx = argv.indexOf("--out");
  if (outIdx < 0) { console.error("missing --out file.json"); process.exit(2); }
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  const bundle = buildBundle(manifest, ops.filter((o) => o.pause || o.unpause || o.rotate));
  fs.writeFileSync(argv[outIdx + 1], JSON.stringify(bundle, null, 2));
  console.log(`wrote ${argv[outIdx + 1]} (${bundle.transactions.length} tx, chain ${bundle.chainId}, guardian ${manifest.shared.guardian})`);
}

module.exports = { buildBundle, MAX_PAUSE };
