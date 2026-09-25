# ORA frontend

TypeScript + Vite app served by the hardened Node server (`../server.js`).
Strict `tsc`, 52 vitest tests, one Playwright e2e — all gated in CI.

## Commands (from `ora-mvp/`)

| Command | What it does |
|---|---|
| `npm run dev` | Vite HMR dev server (uses `app/src`, proxies nothing — point at a local stack) |
| `npm run build` | `vite build` → `app/dist/` (gitignored) |
| `npm run app` | Build + serve production bundle via `server.js` |
| `npm run app:dev` | Serve without rebuilding (expects `app/dist/`) |
| `npm run typecheck` | `tsc --noEmit` (strict, covers src + tests + e2e) |
| `npm run test:ui` | `vitest run` — server + UI suites (52 tests) |
| `npm run test:e2e` | Playwright e2e — **CI only** (browser binaries + fresh chain stack) |

Local full stack: `npm run chain`, `npm run deploy`, then `npm run app`.

## Server env vars

| Var | Effect |
|---|---|
| `FAUCET_KEY` | Enables `POST /faucet` (100 ORA drip). Local/dev only — never set in production. The UI shows the faucet row iff `/config` reports `faucet: true`. |
| `WALLETCONNECT_PROJECT_ID` | Enables the 📱 WalletConnect button on public nets (mobile wallets, lazy-loaded + QR modal). |
| `LOG_TOKEN` | Bearer token for `GET /log` from non-loopback hosts (loopback is open). |
| `CSP_CONNECT_EXTRA` | Extra `connect-src` origins for the content-security policy. |
| `PORT` | Listen port (default 3000). RPC proxy target is fixed at `127.0.0.1:8545`. |

## Architecture (`app/src/`)

- `main.ts` — entry: error hooks, `boot()`, auto-boot in browser only
- `config.ts` — network registry, ABIs bundle map, constants
- `state.ts` — single mutable state object + current-branch conveniences
- `branch.ts` — **pure** branch selectors (unit-tested, no DOM/chain)
- `contracts.ts` — contract wiring, hint pipelines, fee math, allowance flow
- `wallet.ts` — demo accounts (localhost-gated), injected wallets, send guard, `tx()` wrapper
- `faucet.ts` — server-faucet client (no key in the bundle, ever)
- `walletconnect.ts` — lazy WalletConnect + own QR modal (SVG, no canvas)
- `network.ts` — network switching, `/config` loading
- `views.ts` — read path + rendering (`refresh()`, troves table, previews)
- `actions.ts` — all button/input wiring (no chain logic, no rendering)
- `dom.ts` / `format.ts` — typed element access + toast; number formatting
- `wallet-gate.ts` — `isLocalhost()` (shared with tests)

## Security properties (tested)

- **Demo keys are localhost-only**: `isLocalhost()` gates `setAccount()` and
  local mode; off-localhost the picker never wires and no wallet is built.
- **No faucet key in the bundle**: the old client-side drip (broken — it
  signed as an account holding no ORA) is replaced by server-side `/faucet`
  with hourly per-IP/per-address quotas. e2e derives the key from hardhat
  account #4 (treasury); `scripts/e2e-up.sh` asserts the derivation.
- **Fail-closed UI**: missing deployments, read-only mode, and reverts all
  surface as toasts; uncaught errors report to `/log`, never to third parties.
- WalletConnect loads only on public nets with a project id, only when
  clicked (separate chunk), with our own QR modal instead of a modal SDK.
