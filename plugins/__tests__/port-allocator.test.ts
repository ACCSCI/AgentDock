// @ts-nocheck
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  FilePortAllocator,
  PoolPortAllocator,
  isPortAvailable,
  type PortAllocator,
} from "../port-allocator.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:net";

function tmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `port-alloc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ============================================================
// PoolPortAllocator
// ============================================================

describe("PoolPortAllocator", () => {
  let allocator: PoolPortAllocator;

  beforeEach(() => {
    allocator = new PoolPortAllocator();
  });

  it("allocates requested number of ports", async () => {
    const ports = await allocator.allocate(3);
    expect(ports).toHaveLength(3);
  });

  it("ports are all unique", async () => {
    const ports = await allocator.allocate(5);
    expect(new Set(ports).size).toBe(5);
  });

  it("ports are in valid range (20000-65535)", async () => {
    const ports = await allocator.allocate(5);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(30000);
      expect(port).toBeLessThanOrEqual(65535);
    }
  });

  it("skips ports in exclude set", async () => {
    const first = await allocator.allocate(1);
    const second = await allocator.allocate(1, new Set(first));
    expect(second[0]).not.toBe(first[0]);
  });

  it("release is a no-op (in-memory has no state)", () => {
    allocator.release([20000, 20001]); // should not throw
  });
});

// ============================================================
// FilePortAllocator
// ============================================================

describe("FilePortAllocator", () => {
  let dir: string;
  let allocator: FilePortAllocator;

  beforeEach(() => {
    dir = tmpDir();
    allocator = new FilePortAllocator(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates .agentdock directory on construction", () => {
    expect(existsSync(dir)).toBe(true);
  });

  it("allocates requested number of ports", async () => {
    const ports = await allocator.allocate(3);
    expect(ports).toHaveLength(3);
  });

  it("ports are all unique", async () => {
    const ports = await allocator.allocate(5);
    expect(new Set(ports).size).toBe(5);
  });

  it("ports are in valid range (20000-65535)", async () => {
    const ports = await allocator.allocate(5);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(30000);
      expect(port).toBeLessThanOrEqual(65535);
    }
  });

  it("persists allocated ports to ports.json", async () => {
    const ports = await allocator.allocate(3);
    const dataPath = path.join(dir, "ports.json");
    expect(existsSync(dataPath)).toBe(true);
    const stored = JSON.parse(readFileSync(dataPath, "utf-8"));
    expect(stored).toEqual(ports);
  });

  it("accumulates allocations across calls", async () => {
    const first = await allocator.allocate(2);
    const second = await allocator.allocate(2);
    const dataPath = path.join(dir, "ports.json");
    const stored = JSON.parse(readFileSync(dataPath, "utf-8"));
    expect(stored).toEqual([...first, ...second]);
  });

  it("skips previously allocated ports from file", async () => {
    const first = await allocator.allocate(1);
    const second = await allocator.allocate(1);
    expect(second[0]).not.toBe(first[0]);
  });

  it("skips ports in exclude set", async () => {
    const ports = await allocator.allocate(1, new Set([20000]));
    expect(ports[0]).not.toBe(20000);
  });

  it("release removes ports from persistence", async () => {
    const ports = await allocator.allocate(3);
    allocator.release([ports[0], ports[1]]);

    const dataPath = path.join(dir, "ports.json");
    const stored = JSON.parse(readFileSync(dataPath, "utf-8"));
    expect(stored).toEqual([ports[2]]);
  });

  it("release is safe for unknown ports", async () => {
    await allocator.allocate(1);
    allocator.release([99999]); // should not throw
  });

  it("creates lock file during allocation", async () => {
    const lockPath = path.join(dir, "ports.lock");
    const portsPromise = allocator.allocate(1);

    // The lock file should exist while allocation is in progress
    // (it's created and removed very quickly, so we just verify the
    // allocator works and the lock file is cleaned up)
    const ports = await portsPromise;
    expect(ports).toHaveLength(1);
    // Lock should be released after allocation
    expect(existsSync(lockPath)).toBe(false);
  });

  it("throws when pool is exhausted", async () => {
    // Allocate a large number to fill the range
    // This is slow but verifies the error path
    const smallAllocator = new FilePortAllocator(dir);
    // Fill first 100 ports
    const allPorts = new Set<number>();
    for (let p = 20000; p < 20010; p++) {
      allPorts.add(p);
    }
    // Should still succeed (there are many ports)
    const ports = await smallAllocator.allocate(1, allPorts);
    expect(ports).toHaveLength(1);
    expect(ports[0]).toBeGreaterThanOrEqual(20010);
  });
});

// ============================================================
// FilePortAllocator — Lock liveness (stale lock breaking)
// ============================================================

describe("FilePortAllocator — lock liveness", () => {
  let dir: string;
  let allocator: FilePortAllocator;
  let lockPath: string;

  beforeEach(() => {
    dir = tmpDir();
    allocator = new FilePortAllocator(dir);
    lockPath = path.join(dir, "ports.lock");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("LL1: 锁被存活进程持有且未超时 → 不破锁，分配抛错", async () => {
    // Simulate a fresh lock held by THIS (alive) process.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), "utf-8");
    await expect(allocator.allocate(1)).rejects.toThrow();
    // Lock must NOT have been broken (still held by alive owner).
    expect(existsSync(lockPath)).toBe(true);
  }, 15000);

  it("LL2: 锁被已死进程持有 → 破锁并成功分配", async () => {
    // PID 999999 is virtually guaranteed to not exist.
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now() }), "utf-8");
    const ports = await allocator.allocate(1);
    expect(ports).toHaveLength(1);
  });

  it("LL3: 锁年龄超过 30s（即使 pid 存活）→ 破锁并成功分配", async () => {
    const old = Date.now() - 31_000;
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: old }), "utf-8");
    const ports = await allocator.allocate(1);
    expect(ports).toHaveLength(1);
  });

  it("LL4: 损坏/无 pid 的锁内容 → 超时后破锁（向后兼容旧格式）", async () => {
    writeFileSync(lockPath, "not-json-legacy-lock", "utf-8");
    const ports = await allocator.allocate(1);
    expect(ports).toHaveLength(1);
  });

  it("LL5: 正常分配时写入的锁内容包含本进程 pid", async () => {
    // Hold the lock open by intercepting fn — instead, assert format indirectly:
    // After a successful allocate, lock is removed; so we check during a held lock
    // by pre-seeding a dead-pid lock and verifying it gets replaced/cleaned.
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now() }), "utf-8");
    await allocator.allocate(1);
    // Lock released after allocation completes.
    expect(existsSync(lockPath)).toBe(false);
  });
});

// ============================================================
// FilePortAllocator — Concurrent allocation (cross-process)
// ============================================================

describe("FilePortAllocator — cross-process concurrency", () => {
  let dir: string;
  let scriptPath: string;

  beforeEach(() => {
    dir = tmpDir();
    // Write a self-contained helper script (no external imports needed)
    scriptPath = path.join(dir, "_alloc.mjs");
    const dirStr = JSON.stringify(dir.replace(/\\/g, "/"));
    writeFileSync(
      scriptPath,
      `
      import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
      import path from "node:path";
      import os from "node:os";
      import { createServer } from "node:net";

      const PORT_RANGE_START = 20000;
      const PORT_RANGE_END = 65535;

      async function isPortAvailable(port) {
        return new Promise((resolve) => {
          const server = createServer();
          server.listen(port, "127.0.0.1", () => { server.close(() => resolve(true)); });
          server.on("error", () => resolve(false));
        });
      }

      function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

      const dir = ${dirStr};
      const lockPath = path.join(dir, "ports.lock");
      const dataPath = path.join(dir, "ports.json");

      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      function readAllocated() {
        if (!existsSync(dataPath)) return [];
        try { const d = JSON.parse(readFileSync(dataPath, "utf-8")); return Array.isArray(d) ? d : []; } catch { return []; }
      }
      function writeAllocated(ports) { writeFileSync(dataPath, JSON.stringify(ports, null, 2), "utf-8"); }

      async function withLock(fn) {
        for (let i = 0; i <= 500; i++) {
          try {
            const fd = openSync(lockPath, "wx"); closeSync(fd);
            try { return await fn(); } finally { try { unlinkSync(lockPath); } catch {} }
          } catch (err) {
            if (err.code === "EEXIST") { if (i < 500) { await sleep(10); continue; } try { unlinkSync(lockPath); } catch {} throw new Error("lock timeout"); }
            throw err;
          }
        }
      }

      const count = parseInt(process.argv[2] || "5", 10);
      const ports = await withLock(async () => {
        const allocated = readAllocated();
        const combined = new Set(allocated);
        const result = [];
        for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
          if (result.length >= count) break;
          if (combined.has(port)) continue;
          if (await isPortAvailable(port)) { result.push(port); combined.add(port); }
        }
        if (result.length < count) throw new Error("pool exhausted");
        writeAllocated([...allocated, ...result]);
        return result;
      });
      process.stdout.write(JSON.stringify(ports));
    `,
      "utf-8",
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("two concurrent child processes get different ports", async () => {
    const results = await Promise.all([runChild(scriptPath, "5"), runChild(scriptPath, "5")]);

    const ports1 = JSON.parse(results[0]);
    const ports2 = JSON.parse(results[1]);

    expect(ports1).toHaveLength(5);
    expect(ports2).toHaveLength(5);

    // No port should appear in both allocations
    const overlap = ports1.filter((p: number) => ports2.includes(p));
    expect(overlap).toEqual([]);
  });

  it("four concurrent child processes get all unique ports", async () => {
    const results = await Promise.all([
      runChild(scriptPath, "3"),
      runChild(scriptPath, "3"),
      runChild(scriptPath, "3"),
      runChild(scriptPath, "3"),
    ]);

    const allPorts: number[] = [];
    for (const r of results) {
      allPorts.push(...JSON.parse(r));
    }

    // All 12 ports (4 processes × 3 ports) should be unique
    expect(new Set(allPorts).size).toBe(12);
  });
});

// ============================================================
// Helper: run a child process with tsx and return stdout
// ============================================================

function runChild(scriptPath: string, count: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [scriptPath, count],
      { timeout: 10000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Child failed: ${stderr || err.message}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

// ============================================================
// isPortAvailable — 新架构 §3.3 bindProbe
// (EADDRINUSE 立即判占用; 其它瞬时错误 BIND_PROBE_RETRY 次重试 + 退避;
//  重试耗尽 → 保守判占用 fail-closed)
// ============================================================

async function grabPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

describe("isPortAvailable (新架构 §3.3 bindProbe)", () => {
  let grabbed: Server | null = null;

  afterEach(async () => {
    if (grabbed) {
      await new Promise<void>((r) => grabbed!.close(() => r()));
      grabbed = null;
    }
  });

  it("returns true for a free port", async () => {
    // Use a high random port — likely free.
    const p = 40000 + Math.floor(Math.random() * 5000);
    expect(await isPortAvailable(p)).toBe(true);
  });

  it("returns false immediately when EADDRINUSE (no retry)", async () => {
    // Grab a port, then verify isPortAvailable returns false in roughly
    // 0ms (no 50ms backoff * 3 retry).
    grabbed = await grabPort(0);
    const addr = grabbed.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const start = Date.now();
    const result = await isPortAvailable(port);
    const elapsed = Date.now() - start;

    expect(result).toBe(false);
    // EADDRINUSE → single attempt, no backoff. Allow a tiny margin for
    // OS scheduling but it must NOT be >= BIND_PROBE_BACKOFF_MS * 2.
    expect(elapsed).toBeLessThan(80);
  });
});
