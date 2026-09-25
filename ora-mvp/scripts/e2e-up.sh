#!/usr/bin/env bash
# e2e stack for Playwright (CI): hardhat node -> full branch deploy -> app
# server with the treasury-derived FAUCET_KEY. Playwright's webServer runs
# this and polls /config; SIGTERM (end of the run) stops the chain too.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3100}"
export PORT

npx hardhat node --hostname 127.0.0.1 --port 8545 > /tmp/e2e-chain.log 2>&1 &
CHAIN_PID=$!
cleanup() { kill "$CHAIN_PID" 2>/dev/null || true; }
trap cleanup EXIT TERM INT

echo "[e2e] waiting for chain..."
for _ in $(seq 1 60); do
  if curl -sf -m 2 -X POST http://127.0.0.1:8545 \
      -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' > /dev/null; then
    break
  fi
  sleep 1
done

echo "[e2e] deploying branches..."
npx hardhat run scripts/deploy.js --network localhost > /tmp/e2e-deploy.log 2>&1
tail -2 /tmp/e2e-deploy.log

# Treasury = hardhat account #4 — the only ORA holder that can fund drips.
# (fromPhrase's 2nd arg is the password, not the path — the path goes 3rd.
# Passing it 2nd silently derives account #0, whose drips revert on-chain.)
export FAUCET_KEY
FAUCET_KEY=$(node -e "
const { ethers } = require('ethers');
const w = ethers.HDNodeWallet.fromPhrase(
  'test test test test test test test test test test test junk',
  '', \"m/44'/60'/0'/0/4\");
if (w.address !== '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65') {
  console.error('treasury derivation drifted: ' + w.address); process.exit(1);
}
console.log(w.privateKey);")

echo "[e2e] starting app server on :$PORT"
node server.js &
SRV_PID=$!
wait "$SRV_PID"
