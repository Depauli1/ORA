// ORA app server — serves the static frontend and proxies JSON-RPC to the
// local chain so the browser only ever talks to relative URLs.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const RPC = "http://127.0.0.1:8545";
const ROOT = path.join(__dirname, "app");

const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

// Security headers. connect-src allows self (local RPC proxy) + https/wss
// (public RPCs reached directly from the browser on Base/Base Sepolia).
// frame-ancestors stays open: the app is designed to run inside preview iframes.
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self' https: wss:; object-src 'none'; base-uri 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};

// In-memory ring buffer of client-side errors (error tracking without any
// third-party dependency; swap for Sentry/OTel on a production deploy).
const clientErrors = [];

const server = http.createServer(async (req, res) => {
  // Client error reporter: the frontend POSTs uncaught errors here
  if (req.url === "/log" && req.method === "POST") {
    let body = "";
    req.on("data", c => (body += c.length + body.length > 10000 ? "" : c));
    req.on("end", () => {
      try {
        const e = JSON.parse(body || "{}");
        const entry = { ts: new Date().toISOString(), ...e };
        clientErrors.push(entry);
        if (clientErrors.length > 200) clientErrors.shift();
        console.error("[client-error]", entry.ts, (entry.message || "").slice(0, 300));
      } catch {}
      res.writeHead(204, SECURITY_HEADERS);
      res.end();
    });
    return;
  }
  // Ops view of collected client errors
  if (req.url === "/log" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json", ...SECURITY_HEADERS });
    return res.end(JSON.stringify(clientErrors, null, 2));
  }

  // JSON-RPC proxy
  if (req.url === "/rpc" && req.method === "POST") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      try {
        const r = await fetch(RPC, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body
        });
        const text = await r.text();
        res.writeHead(r.status, { "content-type": "application/json", ...SECURITY_HEADERS });
        res.end(text);
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "chain unreachable: " + e.message }));
      }
    });
    return;
  }

  // Static files
  let p = req.url.split("?")[0];
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-cache",
      ...SECURITY_HEADERS
    });
    res.end(data);
  });
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`ORA app listening on http://0.0.0.0:${PORT} (RPC proxy -> ${RPC})`)
);
