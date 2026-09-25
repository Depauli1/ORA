// Pure/testable guts of server.js: rate limiting, capped body reads,
// loopback + token auth for the ops log, CSP construction, cache policy.
// No sockets here — wire-up lives in server.js (integration-tested).
const crypto = require("crypto");

// --- rate limiter: fixed window per key, lazy cleanup, bounded memory ---
function createRateLimiter({ windowMs, max, maxKeys = 10000 }) {
  const hits = new Map(); // key -> { count, reset }
  function check(key, now = Date.now()) {
    let e = hits.get(key);
    if (!e || now >= e.reset) {
      e = { count: 0, reset: now + windowMs };
      if (hits.size >= maxKeys) {
        let evicted = false;
        for (const [k, v] of hits) {
          if (now >= v.reset) { hits.delete(k); evicted = true; break; }
        }
        if (!evicted) hits.delete(hits.keys().next().value); // else drop oldest
      }
      hits.set(key, e);
    }
    e.count++;
    const allowed = e.count <= max;
    return { allowed, retryAfterMs: allowed ? 0 : e.reset - now };
  }
  function size() { return hits.size; }
  return { check, size };
}

// --- capped body read: resolves text, rejects {status:413} past maxBytes ---
// Fail-fast: the socket is destroyed the moment the cap trips, so a flooded
// upload dies at the cap instead of draining. Callers must tolerate a dead
// socket when responding (see server.js guards).
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function clientIp(req) {
  const sock = req.socket?.remoteAddress || "";
  const fwd = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  // Trust the proxy header only when the direct peer is loopback (i.e. the
  // sandbox preview proxy / a local reverse proxy in front of us).
  return isLoopbackIp(sock) && fwd ? fwd : sock;
}

function isLoopbackIp(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

// --- ops-log auth: loopback is open (local dev), remote needs LOG_TOKEN ---
function logAccess(req, logToken) {
  if (isLoopbackIp(req.socket?.remoteAddress || "")) return true;
  if (!logToken) return false;
  const q = new URL(req.url || "/", "http://x").searchParams.get("token") || "";
  const h = req.headers.authorization || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7) : "";
  const provided = q || bearer;
  if (!provided) return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(logToken).digest();
  return crypto.timingSafeEqual(a, b);
}

// --- CSP: closed connect-src (local proxy + known RPCs + WalletConnect) ---
const DEFAULT_CONNECT = [
  "'self'",
  "https://sepolia.base.org",
  "https://mainnet.base.org",
  "wss://relay.walletconnect.com",
  "https://rpc.walletconnect.com",
  "https://pulse.walletconnect.com",
];
function buildCSP(extraConnect) {
  const extra = (extraConnect || "").split(/[\s,]+/).filter(Boolean);
  const connect = [...DEFAULT_CONNECT, ...extra].join(" ");
  return (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    `img-src 'self' data:; connect-src ${connect}; object-src 'none'; base-uri 'self'`
  );
}

function securityHeaders(extraConnect) {
  return {
    "content-security-policy": buildCSP(extraConnect),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin-allow-popups",
  };
}

// --- static cache policy: hashed bundle assets immutable, HTML/JSON fresh ---
function cacheControl(urlPath) {
  if (urlPath.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  return "no-cache";
}

module.exports = {
  createRateLimiter, readBody, clientIp, isLoopbackIp, logAccess,
  buildCSP, securityHeaders, cacheControl, DEFAULT_CONNECT,
};
