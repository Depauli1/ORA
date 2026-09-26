#!/usr/bin/env node
// JS/TS coverage gate (ratchets — raise, never lower).
//
// Reads coverage/coverage-summary.json produced by:
//   npx vitest run app/test/ --coverage
// and enforces the TOTAL floors plus per-file floors below. When coverage
// improves, raise the numbers here; never lower them. Every file now sits at
// 100% on all four metrics; keep it there.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const summaryPath = path.join(__dirname, "..", "coverage", "coverage-summary.json");
if (!fs.existsSync(summaryPath)) {
  console.error("js-coverage-gate: coverage/coverage-summary.json not found.");
  console.error("Run `npx vitest run app/test/ --coverage` first.");
  process.exit(1);
}
const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

const METRICS = ["lines", "branches", "functions", "statements"];

// [lines, branches, functions, statements] floors per measured file.
const RATCHETS = {
  "app/src/actions.ts": [100, 100, 100, 100],
  "app/src/activity.ts": [100, 100, 100, 100],
  "app/src/branch.ts": [100, 100, 100, 100],
  "app/src/config.ts": [100, 100, 100, 100],
  "app/src/contracts.ts": [100, 100, 100, 100],
  "app/src/dom.ts": [100, 100, 100, 100],
  "app/src/faucet.ts": [100, 100, 100, 100],
  "app/src/format.ts": [100, 100, 100, 100],
  "app/src/main.ts": [100, 100, 100, 100],
  "app/src/network.ts": [100, 100, 100, 100],
  "app/src/review.ts": [100, 100, 100, 100],
  "app/src/state.ts": [100, 100, 100, 100],
  "app/src/views.ts": [100, 100, 100, 100],
  "app/src/wallet-gate.ts": [100, 100, 100, 100],
  "app/src/wallet.ts": [100, 100, 100, 100],
  "app/src/walletconnect.ts": [100, 100, 100, 100],
  "server-lib.js": [100, 100, 100, 100],
  "server.js": [100, 100, 100, 100],
};
const TOTAL = [100, 100, 100, 100];

let failed = false;
const failures = [];

const check = (label, entry, floors) => {
  const pct = METRICS.map((m) => entry[m].pct);
  const marks = METRICS.map((m, i) => {
    if (pct[i] < floors[i]) {
      failed = true;
      failures.push(`${label}: ${m} ${pct[i]}% < ratchet ${floors[i]}%`);
      return `${pct[i]}<${floors[i]} ✗`;
    }
    return `${pct[i]}>=${floors[i]} ✓`;
  });
  console.log(`${label.padEnd(34)} ${METRICS.map((m, i) => `${m.slice(0, 4)} ${marks[i]}`).join("  ")}`);
};

console.log("JS coverage gate (ratchets — raise, never lower)\n");
for (const [file, floors] of Object.entries(RATCHETS)) {
  const entry = summary[path.join(path.dirname(summaryPath), file)] ||
    summary[file] ||
    summary[Object.keys(summary).find((k) => k.endsWith(file))];
  if (!entry) {
    failed = true;
    failures.push(`${file}: missing from coverage summary`);
    continue;
  }
  check(file, entry, floors);
}
check("TOTAL", summary.total, TOTAL);

if (failed) {
  console.error("\njs-coverage-gate: FAILED — coverage fell below a ratchet:");
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log("\njs-coverage-gate: OK — every ratchet held.");
