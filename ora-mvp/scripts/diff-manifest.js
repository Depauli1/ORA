// Per-release manifest diff: addresses + ABI selectors + bytecode hashes.
//
// Usage: node scripts/diff-manifest.js <old.json> <new.json> [--out diff.md]
const fs = require("fs");
const { diffManifests } = require("./manifest-lib");

const [oldPath, newPath] = process.argv.slice(2);
if (!oldPath || !newPath || oldPath.startsWith("-")) {
  console.error("usage: node scripts/diff-manifest.js <old.json> <new.json> [--out diff.md]");
  process.exit(2);
}
const out = diffManifests(
  JSON.parse(fs.readFileSync(oldPath)),
  JSON.parse(fs.readFileSync(newPath)));
const outIdx = process.argv.indexOf("--out");
if (outIdx >= 0) {
  fs.writeFileSync(process.argv[outIdx + 1], out);
  console.log("wrote", process.argv[outIdx + 1]);
} else {
  console.log(out);
}
