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
- Testnet price feeds: ETH $2,000 / wstETH $2,400 (settable — no Chainlink
  feeds are wired yet; that's the Phase 1.5 oracle-adapter task)

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

## What the frontend needs next (Phase 1.5)

- Network switcher: load `deployment-baseSepolia.json`, browser connects
  straight to `https://sepolia.base.org` (browsers are not behind the sandbox
  firewall) with MetaMask for signing.
- Real oracle adapters (Chainlink ETH/USD + wstETH exchange-rate feed with
  depeg circuit breaker) to replace PriceFeedTestnet.
