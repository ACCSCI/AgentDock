import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { FilePortAllocator, PoolPortAllocator } from "../port-allocator.js";
import { AgentDockDaemon } from "../daemon.js";
import { DaemonClient } from "../daemon-client.js";
import { createSessionLifecycle, type CreateSessionResult } from "../session-lifecycle.js";
import { loadRegistry, loadGlobalAllocatedPorts, type SessionPorts } from "../port-registry.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import type { AgentDockConfig } from "../config.js";

// ============================================================
// Helpers
// ============================================================

function tmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `port-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initGitRepo(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "pipe" });
}

function defaultConfig(): AgentDockConfig {
  return { version: "1", resources: { sync: [] }, hooks: {} };
}

// ============================================================
// Layer 1: Unit Tests — FilePortAllocator
// ============================================================

describe("Layer 1: PortAllocator — Unit", () => {
  let dir: string;
  let allocator: FilePortAllocator;

  beforeEach(() => {
    dir = tmpDir();
    allocator = new FilePortAllocator(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("allocate", () => {
    it("allocates requested number of ports", async () => {
      const ports = await allocator.allocate(5);
      expect(ports).toHaveLength(5);
    });

    it("ports are unique", async () => {
      const ports = await allocator.allocate(10);
      expect(new Set(ports).size).toBe(10);
    });

    it("ports are in valid range", async () => {
      const ports = await allocator.allocate(5);
      for (const p of ports) {
        expect(p).toBeGreaterThanOrEqual(20000);
        expect(p).toBeLessThanOrEqual(65535);
      }
    });

    it("persists to ports.json", async () => {
      const ports = await allocator.allocate(3);
      const dataPath = path.join(dir, "ports.json");
      expect(existsSync(dataPath)).toBe(true);
      const stored = JSON.parse(require("node:fs").readFileSync(dataPath, "utf-8"));
      expect(stored).toEqual(ports);
    });

    it("accumulates across calls", async () => {
      const p1 = await allocator.allocate(2);
      const p2 = await allocator.allocate(2);
      const dataPath = path.join(dir, "ports.json");
      const stored = JSON.parse(require("node:fs").readFileSync(dataPath, "utf-8"));
      expect(stored).toEqual([...p1, ...p2]);
    });

    it("skips previously allocated ports", async () => {
      const p1 = await allocator.allocate(1);
      const p2 = await allocator.allocate(1);
      expect(p2[0]).not.toBe(p1[0]);
    });

    it("respects exclude set", async () => {
      const ports = await allocator.allocate(1, new Set([20000]));
      expect(ports[0]).not.toBe(20000);
    });

    it("default exclude is empty", async () => {
      const ports = await allocator.allocate(1);
      expect(ports).toHaveLength(1);
    });
  });

  describe("release", () => {
    it("removes ports from persistence", async () => {
      const ports = await allocator.allocate(3);
      allocator.release([ports[0], ports[1]]);
      const dataPath = path.join(dir, "ports.json");
      const stored = JSON.parse(require("node:fs").readFileSync(dataPath, "utf-8"));
      expect(stored).toEqual([ports[2]]);
    });

    it("safe for unknown ports", async () => {
      await allocator.allocate(1);
      allocator.release([99999]); // should not throw
    });

    it("safe on empty registry", () => {
      allocator.release([20000]); // should not throw
    });
  });

  describe("reuse", () => {
    it("released ports become available for re-allocation", async () => {
      const p1 = await allocator.allocate(1);
      const releasedPort = p1[0];

      allocator.release([releasedPort]);

      // After release, the port is removed from the registry.
      // A new allocation should produce a valid port (may reuse the released one).
      const p2 = await allocator.allocate(1);
      expect(p2).toHaveLength(1);
      expect(p2[0]).toBeGreaterThanOrEqual(20000);
    });

    it("released ports excluded from current allocation via exclude param", async () => {
      const p1 = await allocator.allocate(3);
      const releasedPort = p1[1];

      allocator.release([releasedPort]);

      // Re-allocate with the original 3 as exclude — should skip p1[0] and p1[2]
      // and pick something else (not p1[1] since it's still in the exclude set)
      const p2 = await allocator.allocate(1, new Set(p1));
      expect(p2[0]).not.toBe(p1[0]);
      expect(p2[0]).not.toBe(p1[2]);
      expect(p2[0]).not.toBe(releasedPort);
    });
  });
});

// ============================================================
// Layer 2: Concurrent Tests — 100 parallel requests
// ============================================================

describe("Layer 2: PortAllocator — Concurrent (100 requests)", () => {
  let dir: string;
  let allocator: FilePortAllocator;

  beforeEach(() => {
    dir = tmpDir();
    allocator = new FilePortAllocator(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("100 concurrent allocate(1) calls produce 100 unique ports", async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, () => allocator.allocate(1)),
    );

    const allPorts = results.map((r) => r[0]);
    expect(allPorts).toHaveLength(100);
    expect(new Set(allPorts).size).toBe(100);

    // All ports in valid range
    for (const p of allPorts) {
      expect(p).toBeGreaterThanOrEqual(20000);
      expect(p).toBeLessThanOrEqual(65535);
    }
  });

  it("100 concurrent allocate(1) — persisted file has 100 entries", async () => {
    await Promise.all(
      Array.from({ length: 100 }, () => allocator.allocate(1)),
    );

    const dataPath = path.join(dir, "ports.json");
    const stored = JSON.parse(require("node:fs").readFileSync(dataPath, "utf-8"));
    expect(stored).toHaveLength(100);
    expect(new Set(stored).size).toBe(100);
  });

  it("100 concurrent allocate(5) calls produce 500 unique ports", async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, () => allocator.allocate(5)),
    );

    const allPorts = results.flat();
    expect(allPorts).toHaveLength(500);
    expect(new Set(allPorts).size).toBe(500);
  });

  it("mixed allocate and release — no duplicates", async () => {
    // Pre-allocate 50 ports
    const preAllocated = await allocator.allocate(50);

    // Concurrently: release some + allocate new ones
    const releasePorts = preAllocated.slice(0, 20);
    const results = await Promise.all([
      // Release 20
      ...releasePorts.map((p) => Promise.resolve(allocator.release([p]))),
      // Allocate 30 new
      ...Array.from({ length: 30 }, () => allocator.allocate(1)),
    ]);

    // Re-check the persisted file — no duplicates
    const dataPath = path.join(dir, "ports.json");
    const stored = JSON.parse(require("node:fs").readFileSync(dataPath, "utf-8"));
    expect(new Set(stored).size).toBe(stored.length); // no duplicates
  });
});

// ============================================================
// Layer 3: Daemon Tests — 3 clients competing
// ============================================================

describe("Layer 3: Daemon — 3 clients, no duplicate ports", () => {
  let dir: string;
  let daemon: AgentDockDaemon;
  let daemonPort: number;
  let clients: DaemonClient[];

  beforeEach(async () => {
    dir = tmpDir();
    daemon = new AgentDockDaemon({ port: 0, baseDir: dir });
    await daemon.start();
    daemonPort = daemon.getPort();
    clients = [
      new DaemonClient(daemonPort),
      new DaemonClient(daemonPort),
      new DaemonClient(daemonPort),
    ];
  });

  afterEach(async () => {
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("3 clients allocate simultaneously — no duplicate ports", async () => {
    const results = await Promise.all(
      clients.map((c) => c.allocate(5)),
    );

    const allPorts = results.flat();
    expect(allPorts).toHaveLength(15);
    expect(new Set(allPorts).size).toBe(15);
  });

  it("3 clients allocate 10 each — 30 unique ports", async () => {
    const results = await Promise.all(
      clients.map((c) => c.allocate(10)),
    );

    const allPorts = results.flat();
    expect(allPorts).toHaveLength(30);
    expect(new Set(allPorts).size).toBe(30);
  });

  it("sequential allocate + release + re-allocate — no duplicates", async () => {
    const r1 = await clients[0].allocate(3);
    const r2 = await clients[1].allocate(3);

    // Client 0 releases, Client 2 allocates
    clients[0].release(r1);
    const r3 = await clients[2].allocate(3);

    // All currently allocated: r2 + r3 (r1 was released)
    const currentlyAllocated = [...r2, ...r3];
    expect(new Set(currentlyAllocated).size).toBe(currentlyAllocated.length);
  });

  it("health check works", async () => {
    for (const c of clients) {
      expect(await c.health()).toBe(true);
    }
  });

  it("concurrent allocate + release mixed", async () => {
    // Phase 1: everyone allocates
    const allocs = await Promise.all(clients.map((c) => c.allocate(5)));
    const allBefore = allocs.flat();
    expect(new Set(allBefore).size).toBe(15);

    // Phase 2: client 0 releases, clients 1+2 allocate more
    clients[0].release(allocs[0]);
    const more = await Promise.all([
      clients[1].allocate(3),
      clients[2].allocate(3),
    ]);

    // Client 0's released ports are no longer allocated
    // But clients 1+2's ports are new
    const allNew = more.flat();
    expect(new Set(allNew).size).toBe(6);

    // No overlap between new allocations and still-held ones
    const stillHeld = [...allocs[1], ...allocs[2]];
    const overlap = allNew.filter((p) => stillHeld.includes(p));
    expect(overlap).toEqual([]);
  });
});

// ============================================================
// Layer 4: Self-hosting Test — AgentDock manages itself
// ============================================================

describe("Layer 4: Self-hosting — AgentDock manages itself", () => {
  let projectDir: string;
  let daemon: AgentDockDaemon;
  let daemonPort: number;

  beforeEach(async () => {
    projectDir = tmpDir();
    initGitRepo(projectDir);

    // Start daemon for port allocation
    daemon = new AgentDockDaemon({ port: 0, baseDir: path.join(projectDir, ".agentdock") });
    await daemon.start();
    daemonPort = daemon.getPort();
  });

  afterEach(async () => {
    await daemon.stop();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("create 3 sessions — all get unique ports", async () => {
    const lifecycle = createSessionLifecycle();
    const config = defaultConfig();

    const results: CreateSessionResult[] = [];
    for (let i = 1; i <= 3; i++) {
      const result = await lifecycle.create({
        projectId: "self-host",
        projectPath: projectDir,
        sessionId: `session-${i}`,
        sessionName: `Session ${i}`,
        config,
      });
      results.push(result);
    }

    // All 3 sessions have 5 ports each
    for (const r of results) {
      expect(r.ports).toBeDefined();
      expect(Object.keys(r.ports)).toHaveLength(5);
    }

    // All 15 ports are unique across sessions
    const allPorts: number[] = [];
    for (const r of results) {
      allPorts.push(...Object.values(r.ports));
    }
    expect(new Set(allPorts).size).toBe(15);

    // Registry has 3 entries
    const registry = loadRegistry(projectDir);
    expect(registry).toHaveLength(3);

    // Cleanup
    for (const r of results) {
      await lifecycle.remove({
        sessionId: r.sessionId,
        projectPath: projectDir,
        worktreePath: r.worktreePath,
        config,
      });
    }
  });

  it("create + delete + re-create — registry stays consistent", async () => {
    const lifecycle = createSessionLifecycle();
    const config = defaultConfig();

    // Create session 1
    const s1 = await lifecycle.create({
      projectId: "self-host",
      projectPath: projectDir,
      sessionId: "s1",
      sessionName: "S1",
      config,
    });

    // Delete session 1
    await lifecycle.remove({
      sessionId: s1.sessionId,
      projectPath: projectDir,
      worktreePath: s1.worktreePath,
      config,
    });

    // Re-create session 1
    const s1b = await lifecycle.create({
      projectId: "self-host",
      projectPath: projectDir,
      sessionId: "s1",
      sessionName: "S1 (recreated)",
      config,
    });

    // Registry has only 1 entry (the recreated one)
    const registry = loadRegistry(projectDir);
    expect(registry).toHaveLength(1);
    expect(registry[0].sessionId).toBe("s1");

    // New session has valid ports
    expect(Object.values(s1b.ports)).toHaveLength(5);

    await lifecycle.remove({
      sessionId: s1b.sessionId,
      projectPath: projectDir,
      worktreePath: s1b.worktreePath,
      config,
    });
  });

  it("parallel session creation — no resource conflicts", async () => {
    const lifecycle = createSessionLifecycle();
    const config = defaultConfig();

    // Create 5 sessions in parallel
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        lifecycle.create({
          projectId: "self-host",
          projectPath: projectDir,
          sessionId: `parallel-${i}`,
          sessionName: `Parallel ${i}`,
          config,
        }),
      ),
    );

    // All 5 sessions created successfully
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(existsSync(r.worktreePath)).toBe(true);
    }

    // All 25 ports (5 × 5) are unique
    const allPorts: number[] = [];
    for (const r of results) {
      allPorts.push(...Object.values(r.ports));
    }
    expect(new Set(allPorts).size).toBe(25);

    // Registry has 5 entries
    const registry = loadRegistry(projectDir);
    expect(registry).toHaveLength(5);

    // Global allocation set matches
    const globalPorts = loadGlobalAllocatedPorts([projectDir]);
    expect(globalPorts.size).toBe(25);

    // Cleanup
    await Promise.all(
      results.map((r) =>
        lifecycle.remove({
          sessionId: r.sessionId,
          projectPath: projectDir,
          worktreePath: r.worktreePath,
          config,
        }),
      ),
    );
  });

  it("two projects sharing global port exclusion — no overlap", async () => {
    // Project A
    const projectA = projectDir;

    // Project B (separate git repo)
    const projectB = tmpDir();
    initGitRepo(projectB);

    const config = defaultConfig();

    try {
      // Create session in project A (no global exclusion needed — first project)
      const lifecycleA = createSessionLifecycle();
      const sA = await lifecycleA.create({
        projectId: "project-a",
        projectPath: projectA,
        sessionId: "sA",
        sessionName: "Session A",
        config,
      });

      // Get global excluded ports from project A
      const globalExcluded = loadGlobalAllocatedPorts([projectA]);

      // Create session in project B WITH global exclusion
      const lifecycleB = createSessionLifecycle({ globalExcludedPorts: globalExcluded });
      const sB = await lifecycleB.create({
        projectId: "project-b",
        projectPath: projectB,
        sessionId: "sB",
        sessionName: "Session B",
        config,
      });

      // All ports from both projects should be unique
      const portsA = Object.values(sA.ports);
      const portsB = Object.values(sB.ports);
      const overlap = portsA.filter((p) => portsB.includes(p));
      expect(overlap).toEqual([]);

      // Cleanup
      await lifecycleA.remove({
        sessionId: sA.sessionId,
        projectPath: projectA,
        worktreePath: sA.worktreePath,
        config,
      });
      await lifecycleB.remove({
        sessionId: sB.sessionId,
        projectPath: projectB,
        worktreePath: sB.worktreePath,
        config,
      });
    } finally {
      rmSync(projectB, { recursive: true, force: true });
    }
  });

  it("AgentDock can self-host: create session that creates another session", async () => {
    const config = defaultConfig();

    // Outer session: AgentDock manages itself
    const outerLifecycle = createSessionLifecycle();
    const outer = await outerLifecycle.create({
      projectId: "self-host-outer",
      projectPath: projectDir,
      sessionId: "outer",
      sessionName: "Outer (managing AgentDock)",
      config,
    });

    expect(existsSync(outer.worktreePath)).toBe(true);

    // Inner session: from the worktree, create another session
    // This simulates "AgentDock development AgentDock"
    // Must exclude outer's ports to avoid overlap
    const globalExcluded = loadGlobalAllocatedPorts([projectDir]);
    const innerLifecycle = createSessionLifecycle({ globalExcludedPorts: globalExcluded });
    const inner = await innerLifecycle.create({
      projectId: "self-host-inner",
      projectPath: outer.worktreePath,
      sessionId: "inner",
      sessionName: "Inner (developing in worktree)",
      config,
    });

    expect(existsSync(inner.worktreePath)).toBe(true);

    // Both sessions have unique ports
    const outerPorts = Object.values(outer.ports);
    const innerPorts = Object.values(inner.ports);
    const overlap = outerPorts.filter((p) => innerPorts.includes(p));
    expect(overlap).toEqual([]);

    // The inner worktree is nested inside the outer worktree
    expect(inner.worktreePath.startsWith(outer.worktreePath)).toBe(true);

    // Cleanup inner first, then outer
    await innerLifecycle.remove({
      sessionId: inner.sessionId,
      projectPath: outer.worktreePath,
      worktreePath: inner.worktreePath,
      config,
    });
    await outerLifecycle.remove({
      sessionId: outer.sessionId,
      projectPath: projectDir,
      worktreePath: outer.worktreePath,
      config,
    });
  });
});
