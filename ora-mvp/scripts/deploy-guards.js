// Deploy-time chain guards: which venues may exist on which chains.
// Single source of truth for "testnet-only" gating, shared by deploy.js,
// seed-public.js and verify-tokenomics.js (and unit-tested — the on-chain
// half of each guard cannot be chain-flipped under Hardhat, so the JS half
// carries the tested guarantee while the Solidity half is a backstop).

// Mainnet chain ids. Anything NOT on this list is treated as a test chain
// (local dev chains, Sepolia, Base Sepolia, forks). Add new production
// targets here BEFORE their first deploy — never remove entries.
const MAINNET_CHAIN_IDS = new Set([1, 8453]); // Ethereum, Base

function isMainnetChainId(chainId) {
  return MAINNET_CHAIN_IDS.has(Number(chainId));
}

async function deploymentChainId(ethers) {
  return Number((await ethers.provider.getNetwork()).chainId);
}

module.exports = { MAINNET_CHAIN_IDS, isMainnetChainId, deploymentChainId };
