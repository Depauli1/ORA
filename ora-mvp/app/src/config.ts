// Static app config: network registry, demo accounts, chain constants,
// deployment-file shapes. No DOM, no state — safe to import anywhere.
import { ethers } from "ethers";

export const Z = "0x0000000000000000000000000000000000000000";
export const MAX_FEE = ethers.parseEther("0.05");
export const GAS_COMP = ethers.parseEther("200"); // refunded on close — repay = debt − 200

export interface NetworkEntry {
  label: string;
  testnet: boolean;
  local: boolean;
  file: string;
  chainIdHex?: string;
  chainName?: string;
  rpc?: string;
  explorer?: string;
}

// Network registry. `testnet` gates simulators/faucets; `local` additionally
// enables the built-in demo accounts (which are ALSO gated on localhost at
// the use sites — defense in depth for misconfigured deploys). Mainnet
// entries are wallet-only and show no test tooling at all.
export const NETWORKS: Record<string, NetworkEntry> = {
  local: { label: "Local demo chain", testnet: true, local: true, file: "deployment.json" },
  baseSepolia: {
    label: "Base Sepolia", testnet: true, local: false, file: "deployment-baseSepolia.json",
    chainIdHex: "0x14a34", chainName: "Base Sepolia", rpc: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
  },
  base: {
    label: "Base", testnet: false, local: false, file: "deployment-base.json",
    chainIdHex: "0x2105", chainName: "Base", rpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
  },
};

// Well-known hardhat test keys (public). DEMO ONLY: setAccount() refuses to
// use these unless the page is served from localhost, and the account picker
// is hidden everywhere else. There is intentionally NO treasury key here —
// the ORA drip is a server-side endpoint (see faucet.ts).
export const ACCOUNTS: Record<string, string> = {
  alice: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  bob: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  carol: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
};

// --- deployment.json shapes (mirrors scripts/deploy.js output) ---

export interface BranchCfg {
  collSymbol: string;
  native?: boolean;
  rwa?: boolean;
  rates?: boolean;
  mcr?: number;
  ccr?: number;
  softFloor?: number;
  debtCap?: number | string;
  faucetAmount?: string;
  // core addresses (always present when the branch exists)
  priceFeed: string;
  troveManager: string;
  borrowerOperations: string;
  activePool: string;
  stabilityPool: string;
  gasPool: string;
  defaultPool: string;
  collSurplusPool: string;
  sortedTroves: string;
  hintHelpers: string;
  multiTroveGetter: string;
  communityIssuance: string;
  // feature-gated (presence-checked at the use sites)
  collToken?: string;
  ethUsdAggregator?: string;
  ethUsdSettable?: boolean;
  stEthEthAggregator?: string;
  navAggregator?: string;
  branchStaking?: string;
  sorUSDVault?: string;
  interestRouter?: string;
  leverZapFactory?: string | null;
  swapPool?: string | null;
}

export interface SharedCfg {
  orUSDToken: string;
  oraToken: string;
  oraStaking: string;
  communityIssuance: string;
  lockupFactory: string;
  guardian: string;
  guardianHolder: string;
  batchLiquidator: string;
  troveCursor: string;
  sequencerUptimeFeed?: string;
  sequencerSettable?: boolean;
  ethUsdFallbackAggregator?: string;
  ethUsdFallbackSettable?: boolean;
  ethUsdDeviationBps?: number;
  wstethDeviationBps?: number;
  ethUsdHeartbeat?: number;
  stethHeartbeat?: number;
  prodPolicyEnforced?: boolean;
}

export interface Deployment {
  chainId?: number;
  deployer?: string;
  branches: Record<string, BranchCfg>;
  shared: SharedCfg;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abis: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [extra: string]: any; // meta/verify sections ignored by the app
}

// --- runtime config from GET /config (never contains secrets) ---
export interface AppConfig {
  faucet: boolean;
  walletConnectProjectId: string | null;
  previewDemo: boolean;
}

export const DEFAULT_CONFIG: AppConfig = { faucet: false, walletConnectProjectId: null, previewDemo: false };
