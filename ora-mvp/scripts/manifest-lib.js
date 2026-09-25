// Shared manifest codec + checks for the deploy pipeline (pure functions,
// unit-tested; no hardhat runtime needed except ethers address utils).
//
// Determinism model: ORA deploys are NONCE-deterministic, not CREATE2.
// The audited core captures msg.sender in constructors (Ownable wiring,
// the orUSD branch registrar), so a CREATE2 factory deployer would brick
// deployment (factory-as-owner cannot wire setAddresses; factory-as-
// registrar cannot register branches 2-4). Instead, a fresh deployer key
// (scripts/gen-deployer.js) + a fixed deploy sequence makes every address
// a pure function of (deployer, nonce) — recorded per deployment in the
// manifest's `verify` section and re-checkable with check-addresses.js.
const { ethers } = require("ethers");

// --- BigInt-safe arg codec (constructor args round-trip through JSON) ---
function serArg(v) {
  if (typeof v === "bigint") return { __bigint: v.toString() };
  if (Array.isArray(v)) return v.map(serArg);
  return v;
}
function deserArg(v) {
  if (v && typeof v === "object" && !Array.isArray(v) && typeof v.__bigint === "string") {
    return BigInt(v.__bigint);
  }
  if (Array.isArray(v)) return v.map(deserArg);
  return v;
}
const serArgs = (args) => (args || []).map(serArg);
const deserArgs = (args) => (args || []).map(deserArg);

// --- nonce-determinism check: address must equal f(deployer, nonce) ---
function expectedAddress(deployer, nonce) {
  return ethers.getCreateAddress({ from: deployer, nonce: Number(nonce) });
}

// Returns [{contract, address, nonce, ok}] for every verify entry.
function checkVerifyAddresses(manifest) {
  const deployer = manifest.meta?.deployer || manifest.deployer;
  if (!deployer) throw new Error("manifest has no meta.deployer (or legacy deployer)");
  return (manifest.verify || []).map((e) => {
    const expected = expectedAddress(deployer, e.nonce);
    return { contract: e.contract, address: e.address, nonce: e.nonce, ok: expected.toLowerCase() === String(e.address).toLowerCase(), expected };
  });
}

// --- manifest diff (per-release artifact) ---
function abiSelectors(abi) {
  const out = new Set();
  for (const f of abi || []) {
    if (f.type !== "function") continue;
    const sig = `${f.name}(${(f.inputs || []).map((i) => i.type).join(",")})`;
    try { out.add(`${sig}=${ethers.id(sig).slice(0, 10)}`); } catch { out.add(sig); }
  }
  return out;
}

function flattenBranches(manifest) {
  const flat = {};
  for (const [branch, fields] of Object.entries(manifest.branches || {})) {
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === "string" && v.startsWith("0x") && v.length === 42) flat[`${branch}.${k}`] = v;
    }
  }
  for (const [k, v] of Object.entries(manifest.shared || {})) {
    if (typeof v === "string" && v.startsWith("0x") && v.length === 42) flat[`shared.${k}`] = v;
  }
  return flat;
}

// Returns a markdown diff of old vs new manifest.
function diffManifests(oldM, newM) {
  const lines = ["# Deployment manifest diff", ""];
  const om = oldM.meta || {}, nm = newM.meta || {};
  lines.push(`- network: ${om.network || "?"} → ${nm.network || "?"}`);
  lines.push(`- chainId: ${om.chainId ?? oldM.chainId} → ${nm.chainId ?? newM.chainId}`);
  lines.push(`- git: \`${om.gitCommit || "?"}\` → \`${nm.gitCommit || "?"}\``);
  lines.push("");
  const of = flattenBranches(oldM), nf = flattenBranches(newM);
  const keys = [...new Set([...Object.keys(of), ...Object.keys(nf)])].sort();
  const changed = keys.filter((k) => of[k] !== nf[k]);
  lines.push(`## Addresses (${changed.length} changed)`);
  if (!changed.length) lines.push("(none — identical address map)");
  for (const k of changed) {
    if (!(k in of)) lines.push(`- ADDED ${k} = ${nf[k]}`);
    else if (!(k in nf)) lines.push(`- REMOVED ${k} (was ${of[k]})`);
    else lines.push(`- CHANGED ${k}: ${of[k]} → ${nf[k]}`);
  }
  lines.push("");
  lines.push("## ABI selectors");
  const abis = [...new Set([...Object.keys(oldM.abis || {}), ...Object.keys(newM.abis || {})])].sort();
  let abiChanged = 0;
  for (const name of abis) {
    const a = abiSelectors(oldM.abis?.[name]), b = abiSelectors(newM.abis?.[name]);
    const added = [...b].filter((s) => !a.has(s)), removed = [...a].filter((s) => !b.has(s));
    if (added.length || removed.length) {
      abiChanged++;
      lines.push(`- ${name}: +${added.length} −${removed.length}`);
      for (const s of added) lines.push(`  - + ${s}`);
      for (const s of removed) lines.push(`  - − ${s}`);
    }
  }
  if (!abiChanged) lines.push("(none — identical ABI surface)");
  lines.push("");
  lines.push("## Bytecode");
  const oh = {}, nh = {};
  for (const e of oldM.verify || []) oh[`${e.contract}#${e.address}`] = e.bytecodeHash;
  for (const e of newM.verify || []) nh[`${e.contract}#${e.address}`] = e.bytecodeHash;
  const hkeys = [...new Set([...Object.keys(oh), ...Object.keys(nh)])].sort();
  const hchanged = hkeys.filter((k) => oh[k] !== nh[k]);
  if (!hchanged.length) lines.push("(none — identical bytecode hashes)");
  for (const k of hchanged) lines.push(`- ${k}: ${(oh[k] || "absent").slice(0, 18)} → ${(nh[k] || "absent").slice(0, 18)}`);
  lines.push("");
  lines.push("_Note: bytecode hashes include the solc metadata blob, so a rebuild with a different");
  lines.push("toolchain path can churn hashes with identical sources — the ABI selector diff above is");
  lines.push("the stable signal._");
  return lines.join("\n");
}

module.exports = { serArgs, deserArgs, expectedAddress, checkVerifyAddresses, diffManifests, flattenBranches };
