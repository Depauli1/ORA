# ORA on Base Sepolia — public testnet deployment

The protocol graduates from the local demo chain to Base Sepolia through a
GitHub Actions pipeline (the dev sandbox cannot reach public RPCs, so CI is
the deploy machine). Everything is automated except one step: **funding the
deployer with faucet ETH**.

## How it works

```
fund deployer ──> touch ora-mvp/.deploy-testnet-trigger ──> push
                                        │
                     .github/workflows/deploy-testnet.yml
                                        │
        npm ci → check funding → compile → deploy-public → seed-public
                                        │
          commits app/deployment-baseSepolia.json back to the branch
                                        │
        ORA web app → network switch "Base Sepolia" → MetaMask → live
```

## 1. Fund the deployer (the only manual step)

The pipeline deploys from a throwaway, testnet-only key committed at
`ora-mvp/.testnet-deployer.key` (it never holds anything but faucet ETH).

**Deployer address: `0xbC8aFFCE0B146B9e82fa7D8C7d0d40D1443Cd131`**

Free Base Sepolia faucets (no mainnet balance required):
- https://portal.cdp.coinbase.com/products/faucet (Coinbase — pick "Base Sepolia")
- https://www.alchemy.com/faucets/base-sepolia
- https://faucet.quicknode.com/base/sepolia

Budget (Base Sepolia gas is near-zero — the full ~60-contract deploy costs
well under 0.01 ETH):

| Funding | What you get |
|---|---|
| ~0.05 ETH | Full deploy + seeded wstETH & wmTBILL branches (ERC20 faucet collateral) |
| ~3.5 ETH | Everything: also first troves on both native-ETH branches + AMM liquidity |

`seed-public.js` is adaptive and idempotent — fund a little now, re-trigger
later with more, and it fills in whatever is missing.

> Optional hardening: as repo owner you can add an Actions secret named
> `DEPLOYER_KEY` (Settings → Secrets and variables → Actions) with your own
> key; the workflow prefers it over the committed file.

## 2. Trigger the deploy

```bash
date > ora-mvp/.deploy-testnet-trigger
git add ora-mvp/.deploy-testnet-trigger && git commit -m "deploy: Base Sepolia" && git push
```

The workflow (Actions tab → "Deploy ORA to Base Sepolia"):
1. **Fails fast with faucet instructions** if the deployer is unfunded — that
   is the expected first-run state, not an error in the pipeline.
2. Deploys all four branches (ETH, wstETH, wmTBILL RWA, ETH v2 rates) + the
   swap pool and LeverZap factory, wiring identical to the local chain.
3. Derives the treasury wallet from the deployer key (`deploy-public.js`) so
   the ORA faucet allocation is not transfer-locked (LQTYToken locks the
   multisig=deployer for year 1).
4. Seeds first troves / SP deposits / vault / AMM as balance allows.
5. Commits `app/deployment-baseSepolia.json` to this branch.

## 3. Use it

Open the ORA web app, switch the network selector to **Base Sepolia**,
connect MetaMask (the app offers to add/switch the chain). Test collateral
for wstETH/wmTBILL comes from the built-in faucet buttons; test ETH from the
faucets above.

## Oracle notes

- ETH/USD uses the real Chainlink Base Sepolia feed configured in
  `scripts/deploy.js` (`REAL_FEEDS`), env-overridable via `ORA_ETHUSD_FEED`.
  The deploy **probes the aggregator on-chain first** (answer > 0, fresh
  within 48h); if the probe fails it falls back to a `SettableAggregator`
  at $2000 rather than bricking the deploy — the app's market simulator then
  drives the price instead of Chainlink.
- stETH/ETH and the mTBILL NAV have no canonical Base Sepolia feeds →
  `SettableAggregator` mocks everywhere (they power the depeg/NAV-shock
  demos).
- The wmTBILL branch prices collateral at NAV × wrapper rate via
  `WTBillPriceFeed` exactly as on the local chain.

## Branch parameters (identical to local)

| Branch | Collateral | MCR / CCR | Extras |
|---|---|---|---|
| ETH | native ETH | 110% / 150% | classic Liquity v1 engine |
| wstETH | MockWstETH | 110% / 150% | soft-liq band [105%, 110%), BranchStaking, 1M ORA SP issuance |
| tBILL | wmTBILL (yield-share wrapper) | **105% / 115%** | soft band [103%, 105%), 2%/yr skim → treasury, 2M orUSD debt cap, 500k ORA |
| ETHv2 | native ETH | 110% / 150% | user-set rates 0.5–100%, sorUSD vault (80/20), OraSwapPool + LeverZap, 500k ORA |

## Redeploying

Each trigger push runs a **fresh full deploy** (new addresses) and overwrites
`deployment-baseSepolia.json`. The previous deployment keeps existing on
chain but the app only shows the latest. Deterministic-address guarantees do
NOT hold on public networks (nonce depends on history) — always use the
committed deployment file, never hardcoded addresses.
