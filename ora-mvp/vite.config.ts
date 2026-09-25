import { defineConfig } from "vite";

// Frontend build: app/ is the Vite root, dist/ the served bundle.
// server.js serves dist/ (built) with an app/ fallback for deployment files.
export default defineConfig({
  root: "app",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
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
