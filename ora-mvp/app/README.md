# ORA frontend

TypeScript + Vite app served by the hardened Node server (`../server.js`).
Strict `tsc`, 82 vitest tests, and four Playwright e2e specs — all gated in CI.

## Commands (from `ora-mvp/`)

| Command | What it does |
|---|---|
| `npm run dev` | Vite HMR dev server (uses `app/src`, proxies nothing — point at a local stack) |
| `npm run build` | `vite build` → `app/dist/` (gitignored) |
| `npm run app` | Build + serve production bundle via `server.js` |
| `npm run app:dev` | Serve without rebuilding (expects `app/dist/`) |
| `npm run typecheck` | `tsc --noEmit` (strict, covers src + tests + e2e) |
| `npm run test:ui` | `vitest run` — server + UI suites |
| `npm run test:e2e` | Playwright e2e — **CI only** (browser binaries + fresh chain stack) |

e2e inventory (4 specs, `e2e/`): boot → faucet → open trove (including the
review-dialog step); mobile 375px viewport + section switching; network
switch mid-session (safe unavailable state on an unpublished testnet,
restore on switch-back); redemption through the full hint pipeline (the
chain is warped past the 14-day bootstrap by `scripts/e2e-warp.js`, with
aggregator refreshes so the oracles stay live).

Local full stack: `npm run chain`, `npm run deploy`, then `npm run app`.

## Server env vars

| Var | Effect |
|---|---|
| `FAUCET_KEY` | Enables `POST /faucet` (100 ORA drip). Local/dev only — never set in production. The UI shows the faucet row iff `/config` reports `faucet: true`. |
| `WALLETCONNECT_PROJECT_ID` | Enables the 📱 WalletConnect button on public nets (mobile wallets, lazy-loaded + QR modal). |
| `LOG_TOKEN` | Bearer token for `GET /log` from non-loopback hosts (loopback is open). |
| `CSP_CONNECT_EXTRA` | Extra `connect-src` origins for the content-security policy. |
| `PORT` | Listen port (default 3000). RPC proxy target is fixed at `127.0.0.1:8545`. |
| `ARENA_PREVIEW_DEMO` | Set to `1` only for an isolated Arena preview to allow the local Hardhat demo on port-prefixed `*.e2b.app` hosts. Unset in normal deployments. |

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
- `views.ts` — read path + rendering (`refresh()`, troves table, health and adjustment previews)
- `actions.ts` — section navigation and button/input wiring
- `activity.ts` — persistent transaction lifecycle/history with explorer links
- `dom.ts` / `format.ts` — typed element access + toast; **all** user-facing number formatting (single `NUMBER_LOCALE`; numeric serialization for `parseEther` deliberately stays locale-free)
- `wallet-gate.ts` — `isLocalhost()` (shared with tests)

## Data refresh & RPC budget

One `refresh()` is a ~22-call batched RPC round-trip. The scheduler in
`main.ts` (policy in `state.ts::nextPollDelayMs`, unit-tested) spends that
quota deliberately:

- healthy: fixed 8s cadence
- failing: exponential backoff 8 → 16 → 32 → 60s cap (the stale-data lockout
  in `views.ts` already pauses risk-increasing actions, so backing off never
  trades safety for quota)
- tab hidden: **no RPC at all**; one immediate catch-up refresh on return
- a transaction in flight (`state.busy`): polling pauses, the `tx()` wrapper
  drives the final refresh

At demo scale this is politeness; on public RPCs it is a product constraint —
budget it accordingly (a subgraph/indexer remains the scale-out path).

## Bundle & performance budget

- Boot path: `index` + `ethers` vendor chunk ≈ **150KB gzipped** total
  (`vite.config.ts` pins ethers in a stable chunk so app deploys don't
  invalidate the big download for returning visitors).
- WalletConnect (~408KB raw, incl. `@walletconnect/core`) is
  dynamic-import-only — fetched when a user actually connects a mobile
  wallet, never at boot.
- Budget rule: keep the boot path ≤ ~170KB gzipped; raise it only with a
  recorded reason. The Phase 3 mobile-first app is a **separate build** with
  its own, tighter budget — this app is the testnet/power-user console and
  stays deliberately lean (no framework, one store, ~100 DOM ids).

## Accessibility

`aria-live` status regions, `role="meter"` with value semantics, visually
hidden labels, `inputmode="decimal"`, a hand-rolled focus trap + `inert`
background in the review dialog, `:focus-visible`, `prefers-reduced-motion`,
`prefers-contrast: more` (brighter muted ramp, thicker borders/focus ring),
and `pointer: coarse` 44px minimum touch targets. e2e asserts the 375px
viewport never overflows horizontally.

## Security properties (tested)

- **Demo keys are localhost-only by default**: `isLocalhost()` gates `setAccount()`
  and local mode. A deliberate `ARENA_PREVIEW_DEMO=1` opt-in enables only the
  port-prefixed Arena sandbox host; the local chain is still reached through
  the app server's loopback RPC proxy. Ordinary public hosts remain blocked.
- **No faucet key in the bundle**: the old client-side drip (broken — it
  signed as an account holding no ORA) is replaced by server-side `/faucet`
  with hourly per-IP/per-address quotas. e2e derives the key from hardhat
  account #4 (treasury); `scripts/e2e-up.sh` asserts the derivation.
- **Fail-closed UI**: missing deployments, read-only mode, and reverts all
  surface as toasts; uncaught errors report to `/log`, never to third parties.
- WalletConnect loads only on public nets with a project id, only when
  clicked (separate chunk), with our own QR modal instead of a modal SDK.
