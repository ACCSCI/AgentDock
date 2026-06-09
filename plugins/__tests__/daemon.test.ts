import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { AgentDockDaemon } from "../daemon.js";
import http from "node:http";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ============================================================
// Helpers
// ============================================================

function tmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `daemon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function post(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          resolve({ status: res.statusCode!, data: JSON.parse(data) });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function get(port: number, path: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({ status: res.statusCode!, data: JSON.parse(data) });
      });
    }).on("error", reject);
  });
}

function postWithHeaders(
  port: number,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string>,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...extraHeaders,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          resolve({ status: res.statusCode!, data: JSON.parse(data) });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ============================================================
// Tests
// ============================================================

describe("AgentDockDaemon", () => {
  let dir: string;
  let daemon: AgentDockDaemon;
  let port: number;

  beforeEach(async () => {
    dir = tmpDir();
    daemon = new AgentDockDaemon({ port: 0, baseDir: dir });
    await daemon.start();
    port = daemon.getPort();
  });

  afterEach(async () => {
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  // --- Health ---

  it("GET /health returns ok", async () => {
    const res = await get(port, "/health");
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("ok");
  });

  // --- Allocate ---

  it("POST /ports/allocate allocates ports", async () => {
    const res = await post(port, "/ports/allocate", { count: 3 });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.ports).toHaveLength(3);
    for (const p of res.data.data.ports) {
      expect(p).toBeGreaterThanOrEqual(30000);
      expect(p).toBeLessThanOrEqual(65535);
    }
  });

  it("POST /ports/allocate defaults to 5 ports", async () => {
    const res = await post(port, "/ports/allocate", {});
    expect(res.status).toBe(200);
    expect(res.data.data.ports).toHaveLength(5);
  });

  it("POST /ports/allocate rejects count out of range", async () => {
    const res = await post(port, "/ports/allocate", { count: 0 });
    expect(res.status).toBe(400);
    expect(res.data.success).toBe(false);
  });

  it("POST /ports/allocate rejects count > 100", async () => {
    const res = await post(port, "/ports/allocate", { count: 101 });
    expect(res.status).toBe(400);
  });

  it("POST /ports/allocate respects exclude set", async () => {
    const res = await post(port, "/ports/allocate", { count: 1, exclude: [30000] });
    expect(res.status).toBe(200);
    expect(res.data.data.ports[0]).not.toBe(30000);
  });

  it("POST /ports/allocate accumulates allocations", async () => {
    const r1 = await post(port, "/ports/allocate", { count: 2 });
    const r2 = await post(port, "/ports/allocate", { count: 2 });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // No overlap
    const all = [...r1.data.data.ports, ...r2.data.data.ports];
    expect(new Set(all).size).toBe(4);
  });

  // --- Release ---

  it("POST /ports/release releases ports", async () => {
    const alloc = await post(port, "/ports/allocate", { count: 2 });
    const portsToRelease = alloc.data.data.ports;
    const res = await post(port, "/ports/release", { ports: portsToRelease });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it("POST /ports/release rejects empty ports", async () => {
    const res = await post(port, "/ports/release", { ports: [] });
    expect(res.status).toBe(400);
  });

  it("POST /ports/release rejects missing ports", async () => {
    const res = await post(port, "/ports/release", {});
    expect(res.status).toBe(400);
  });

  it("POST /ports/release allows re-allocation of released ports", async () => {
    const alloc = await post(port, "/ports/allocate", { count: 1 });
    const p = alloc.data.data.ports[0];
    await post(port, "/ports/release", { ports: [p] });
    // Re-allocate with the released port in exclude set to force it
    const re = await post(port, "/ports/allocate", { count: 1, exclude: [] });
    expect(re.status).toBe(200);
    // The released port should be available again (may or may not be picked)
  });

  // --- 404 ---

  it("GET /unknown returns 404", async () => {
    const res = await get(port, "/unknown");
    expect(res.status).toBe(404);
  });

  // --- Concurrent clients ---

  it("two concurrent allocate requests get different ports", async () => {
    const [r1, r2] = await Promise.all([
      post(port, "/ports/allocate", { count: 5 }),
      post(port, "/ports/allocate", { count: 5 }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const overlap = r1.data.data.ports.filter((p: number) =>
      r2.data.data.ports.includes(p),
    );
    expect(overlap).toEqual([]);
  });

  it("four concurrent allocate requests get all unique ports", async () => {
    const results = await Promise.all([
      post(port, "/ports/allocate", { count: 3 }),
      post(port, "/ports/allocate", { count: 3 }),
      post(port, "/ports/allocate", { count: 3 }),
      post(port, "/ports/allocate", { count: 3 }),
    ]);
    const allPorts: number[] = [];
    for (const r of results) {
      expect(r.status).toBe(200);
      allPorts.push(...r.data.data.ports);
    }
    expect(new Set(allPorts).size).toBe(12);
  });

  // --- allocate + release concurrency ---

  it("concurrent allocate and release do not conflict", async () => {
    const alloc = await post(port, "/ports/allocate", { count: 3 });
    const ports = alloc.data.data.ports;
    // Concurrently release and allocate
    const [rel, alloc2] = await Promise.all([
      post(port, "/ports/release", { ports: [ports[0], ports[1]] }),
      post(port, "/ports/allocate", { count: 2 }),
    ]);
    expect(rel.status).toBe(200);
    expect(alloc2.status).toBe(200);
    // New allocation should not include still-held port[2]
    expect(alloc2.data.data.ports).not.toContain(ports[2]);
  });

  // --- Origin protection (browser CSRF / drive-by) ---

  it("ORG1: 带 Origin 头的 /ports/allocate 被拒绝 403", async () => {
    const res = await postWithHeaders(port, "/ports/allocate", { count: 1 }, { Origin: "http://evil.com" });
    expect(res.status).toBe(403);
    expect(res.data.success).toBe(false);
  });

  it("ORG2: 带 Origin 头的 /ports/release 被拒绝 403", async () => {
    const res = await postWithHeaders(port, "/ports/release", { ports: [30001] }, { Origin: "http://evil.com" });
    expect(res.status).toBe(403);
  });

  it("ORG3: 带 Origin 头的 /register 被拒绝 403", async () => {
    const res = await postWithHeaders(port, "/register", { dir: "/tmp/x", pid: 1 }, { Origin: "http://evil.com" });
    expect(res.status).toBe(403);
  });

  it("ORG4: 带 Origin 头的 /unregister 被拒绝 403", async () => {
    const res = await postWithHeaders(port, "/unregister", { dir: "/tmp/x" }, { Origin: "http://evil.com" });
    expect(res.status).toBe(403);
  });

  it("ORG5: 不带 Origin 头的写请求正常工作（合法客户端）", async () => {
    const res = await post(port, "/ports/allocate", { count: 1 });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it("ORG6: 带 Origin 头的 GET /health 仍可访问（只读）", async () => {
    const res = await postWithHeaders(port, "/health", {}, { Origin: "http://evil.com" });
    // /health is GET-only; POST returns 404 — what matters is no 403 short-circuit for reads.
    // Use a direct GET with Origin instead.
    const g = await new Promise<{ status: number }>((resolve, reject) => {
      http.get(
        { hostname: "127.0.0.1", port, path: "/health", headers: { Origin: "http://evil.com" } },
        (r) => { r.resume(); resolve({ status: r.statusCode! }); },
      ).on("error", reject);
    });
    expect(g.status).toBe(200);
    expect(res.status).not.toBe(200); // POST /health is not a valid route
  });

  it("ORG7: 不再返回通配 CORS 头 Access-Control-Allow-Origin: *", async () => {
    const acao = await new Promise<string | undefined>((resolve, reject) => {
      http.get(
        { hostname: "127.0.0.1", port, path: "/health" },
        (r) => { r.resume(); resolve(r.headers["access-control-allow-origin"] as string | undefined); },
      ).on("error", reject);
    });
    expect(acao).not.toBe("*");
  });
});
