// All mutable app state in one explicit store (the original app.js kept
// this as module-level `let` soup). Selectors throw with clear messages
// when read before boot instead of failing deep inside ethers calls.
import { ethers } from "ethers";
import type { AppConfig, BranchCfg, Deployment } from "./config";
import { DEFAULT_CONFIG } from "./config";
import type { ActivityRecord } from "./activity";
import {
  isNativeBranch, isRWABranch, isRatesBranch, collSymOf, faucetAmtOf,
  brMcrOf, brSoftOf,
} from "./branch";

// Signer with the app's runtime augmentations (address cached at connect,
// pre-flight guard flag). See wallet.ts guardSigner().
export type AppSigner = ethers.Signer & {
  address: string;
  __oraGuarded?: boolean;
};

// Connected contracts for the current branch. Stringly-typed by design:
// ethers Contract methods are dynamic, and full typing needs TypeChain
// (follow-up). The DEPLOYMENT side is typed (config.ts), which is where
// wrong-address bugs live.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CMap = Record<string, any>;

// Minimal EIP-1193 shape the app needs (injected wallets, WalletConnect).
export interface Eip1193 {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request(args: { method: string; params?: any }): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on?: (event: string, listener: (...args: any[]) => void) => void;
}

export interface WalletDiscovery {
  info: { uuid: string; name: string };
  provider: Eip1193;
}

class Store {
  provider: ethers.JsonRpcProvider | ethers.BrowserProvider | null = null;
  wallet: AppSigner | null = null;
  dep: Deployment | null = null;
  C: CMap = {};
  branch = "ETH";
  netMode = "local";
  hostname = "localhost";
  price = 0;
  nativeBalance = 0n;
  collateralBalance = 0n;
  orUsdBalance = 0n;
  busy = false;
  activeActivityId: string | null = null;
  networkReady = false;
  position: { collateral: bigint; debt: bigint } | null = null;
  borrowingRate = 0n;
  oracleLive: boolean | null = null;
  navShock = false;
  recoveryMode = false;
  lastRefreshAt: number | null = null;
  lastRefreshError: string | null = null;
  activity: ActivityRecord[] = [];
  troveRows = 50;
  discoveredWallets: WalletDiscovery[] = [];
  appConfig: AppConfig = { ...DEFAULT_CONFIG };
  refreshTimer: ReturnType<typeof setInterval> | null = null;
  discoveryInstalled = false;

  reset(hostname: string): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.provider = null;
    this.wallet = null;
    this.dep = null;
    this.C = {};
    this.branch = "ETH";
    this.netMode = "local";
    this.hostname = hostname;
    this.price = 0;
    this.nativeBalance = 0n;
    this.collateralBalance = 0n;
    this.orUsdBalance = 0n;
    this.busy = false;
    this.activeActivityId = null;
    this.networkReady = false;
    this.position = null;
    this.borrowingRate = 0n;
    this.oracleLive = null;
    this.navShock = false;
    this.recoveryMode = false;
    this.lastRefreshAt = null;
    this.lastRefreshError = null;
    this.activity = [];
    this.troveRows = 50;
    this.discoveredWallets = [];
    this.appConfig = { ...DEFAULT_CONFIG };
    this.refreshTimer = null;
    // discoveryInstalled survives: window listeners are installed once
  }
}

export const state = new Store();

export const MAX_MARKET_DATA_AGE_MS = 30_000;

export function hasFreshMarketData(now = Date.now()): boolean {
  if (state.lastRefreshAt === null || state.lastRefreshError) return false;
  const age = now - state.lastRefreshAt;
  return age >= 0 && age <= MAX_MARKET_DATA_AGE_MS;
}

// Fail-fast accessors (throw before boot instead of cryptic ethers errors).
export function req<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`ORA: ${what} is not available yet`);
  return v;
}

export function dep(): Deployment {
  return req(state.dep, "deployment data (pick a network first)");
}

export function bcfg(): BranchCfg {
  const d = dep();
  const b = d.branches[state.branch];
  if (!b) throw new Error(`ORA: branch ${state.branch} missing from deployment`);
  return b;
}

export function provider(): ethers.JsonRpcProvider | ethers.BrowserProvider {
  return req(state.provider, "provider (pick a network first)");
}

export function myAddr(): string {
  return state.wallet ? state.wallet.address : "0x0000000000000000000000000000000000000000";
}

// Current-branch conveniences (thin wrappers over the pure branch.ts
// selectors — the math stays unit-testable, call sites stay readable).
export const isNative = (): boolean => isNativeBranch(bcfg());
export const isRWA = (): boolean => isRWABranch(bcfg());
export const isRates = (): boolean => isRatesBranch(bcfg());
export const collSym = (): string => collSymOf(bcfg());
export const faucetAmt = (): string => faucetAmtOf(bcfg());
export const brMcr = (): number => brMcrOf(bcfg());
export const brSoft = (): number => brSoftOf(bcfg());
