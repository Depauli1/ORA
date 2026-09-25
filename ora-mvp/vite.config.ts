import { defineConfig } from "vite";

// Frontend build: app/ is the Vite root, dist/ the served bundle.
// server.js serves dist/ (built) with an app/ fallback for deployment files.
// base "./" keeps asset URLs relative so the same bundle works served from
// any path (local server, GitHub Pages project subpath, IPFS).
export default defineConfig({
  root: "app",
  base: "./",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      output: {
        // Stable vendor chunk: ethers (~300KB) is the bulk of the bundle;
        // pinning it means app-code deploys don't invalidate the big
        // download for returning visitors. WalletConnect (+ its ~408KB
        // @walletconnect/core) is already dynamic-import-only — it is
        // fetched when a user actually connects a mobile wallet, never at
        // boot. First-load JS budget: keep the boot path ≤ ~170KB gzipped
        // (measured: index + ethers ≈ 150KB gz); the Phase 3 mobile-first
        // app gets its own, tighter budget — see app/README.md.
        manualChunks(id: string): string | void {
          if (id.includes("node_modules/ethers")) return "ethers";
        },
      },
    },
  },
  server: {
    port: 5173,
    // `vite dev` DX: API routes still served by node server.js (:3000).
    proxy: {
      "/rpc": "http://127.0.0.1:3000",
      "/log": "http://127.0.0.1:3000",
      "/config": "http://127.0.0.1:3000",
      "/faucet": "http://127.0.0.1:3000",
    },
  },
});
