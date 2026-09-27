// Server coverage suite — drives every /faucet, /rpc, /log and static path
// against real ephemeral servers. The EVM side of the faucet is served by a
// mock JSON-RPC node (single + batched requests), so the full send + receipt
// path runs without a chain.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require("../../server-lib.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createServer } = require("../../server.js");

const FAUCET_KEY = "0x" + "11".repeat(32);
const FAUCET_ADDR = new ethers.Wallet(FAUCET_KEY).address;
const TX_HASH = "0x" + "ab".repeat(32);
const ORA = ethers.getAddress("0x" + "0a".repeat(20));
const ZERO = "0x" + "00".repeat(32);

function mockReq(headers: Record<string, string> = {}, remoteAddress = "1.2.3.4") {
  const e = new EventEmitterish();
  e.headers = headers;
  e.socket = { remoteAddress };
  e.url = "/";
  e.destroy = () => {};
  return e;
}
// minimal req stand-in with just what lib needs
class EventEmitterish {
  handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  headers: Record<string, string> = {};
  socket = { remoteAddress: "" };
  url = "/";
  destroyed = false;
  destroy() { this.destroyed = true; }
  on(ev: string, fn: (...a: unknown[]) => void) { (this.handlers[ev] ||= []).push(fn); return this; }
  emit(ev: string, ...a: unknown[]) { for (const fn of this.handlers[ev] || []) fn(...a); }
}

function req(base: string, method: string, p: string, body?: string, headers: http.OutgoingHttpHeaders = {}, localAddress?: string) {
  return new Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const u = new URL(base + p);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers,
      ...(localAddress ? { localAddress } : {}),
    }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, text: t, headers: res.headers }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

/** Minimal EVM JSON-RPC node: exactly what ethers needs for transfer+wait. */
function startEvmMock() {
  let lastHash = TX_HASH; // a real node answers with keccak256(rawTx); so do we
  const block = {
    number: "0x1", hash: ZERO, parentHash: ZERO, nonce: "0x0000000000000000",
    sha3Uncles: ZERO, logsBloom: "0x" + "0".repeat(512), transactionsRoot: ZERO,
    stateRoot: ZERO, receiptsRoot: ZERO, difficulty: "0x0", gasLimit: "0x1c9c380",
    gasUsed: "0x0", timestamp: "0x68000000", miner: ethers.ZeroAddress,
    extraData: "0x", baseFeePerGas: "0x7", transactions: [], uncles: [],
  };
  const answer = (method: string, params: unknown[] = []): unknown => {
    switch (method) {
      case "eth_chainId": return "0x7a69";
      case "eth_getTransactionCount": return "0x1";
      case "eth_estimateGas": return "0x186a0";
      case "eth_getBlockByNumber": return block;
      case "eth_sendRawTransaction": {
        lastHash = ethers.keccak256(String(params[0]));
        return lastHash;
      }
      case "eth_getTransactionReceipt": return {
        to: ORA.toLowerCase(), from: FAUCET_ADDR.toLowerCase(), contractAddress: null,
        transactionIndex: "0x0", gasUsed: "0x5208", logs: [], blockNumber: "0x1",
        transactionHash: lastHash, blockHash: ZERO, cumulativeGasUsed: "0x5208",
        effectiveGasPrice: "0x7", type: "0x2", status: "0x1", logsBloom: "0x" + "0".repeat(512),
      };
      case "eth_gasPrice": return "0x7";
      case "eth_maxPriorityFeePerGas": return "0x1";
      case "eth_blockNumber": return "0x1";
      default: return "0x1";
    }
  };
  const server = http.createServer((rq, rs) => {
    let raw = "";
    rq.on("data", (c) => (raw += c));
    rq.on("end", () => {
      rs.writeHead(200, { "content-type": "application/json" });
      try {
        const body = JSON.parse(raw);
        if (Array.isArray(body)) {
          rs.end(JSON.stringify(body.map((b) => ({ jsonrpc: "2.0", id: b.id, result: answer(b.method, b.params) }))));
        } else {
          rs.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: answer(body.method, body.params) }));
        }
      } catch { rs.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32700, message: "parse" } })); }
    });
  });
  return new Promise<http.Server>((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const a = server.address();
    resolve(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`);
  }));
}
const close = (server: http.Server) => new Promise((r) => server.close(r));

describe("server-lib edge paths", () => {
  it("rate limiter eviction: drops expired keys first, else the oldest", () => {
    const l = lib.createRateLimiter({ windowMs: 50, max: 5, maxKeys: 3 });
    const t0 = Date.now();
    l.check("a", t0); l.check("b", t0); l.check("c", t0);
    expect(l.size()).toBe(3);
    // window expired: "a" is expired → evicted to make room for "d"
    l.check("d", t0 + 200);
    expect(l.size()).toBe(3);
    // all fresh (new window): oldest-inserted ("b") is dropped
    l.check("e", t0 + 400);
    expect(l.size()).toBe(3);
  });

  it("readBody rejects on socket error", async () => {
    const r = mockReq();
    const p = lib.readBody(r as never, 10);
    r.emit("error", new Error("socket died"));
    await expect(p).rejects.toThrow("socket died");
  });

  it("clientIp trusts x-forwarded-for only from a loopback peer", () => {
    expect(lib.clientIp(mockReq({ "x-forwarded-for": "9.9.9.9, 8.8.8.8" }, "127.0.0.1"))).toBe("9.9.9.9");
    expect(lib.clientIp(mockReq({ "x-forwarded-for": "9.9.9.9" }, "10.0.0.5"))).toBe("10.0.0.5");
    expect(lib.clientIp(mockReq({}, "127.0.0.1"))).toBe("127.0.0.1");
  });
});

describe("faucet flow against a mock EVM node", () => {
  let evm: http.Server, evmBase = "", base = "", server: http.Server;
  const appDir = path.join(__dirname, "..");

  beforeAll(async () => {
    evm = await startEvmMock();
    const a = evm.address();
    evmBase = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    server = createServer({ appDir, faucetKey: FAUCET_KEY, rpcUrl: evmBase });
    base = await listen(server);
  });
  afterAll(async () => { await close(server); await close(evm); });

  const A1 = "0x" + "01".repeat(20);
  const A2 = "0x" + "02".repeat(20);
  const A3 = "0x" + "03".repeat(20);
  const A4 = "0x" + "04".repeat(20);
  const A5 = "0x" + "05".repeat(20);
  const A6 = "0x" + "06".repeat(20);

  it("drips through the full send + receipt path and rate-limits per address", async () => {
    const ok = await req(base, "POST", "/faucet", JSON.stringify({ to: A1 }));
    expect(ok.status).toBe(200);
    const out = JSON.parse(ok.text);
    expect(out.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    // same address again within the hour → 429 (1/hour per address)
    const dup = await req(base, "POST", "/faucet", JSON.stringify({ to: A1 }));
    expect(dup.status).toBe(429);
    expect(JSON.parse(dup.text).error).toMatch(/1\/hour per address/);
  });

  it("rate-limits per IP after five drips", async () => {
    for (const to of [A2, A3, A4]) {
      const r = await req(base, "POST", "/faucet", JSON.stringify({ to }));
      expect(r.status).toBe(200); // drips 3..5 of the hour (A1 counted twice)
    }
    const sixth = await req(base, "POST", "/faucet", JSON.stringify({ to: A5 }));
    expect(sixth.status).toBe(429);
    expect(JSON.parse(sixth.text).error).toMatch(/5\/hour per IP/);
  });

  it("validates the request body", async () => {
    const badJson = await req(base, "POST", "/faucet", "not-json-at-all");
    expect(badJson.status).toBe(400);
    const noTo = await req(base, "POST", "/faucet", JSON.stringify({ to: "" }));
    expect(noTo.status).toBe(400);
    const empty = await req(base, "POST", "/faucet", ""); // parses as {} → 400
    expect(empty.status).toBe(400);
  });
});

describe("faucet failure paths", () => {
  const appDir = path.join(__dirname, "..");

  it("reports 502 when the chain is unreachable, on both chain continuations", async () => {
    const server = createServer({ appDir, faucetKey: FAUCET_KEY, rpcUrl: "http://127.0.0.1:1" });
    const base = await listen(server);
    try {
      const first = await req(base, "POST", "/faucet", JSON.stringify({ to: "0x" + "01".repeat(20) }));
      expect(first.status).toBe(502);
      expect(first.text).toMatch(/faucet send failed/);
      // the second request runs on the rejected-continuation of the send chain
      const second = await req(base, "POST", "/faucet", JSON.stringify({ to: "0x" + "02".repeat(20) }));
      expect(second.status).toBe(502);
    } finally { await close(server); }
  });

  it("reports 502 when the local deployment has no ORA token", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ora-app-"));
    fs.writeFileSync(path.join(tmp, "deployment.json"), JSON.stringify({ shared: {} }));
    fs.writeFileSync(path.join(tmp, "index.html"), "<html>tmp</html>");
    const server = createServer({ appDir: tmp, faucetKey: FAUCET_KEY, rpcUrl: "http://127.0.0.1:1" });
    const base = await listen(server);
    try {
      const r = await req(base, "POST", "/faucet", JSON.stringify({ to: "0x" + "01".repeat(20) }));
      expect(r.status).toBe(502);
      expect(r.text).toMatch(/no shared.oraToken/);
    } finally { await close(server); fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe("JSON-RPC proxy", () => {
  let upstream: http.Server, base = "", server: http.Server;

  beforeAll(async () => {
    upstream = http.createServer((rq, rs) => {
      let body = "";
      rq.on("data", (c) => (body += c));
      rq.on("end", () => {
        if (body.includes("boom500")) { rs.writeHead(500, { "content-type": "application/json" }); return rs.end('{"error":"boom"}'); }
        if (body.includes("hugeHeader")) { rs.writeHead(200, { "content-length": String(6 * 1024 * 1024) }); return rs.end("{}"); }
        if (body.includes("hugeBody")) { rs.writeHead(200, { "content-type": "application/json" }); return rs.end("x".repeat(6 * 1024 * 1024)); }
        rs.writeHead(200, { "content-type": "application/json" });
        rs.end('{"jsonrpc":"2.0","id":1,"result":"0x7a69"}');
      });
    });
    const uBase = await listen(upstream);
    server = createServer({ appDir: path.join(__dirname, ".."), rpcUrl: uBase + "/rpc" });
    base = await listen(server);
  });
  afterAll(async () => { await close(server); await close(upstream); });

  it("proxies JSON-RPC verbatim (status + body)", async () => {
    const r = await req(base, "POST", "/rpc", '{"method":"eth_chainId","params":[],"id":1}');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).result).toBe("0x7a69");
  });

  it("passes through upstream error statuses", async () => {
    const r = await req(base, "POST", "/rpc", '{"method":"boom500"}');
    expect(r.status).toBe(500);
  });

  it("rejects oversized upstream responses (declared and streamed)", async () => {
    const declared = await req(base, "POST", "/rpc", '{"method":"hugeHeader"}');
    expect(declared.status).toBe(502);
    expect(declared.text).toMatch(/upstream response too large/);
    const streamed = await req(base, "POST", "/rpc", '{"method":"hugeBody"}');
    expect(streamed.status).toBe(502);
  }, 20000);

  it("reports 502 when the chain is unreachable", async () => {
    const s2 = createServer({ appDir: path.join(__dirname, ".."), rpcUrl: "http://127.0.0.1:1" });
    const b2 = await listen(s2);
    try {
      const r = await req(b2, "POST", "/rpc", '{"method":"eth_chainId"}');
      expect(r.status).toBe(502);
      expect(r.text).toMatch(/chain unreachable/);
    } finally { await close(s2); }
  });
});

describe("ops log", () => {
  const appDir = path.join(__dirname, "..");
  // A non-loopback source address exercises the token-gated remote path.
  const external = Object.values(os.networkInterfaces())
    .flat().find((i): i is os.NetworkInterfaceInfo => !!i && i.family === "IPv4" && !i.internal);

  it("POST accepts malformed JSON silently (still 204)", async () => {
    const server = createServer({ appDir });
    const base = await listen(server);
    try {
      const r = await req(base, "POST", "/log", "{not-json");
      expect(r.status).toBe(204);
    } finally { await close(server); }
  });

  it.skipIf(!external)("GET is 403 for remote peers without the token, 200 with it", async () => {
    const server = createServer({ appDir, logToken: "t0psekret" });
    const base = await listen(server);
    try {
      const denied = await req(base, "GET", "/log", undefined, {}, external!.address);
      expect(denied.status).toBe(403);
      expect(denied.text).toMatch(/forbidden/);
      const allowed = await req(base, "GET", "/log?token=t0psekret", undefined, {}, external!.address);
      expect(allowed.status).toBe(200);
    } finally { await close(server); }
  });
});

describe("static file serving", () => {
  it("serves built dist/ first, falls back to the legacy app dir", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ora-dist-"));
    fs.mkdirSync(path.join(tmp, "dist"));
    fs.writeFileSync(path.join(tmp, "dist", "index.html"), "<html>built</html>");
    fs.writeFileSync(path.join(tmp, "dist", "only-dist.txt"), "from-dist");
    fs.writeFileSync(path.join(tmp, "index.html"), "<html>legacy</html>");
    fs.writeFileSync(path.join(tmp, "legacy-only.txt"), "from-app");
    fs.writeFileSync(path.join(tmp, "deployment.json"), "{}");
    fs.writeFileSync(path.join(tmp, "data.bin"), "\x00\x01");
    const server = createServer({ appDir: tmp }); // dist/ present → built-first roots
    const base = await listen(server);
    try {
      expect((await req(base, "GET", "/")).text).toContain("built"); // dist wins over app/index.html
      expect((await req(base, "GET", "/only-dist.txt")).text).toBe("from-dist");
      expect((await req(base, "GET", "/legacy-only.txt")).text).toBe("from-app"); // app-dir fallback root
      const bin = await req(base, "GET", "/data.bin");
      expect(bin.status).toBe(200);
      expect(bin.headers["content-type"]).toBe("application/octet-stream"); // unknown extension
      expect((await req(base, "GET", "/deployment.json")).status).toBe(200);
      expect((await req(base, "GET", "/nope.txt")).status).toBe(404);
    } finally { await close(server); fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it("legacy app dir serves when dist is absent", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ora-legacy-"));
    fs.writeFileSync(path.join(tmp, "index.html"), "<html>legacy</html>");
    fs.writeFileSync(path.join(tmp, "deployment.json"), "{}");
    const server = createServer({ appDir: tmp }); // no dist/ → legacy roots
    const base = await listen(server);
    try {
      const idx = await req(base, "GET", "/");
      expect(idx.status).toBe(200);
      expect(idx.text).toContain("legacy");
      expect(idx.headers["cache-control"]).toBe("no-cache");
      // a directory under the app root falls through every root → 404
      fs.mkdirSync(path.join(tmp, "assets"));
      const dir = await req(base, "GET", "/assets");
      expect(dir.status).toBe(404);
    } finally { await close(server); fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it("raw .. traversal is refused before touching the filesystem", async () => {
    const server = createServer({ appDir: path.join(__dirname, "..") });
    const base = await listen(server);
    try {
      const u = new URL(base);
      const raw: string = await new Promise((resolve, reject) => {
        const s = net.connect(Number(u.port), "127.0.0.1", () => s.write("GET /../package.json HTTP/1.0\r\n\r\n"));
        let t = "";
        s.on("data", (c) => (t += c));
        s.on("end", () => resolve(t));
        s.on("error", reject);
      });
      expect(raw).toMatch(/^HTTP\/1\.[01] 403/);
    } finally { await close(server); }
  });
});

describe("rate limits and log retention", () => {
  it("trips the global 120/min limiter on every API route", async () => {
    const server = createServer({ appDir: path.join(__dirname, "..") }); // no faucet key
    const base = await listen(server);
    try {
      for (let i = 0; i < 120; i++) {
        const r = await req(base, "GET", "/config");
        expect(r.status).toBe(200);
      }
      // 121st request from this IP → 429 on each API route in turn
      for (const p of ["/faucet", "/log", "/rpc"]) {
        const r = await req(base, "POST", p, "{}");
        expect(r.status).toBe(429);
      }
      expect((await req(base, "GET", "/log")).status).toBe(429);
    } finally { await close(server); }
  }, 20000);

  it("caps the client-error ring buffer at 200 entries", async () => {
    const server = createServer({ appDir: path.join(__dirname, "..") });
    const base = await listen(server);
    try {
      // alternate loopback source IPs so the global 120/min limiter never trips;
      // empty bodies parse as "{}" and every POST lands in the ring buffer
      for (let i = 0; i < 205; i++) {
        const r = await req(base, "POST", "/log", "", {}, i % 2 ? "127.0.0.1" : "127.0.0.2");
        expect(r.status).toBe(204);
      }
      const log = await req(base, "GET", "/log"); // loopback is open by default
      expect(log.status).toBe(200);
      expect(JSON.parse(log.text).length).toBe(200); // oldest entries shifted out
    } finally { await close(server); }
  }, 20000);
});

describe("standalone entry", () => {
  it("startServerFromEnv listens on PORT and serves /config", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    // @ts-expect-error server.js is plain CommonJS without declarations
    const { startServerFromEnv } = require("../../server.js") as typeof import("../../server.js");
    process.env.PORT = "3988";
    const server = startServerFromEnv();
    try {
      const r = await req("http://127.0.0.1:3988", "GET", "/config");
      expect(r.status).toBe(200);
    } finally {
      delete process.env.PORT;
      await close(server);
    }
  });

  it("startServerFromEnv defaults to port 3000 when PORT is unset", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    // @ts-expect-error server.js is plain CommonJS without declarations
    const { startServerFromEnv } = require("../../server.js") as typeof import("../../server.js");
    delete process.env.PORT;
    const server = startServerFromEnv();
    try {
      const r = await req("http://127.0.0.1:3000", "GET", "/config");
      expect(r.status).toBe(200);
    } finally {
      await close(server);
    }
  });

  it("node server.js listens on PORT and serves /config", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const child = spawn(process.execPath, [path.join(__dirname, "..", "..", "server.js")], {
      env: { ...process.env, PORT: "3987", FAUCET_KEY: "" },
      stdio: "ignore",
    });
    try {
      let status = 0;
      for (let i = 0; i < 40 && status === 0; i++) {
        try { status = (await req("http://127.0.0.1:3987", "GET", "/config")).status; } catch { status = 0; }
        if (status !== 200) await new Promise((r) => setTimeout(r, 100));
      }
      expect(status).toBe(200);
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 8000);
});
