// Parses Slither's JSON output and gates CI on high-severity findings in the
// new ORA contracts. Every gated finding is emitted as a GitHub Actions
// ::error annotation so results are visible through the API (raw CI logs are
// not reachable from the dev sandbox).
const fs = require("fs");

const path = process.argv[2] || "slither-gate.json";
if (!fs.existsSync(path)) {
  console.log("::error title=Slither gate::no JSON output found at " + path + " (slither crashed?)");
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(path, "utf8"));
const detectors = (data.results && data.results.detectors) || [];

const high = detectors.filter(d => d.impact === "High");
const medium = detectors.filter(d => d.impact === "Medium");

const oneLine = s => s.replace(/\s+/g, " ").trim();
for (const d of high) {
  console.log(`::error title=Slither HIGH (${d.check})::${oneLine(d.description).slice(0, 400)}`);
}
for (const d of medium.slice(0, 15)) {
  console.log(`::warning title=Slither medium (${d.check})::${oneLine(d.description).slice(0, 300)}`);
}
console.log(`\nSlither gate: ${high.length} high, ${medium.length} medium (gating on high only)`);
if (high.length > 0) process.exit(1);
console.log("PASS — no high-severity findings in gated contracts");
