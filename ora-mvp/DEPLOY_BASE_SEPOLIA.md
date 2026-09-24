# ORA — Base Sepolia Deployment Runbook

The Arena sandbox's network allowlist blocks public RPC endpoints, so the
public-testnet deployment runs from any machine with open internet
(laptop, CI, a VPS — anything that can `npm install`).

## One-time setup

```bash
git clone https://github.com/Depauli1/ORA.git
cd ORA/ora-mvp
git checkout arena/01a0d2bf-ora
npm install
npx hardhat compile
```

## 1. Create & fund the deployer

```bash
node scripts/gen-deployer.js
```

This prints a fresh deployer address (key saved to `ora-mvp/.secret`,
gitignored, **testnet use only**). Fund it with ~0.05 Base Sepolia ETH:

- Coinbase faucet: https://portal.cdp.coinbase.com/products/faucet
- Alchemy faucet:  https://www.alchemy.com/faucets/base-sepolia

Already generated in this workspace: `0xe169b120023A9a8AeF04197E9c624bE6EBC59268`
(if you deploy from another machine, gen-deployer will create its own key).

## 2. Deploy both branches

```bash
npx hardhat run scripts/deploy-public.js --network baseSepolia
```

This deploys and wires, in one run:
- **ETH branch** — full native-ETH core (TroveManager, pools, BorrowerOperations)
- **wstETH branch** — ERC20 pool suite + MockWstETH (public faucet, 1000/call)
- **Shared** — orUSD (both branches registered), ORA token, ORA staking
- **Real oracle adapters (Phase 1.5)** — the ETH branch uses the live Chainlink
  ETH/USD feed on Base Sepolia (default `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1`,
  override with `ORA_ETHUSD_FEED=<address>`; the adapter constructor reverts if
  the feed doesn't return a valid in-date price, so a wrong address fails loudly).
  The wstETH branch composes ETH/USD x stETH/ETH x wstETH exchange rate with a
  depeg circuit breaker at 0.96; since Base Sepolia has no canonical stETH/ETH
  feed, that leg uses a SettableAggregator mock (which doubles as the depeg demo).
  48h staleness timeout; broken/stale feeds fall back to lastGoodPrice.
- **Phase 2 tokenomics + soft liquidations (wstETH branch)** — `TroveManagerV2`
  (adds `liquidatePartial`: partial SP offset at a 3% premium for troves in the
  [105%, 110%) soft band, trove restored to 110% and kept open, 0.5% of seized
  collateral to the caller), `BranchStaking` (stake ORA → earn the branch's
  borrow fees in orUSD + redemption fees in wstETH; ORA is pulled via
  `transferFrom`, so staking needs a one-time approve — the app does this
  automatically), and `BranchCommunityIssuance` (the deploy script transfers
  **1,000,000 ORA** from the derived treasury and activates it, locking the cap;
  wstETH Stability Pool depositors then earn ORA on the yearly-halving curve).
  The ETH branch keeps the audited v1 TroveManager and classic ORA staking.

Addresses + ABIs are written to `app/deployment-baseSepolia.json` — commit it.

```bash
git add app/deployment-baseSepolia.json && git commit -m "chore: Base Sepolia deployment" && git push
```

## 3. Verify (optional but recommended)

```bash
ORA_RPC_URL=https://sepolia.base.org npx hardhat verify --network baseSepolia <ADDRESS> [constructor args]
```

(Requires `ETHERSCAN_API_KEY` for Basescan in the env; can be batched later.)

## Custom RPC

`ORA_RPC_URL` overrides the default `https://sepolia.base.org`, and
`ORA_DEPLOYER_KEY` overrides the `.secret` file:

```bash
ORA_RPC_URL=https://base-sepolia.g.alchemy.com/v2/<key> npx hardhat run scripts/deploy-public.js --network baseSepolia
```

## Frontend

Done (Phase 1.5): the app has a **network switcher** (Local / Base Sepolia).
Base Sepolia mode loads `deployment-baseSepolia.json`, reads via
`https://sepolia.base.org` directly from the browser (browsers are not behind
the sandbox firewall), and signs with MetaMask (auto adds/switches to chain
84532). Until `deployment-baseSepolia.json` is committed, the switcher shows
a friendly "not deployed yet" notice.

Phase 2 UI: the Stake ORA card is branch-aware (classic staking on the ETH
branch, `BranchStaking` with auto-approve on the wstETH branch, fee labels in
the branch's collateral symbol), Stability Pool cards show the real ORA reward
on both branches, and the risky-troves table adds a **Soft-liq** button for
wstETH troves inside the [105%, 110%) band.
