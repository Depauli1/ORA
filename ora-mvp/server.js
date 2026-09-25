// ORA app server — serves the built frontend, proxies JSON-RPC to the local
// chain (browser talks to relative URLs only), serves runtime config, and
// drips test ORA from a server-side faucet key on local dev chains.
//
// Hardening: per-IP rate limits, request body caps, token-or-loopback ops
// log, closed CSP connect-src, immutable caching for hashed bundle assets.
// No framework: raw node http keeps the supply chain to one runtime dep
// (ethers, for the faucet signer).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const lib = require("./server-lib");

const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
};

const FAUCET_AMOUNT = ethers.parseEther("100"); // 100 test ORA per drip

function createServer(opts = {}) {
  const {
    rpcUrl = "http://127.0.0.1:8545",
    logToken = process.env.LOG_TOKEN || "",
    faucetKey = process.env.FAUCET_KEY || "",
    wcProjectId = process.env.WALLETCONNECT_PROJECT_ID || "",
    cspExtra = process.env.CSP_CONNECT_EXTRA || "",
    appDir = path.join(__dirname, "app"),
  } = opts;
  const H = () => lib.securityHeaders(cspExtra);
  const distDir = path.join(appDir, "dist");
  const useDist = fs.existsSync(path.join(distDir, "index.html"));
  if (!useDist) console.warn("[server] app/dist missing — serving legacy app/ dir (run `vite build` first)");

  const apiLimit = lib.createRateLimiter({ windowMs: 60_000, max: 120 });
  const faucetIpLimit = lib.createRateLimiter({ windowMs: 3_600_000, max: 5 });
  const faucetAddrLimit = lib.createRateLimiter({ windowMs: 3_600_000, max: 1 });
  const clientErrors = [];
  let faucetChain = Promise.resolve(); // serializes faucet sends (nonce safety)

  function limited(res, ip) {
    const r = apiLimit.check(ip);
    if (!r.allowed) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(Math.ceil(r.retryAfterMs / 1000)), ...H() });
      res.end(JSON.stringify({ error: "rate limited" }));
      return true;
    }
    return false;
  }

  async function faucetSend(to) {
    const depPath = path.join(appDir, "deployment.json");
    const dep = JSON.parse(fs.readFileSync(depPath));
    const oraAddr = dep.shared?.oraToken;
    if (!oraAddr) throw new Error("local deployment.json has no shared.oraToken");
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(faucetKey, provider);
    const ora = new ethers.Contract(oraAddr, ["function transfer(address,uint256) returns (bool)"], signer);
    const tx = await ora.transfer(to, FAUCET_AMOUNT);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || "/").split("?")[0];
    const ip = lib.clientIp(req);

    // Runtime config for the frontend (faucet availability, WC project id).
    // Public by design — contains no secrets.
    if (urlPath === "/config" && req.method === "GET") {
      if (limited(res, ip)) return;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache", ...H() });
      return res.end(JSON.stringify({
        faucet: faucetKey !== "",
        walletConnectProjectId: wcProjectId || null,
      }));
    }

    // Local-dev ORA drip. Serves the LOCAL chain only (rpcUrl is loopback);
    // on any public deploy FAUCET_KEY is unset and this returns 503.
    if (urlPath === "/faucet" && req.method === "POST") {
      if (limited(res, ip)) return;
      if (!faucetKey) {
        res.writeHead(503, { "content-type": "application/json", ...H() });
        return res.end(JSON.stringify({ error: "faucet not configured (FAUCET_KEY unset)" }));
      }
      let body;
      try {
        body = await lib.readBody(req, 1024);
      } catch (e) {
        if (req.destroyed) return; // fail-fast under flood: socket already gone
        res.writeHead(e.status || 500, { "content-type": "application/json", ...H() });
        return res.end(JSON.stringify({ error: e.message }));
      }
      let to;
      try {
        to = JSON.parse(body || "{}").to;
      } catch { to = null; }
      if (!to || !ethers.isAddress(to)) {
        res.writeHead(400, { "content-type": "application/json", ...H() });
        return res.end(JSON.stringify({ error: "body must be JSON {to: 0x-address}" }));
      }
      const byIp = faucetIpLimit.check("faucet:" + ip);
      const byAddr = faucetAddrLimit.check("faucet-addr:" + String(to).toLowerCase());
      if (!byIp.allowed || !byAddr.allowed) {
        const waitMs = Math.max(byIp.retryAfterMs, byAddr.retryAfterMs);
        res.writeHead(429, { "content-type": "application/json", "retry-after": String(Math.ceil(waitMs / 1000)), ...H() });
        return res.end(JSON.stringify({ error: "faucet rate limited (5/hour per IP, 1/hour per address)" }));
      }
      try {
        const hash = await (faucetChain = faucetChain.then(() => faucetSend(to), () => faucetSend(to)));
        res.writeHead(200, { "content-type": "application/json", ...H() });
        return res.end(JSON.stringify({ txHash: hash }));
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json", ...H() });
        return res.end(JSON.stringify({ error: "faucet send failed: " + String(e.shortMessage || e.message).slice(0, 200) }));
      }
    }

    // Client error reporter (frontend POSTs uncaught errors here)
    if (urlPath === "/log" && req.method === "POST") {
      if (limited(res, ip)) return;
      let body;
      try {
        body = await lib.readBody(req, 10 * 1024);
      } catch (e) {
        if (req.destroyed) return; // fail-fast under flood: socket already gone
        res.writeHead(e.status || 500, { "content-type": "application/json", ...H() });
        return res.end(JSON.stringify({ error: e.message }));
      }
      try {
        const e = JSON.parse(body || "{}");
        const entry = { ts: new Date().toISOString(), ...e };
        clientErrors.push(entry);
        if (clientErrors.length > 200) clientErrors.shift();
        console.error("[client-error]", entry.ts, (entry.message || "").slice(0, 300));
      } catch {}
      res.writeHead(204, H());
      return res.end();
    }
    // Ops view of collected client errors: loopback-open, else LOG_TOKEN
    if (urlPath === "/log" && req.method === "GET") {
      if (limited(res, ip)) return;
      if (!lib.logAccess(req, logToken)) {
        res.writeHead(403, { "content-type": "application/json", ...H() });
        return res.end(JSON.stringify({ error: "forbidden: set LOG_TOKEN and pass ?token= (loopback is open by default)" }));
      }
      res.writeHead(200, { "content-type": "application/json", ...H() });
      return res.end(JSON.stringify(clientErrors, null, 2));
    }

    // JSON-RPC proxy (1MB request cap, 5MB upstream response cap)
    if (urlPath === "/rpc" && req.method === "POST") {
      if (limited(res, ip)) return;
      let body;
      try {
        body = await lib.readBody(req, 1024 * 1024);
      } catch (e) {
        if (req.destroyed) return; // fail-fast under flood: socket already gone
        res.writeHead(e.status || 500, { "content-type": "application/json", ...H() });
        return res.end(JSON.stringify({ error: e.message }));
      }
      try {
        const r = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        const len = Number(r.headers.get("content-length") || 0);
        if (len > 5 * 1024 * 1024) throw new Error("upstream response too large");
        const text = await r.text();
        if (text.length > 5 * 1024 * 1024) throw new Error("upstream response too large");
        res.writeHead(r.status, { "content-type": "application/json", ...H() });
        return res.end(text);
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json", ...H() });
        return res.end(JSON.stringify({ error: "chain unreachable: " + String(e.message).slice(0, 200) }));
      }
    }

    // Static files: built dist/ first, legacy app/ fallback
    let p = urlPath;
    if (p === "/") p = "/index.html";
    const roots = useDist ? [distDir, appDir] : [appDir];
    for (const root of roots) {
      const file = path.normalize(path.join(root, p));
      if (!file.startsWith(root)) {
        res.writeHead(403, H());
        return res.end();
      }
      try {
        const data = fs.readFileSync(file);
        if (fs.statSync(file).isDirectory()) continue;
        res.writeHead(200, {
          "content-type": MIME[path.extname(file)] || "application/octet-stream",
          "cache-control": lib.cacheControl(p),
          ...H(),
        });
        return res.end(data);
      } catch { /* try next root */ }
    }
    res.writeHead(404, H());
    return res.end("not found");
  });

  return server;
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  createServer().listen(PORT, "0.0.0.0", () =>
    console.log(`ORA app listening on http://0.0.0.0:${PORT} (RPC proxy -> http://127.0.0.1:8545)`)
  );
}

module.exports = { createServer };
