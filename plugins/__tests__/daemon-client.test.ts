import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { AgentDockDaemon } from "../daemon.js";
import { DaemonClient } from "../daemon-client.js";
import { DaemonManager } from "../daemon-manager.js";
import { setPortAllocator, getPortAllocator } from "../port-pool.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

function tmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `daemon-client-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ============================================================
// DaemonClient
// ============================================================

describe("DaemonClient", () => {
  let dir: string;
  let daemon: AgentDockDaemon;
  let client: DaemonClient;

  beforeEach(async () => {
    dir = tmpDir();
    daemon = new AgentDockDaemon({ port: 0, baseDir: dir });
    await daemon.start();
    client = new DaemonClient(daemon.getPort());
  });

  afterEach(async () => {
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("health returns true when daemon is running", async () => {
    expect(await client.health()).toBe(true);
  });

  it("health returns false when daemon is not running", async () => {
    const deadClient = new DaemonClient(59999);
    expect(await deadClient.health()).toBe(false);
  });

  it("allocate returns ports", async () => {
    const ports = await client.allocate(3);
    expect(ports).toHaveLength(3);
    for (const p of ports) {
      expect(p).toBeGreaterThanOrEqual(20000);
      expect(p).toBeLessThanOrEqual(65535);
    }
  });

  it("allocate respects exclude set", async () => {
    const ports = await client.allocate(1, new Set([20000]));
    expect(ports[0]).not.toBe(20000);
  });

  it("release does not throw", async () => {
    const ports = await client.allocate(2);
    client.release(ports); // should not throw
  });

  it("multiple allocations accumulate", async () => {
    const p1 = await client.allocate(2);
    const p2 = await client.allocate(2);
    const all = [...p1, ...p2];
    expect(new Set(all).size).toBe(4);
  });
});

// ============================================================
// DaemonManager
// ============================================================

describe("DaemonManager", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("init detects existing daemon", async () => {
    // Start a daemon manually first
    const daemon = new AgentDockDaemon({ port: 0, baseDir: dir });
    await daemon.start();
    const port = daemon.getPort();

    try {
      const manager = new DaemonManager(port);
      const result = await manager.init();

      expect(result.started).toBe(false); // detected, not started
      expect(await result.client.health()).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  it("setPortAllocator / getPortAllocator works", () => {
    const original = getPortAllocator();
    const fake = { allocate: async () => [99999], release: () => {} };
    setPortAllocator(fake);
    expect(getPortAllocator()).toBe(fake);
    // Restore
    setPortAllocator(original);
  });
});
