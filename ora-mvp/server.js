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

const server = http.createServer(async (req, res) => {
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
        res.writeHead(r.status, { "content-type": "application/json" });
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
      "cache-control": "no-cache"
    });
    res.end(data);
  });
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`ORA app listening on http://0.0.0.0:${PORT} (RPC proxy -> ${RPC})`)
);
