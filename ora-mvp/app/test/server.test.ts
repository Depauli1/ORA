// server.js hardening: rate limits, body caps, ops-log auth, CSP, cache
// policy, faucet validation. Unit tests for server-lib + integration tests
// against a real ephemeral server (no chain needed except faucet sends,
// which the e2e covers).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require("../../server-lib.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createServer } = require("../../server.js");

function mockReq(headers: Record<string, string> = {}, remoteAddress = "1.2.3.4") {
  const e = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
    socket: { remoteAddress: string };
    url: string;
    destroy: () => void;
  };
  e.headers = headers;
  e.socket = { remoteAddress };
  e.url = "/";
  e.destroy = () => {};
  return e;
}

describe("server-lib", () => {
  it("rate limiter allows max, then blocks until the window resets", () => {
    const l = lib.createRateLimiter({ windowMs: 1000, max: 3 });
    expect(l.check("ip").allowed).toBe(true);
    expect(l.check("ip").allowed).toBe(true);
    expect(l.check("ip").allowed).toBe(true);
    const blocked = l.check("ip");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    // other keys unaffected; window reset re-allows
    expect(l.check("other").allowed).toBe(true);
    expect(l.check("ip", Date.now() + 1001).allowed).toBe(true);
  });

  it("rate limiter bounds memory", () => {
    const l = lib.createRateLimiter({ windowMs: 60_000, max: 1, maxKeys: 10 });
    for (let i = 0; i < 50; i++) l.check("k" + i);
    expect(l.size()).toBeLessThanOrEqual(10);
  });

  it("readBody resolves small bodies, 413s past the cap", async () => {
    const ok = mockReq();
    const p1 = lib.readBody(ok, 10);
    ok.emit("data", Buffer.from("hello"));
    ok.emit("end");
    await expect(p1).resolves.toBe("hello");

    const big = mockReq();
    let destroyed = false;
    big.destroy = () => { destroyed = true; };
    const p2 = lib.readBody(big, 4);
    big.emit("data", Buffer.from("hello"));
    await expect(p2).rejects.toMatchObject({ status: 413 });
    expect(destroyed).toBe(true);
  });

  it("loopback detection covers v4, v6 and mapped forms", () => {
    expect(lib.isLoopbackIp("127.0.0.1")).toBe(true);
    expect(lib.isLoopbackIp("::1")).toBe(true);
    expect(lib.isLoopbackIp("::ffff:127.0.0.1")).toBe(true);
    expect(lib.isLoopbackIp("10.0.0.1")).toBe(false);
    expect(lib.isLoopbackIp("")).toBe(false);
  });

  it("ops-log auth: loopback open, remote needs the token", () => {
    const lo = mockReq({}, "127.0.0.1");
    expect(lib.logAccess(lo, "")).toBe(true);
    const remote = mockReq({ authorization: "" }, "8.8.8.8");
    expect(lib.logAccess(remote, "")).toBe(false); // no token configured: deny
    expect(lib.logAccess(remote, "sekret")).toBe(false); // none provided
    remote.url = "/log?token=sekret";
    expect(lib.logAccess(remote, "sekret")).toBe(true);
    remote.url = "/log?token=wrong";
    expect(lib.logAccess(remote, "sekret")).toBe(false);
    remote.url = "/log";
    remote.headers = { authorization: "Bearer sekret" };
    expect(lib.logAccess(remote, "sekret")).toBe(true);
  });

  it("CSP has a closed connect-src with an env escape hatch", () => {
    const csp = lib.buildCSP("");
    expect(csp).toContain("connect-src 'self' https://sepolia.base.org");
    expect(csp).toContain("wss://relay.walletconnect.com");
    expect(csp).not.toMatch(/https: wss:/); // no broad wildcards
    expect(lib.buildCSP("https://custom-rpc.example")).toContain("https://custom-rpc.example");
  });

  it("cache policy: immutable hashed assets, fresh HTML/JSON", () => {
    expect(lib.cacheControl("/assets/index-abc123.js")).toContain("immutable");
    expect(lib.cacheControl("/index.html")).toBe("no-cache");
    expect(lib.cacheControl("/deployment.json")).toBe("no-cache");
  });
});

describe("server integration", () => {
  let base = "";
  let server: http.Server;
  const appDir = path.join(__dirname, "..");

  function req(method: string, p: string, body?: string): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const r = http.request(base + p, { method }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, text: t, headers: res.headers }));
      });
      r.on("error", reject);
      if (body) r.write(body);
      r.end();
    });
  }

  beforeAll(async () => {
    server = createServer({ appDir, logToken: "t0psekret", faucetKey: "", wcProjectId: "" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" ? addr?.port : 0}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("GET /config reports faucet + WalletConnect availability", async () => {
    const r = await req("GET", "/config");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ faucet: false, walletConnectProjectId: null });
  });

  it("client-error round trip: POST then loopback GET", async () => {
    const post = await req("POST", "/log", JSON.stringify({ kind: "error", message: "boom-test-marker" }));
    expect(post.status).toBe(204);
    const get = await req("GET", "/log");
    expect(get.status).toBe(200);
    expect(get.text).toContain("boom-test-marker");
  });

  it("flooded /rpc upload dies at the cap (fail-fast reset)", async () => {
    // The server destroys the socket past 1MB instead of buffering or
    // proxying: the client sees a reset, never a proxied response.
    await expect(req("POST", "/rpc", "x".repeat(2 * 1024 * 1024))).rejects.toThrow(/ECONNRESET/);
  }, 15000);

  it("faucet without a key is 503, with a key validates the address", async () => {
    const off = await req("POST", "/faucet", JSON.stringify({ to: "0x0000000000000000000000000000000000000001" }));
    expect(off.status).toBe(503);
    // spin a keyed server just for validation paths (no chain touched)
    const keyed = createServer({ appDir, faucetKey: "0x" + "11".repeat(32) });
    await new Promise<void>((resolve) => keyed.listen(0, "127.0.0.1", resolve));
    const a = keyed.address();
    const kb = `http://127.0.0.1:${typeof a === "object" ? a?.port : 0}`;
    try {
      const bad: { status: number } = await new Promise((resolve, reject) => {
        const r = http.request(kb + "/faucet", { method: "POST" }, (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode || 0 }));
        });
        r.on("error", reject);
        r.write(JSON.stringify({ to: "not-an-address" }));
        r.end();
      });
      expect(bad.status).toBe(400);
    } finally {
      await new Promise((resolve) => keyed.close(resolve));
    }
  });

  it("static: index served, missing 404s, traversal 403s", async () => {
    const idx = await req("GET", "/");
    expect(idx.status).toBe(200);
    expect(idx.headers["content-security-policy"]).toContain("connect-src");
    expect(idx.headers["cache-control"]).toBe("no-cache");
    const miss = await req("GET", "/nope-xyz.html");
    expect(miss.status).toBe(404);
    // raw socket: literal .. survives (clients may normalize it first)
    const raw: string = await new Promise((resolve, reject) => {
      const u = new URL(base);
      const s = net.connect(Number(u.port), "127.0.0.1", () => s.write("GET /../package.json HTTP/1.0\r\n\r\n"));
      let t = "";
      s.on("data", (c) => (t += c));
      s.on("end", () => resolve(t));
      s.on("error", reject);
    });
    expect(raw).toMatch(/^HTTP\/1\.[01] 403/);
  });

  it("global rate limit trips at 120 req/min per IP", async () => {
    // fresh server: exact budget accounting
    const s2 = createServer({ appDir });
    await new Promise<void>((resolve) => s2.listen(0, "127.0.0.1", resolve));
    const a = s2.address();
    const b2 = `http://127.0.0.1:${typeof a === "object" ? a?.port : 0}`;
    try {
      let last = 0;
      for (let i = 0; i < 121; i++) {
        const st: number = await new Promise((resolve, reject) => {
          http.get(b2 + "/config", (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode || 0));
          }).on("error", reject);
        });
        last = st;
      }
      expect(last).toBe(429);
    } finally {
      await new Promise((resolve) => s2.close(resolve));
    }
  }, 20000);
});
