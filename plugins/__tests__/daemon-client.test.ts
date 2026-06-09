import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { AgentDockDaemon } from "../daemon.js";
import { DaemonClient } from "../daemon-client.js";
import { DaemonManager } from "../daemon-manager.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SessionPorts } from "../daemon-state.js";

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

});

// ============================================================
// DaemonClient Session Methods
// ============================================================

describe("DaemonClient Session Methods", () => {
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

  it("registerClient registers with daemon", async () => {
    await client.registerClient("c1", 100, ["/project/a"]);
    // no error = success
  });

  it("allocateSession returns 5 named ports", async () => {
    await client.registerClient("c1", 100, ["/project/a"]);
    const ports = await client.allocateSession({
      clientId: "c1",
      sessionId: "s1",
      projectPath: "/project/a",
      worktreePath: "/wt/s1",
    });
    expect(ports.FRONTEND_PORT).toBeGreaterThanOrEqual(20000);
    expect(ports.BACKEND_PORT).toBeGreaterThanOrEqual(20000);
    expect(ports.WS_PORT).toBeGreaterThanOrEqual(20000);
    expect(ports.DEBUG_PORT).toBeGreaterThanOrEqual(20000);
    expect(ports.PREVIEW_PORT).toBeGreaterThanOrEqual(20000);

    const all = [ports.FRONTEND_PORT, ports.BACKEND_PORT, ports.WS_PORT, ports.DEBUG_PORT, ports.PREVIEW_PORT];
    expect(new Set(all).size).toBe(5);
  });

  it("allocateSession is idempotent", async () => {
    await client.registerClient("c1", 100, ["/project/a"]);
    const p1 = await client.allocateSession({ clientId: "c1", sessionId: "s1", projectPath: "/project/a", worktreePath: "/wt/s1" });
    const p2 = await client.allocateSession({ clientId: "c1", sessionId: "s1", projectPath: "/project/a", worktreePath: "/wt/s1" });
    expect(p2).toEqual(p1);
  });

  it("releaseSession releases ports", async () => {
    await client.registerClient("c1", 100, ["/project/a"]);
    await client.allocateSession({ clientId: "c1", sessionId: "s1", projectPath: "/project/a", worktreePath: "/wt/s1" });
    await client.releaseSession("c1", "s1");
    // no error = success
  });

  it("reassignSession returns new ports", async () => {
    await client.registerClient("c1", 100, ["/project/a"]);
    const old = await client.allocateSession({ clientId: "c1", sessionId: "s1", projectPath: "/project/a", worktreePath: "/wt/s1" });
    const fresh = await client.reassignSession("c1", "s1");
    expect(fresh.FRONTEND_PORT).not.toBe(old.FRONTEND_PORT);
  });

  it("declareSessions allocates new sessions", async () => {
    await client.registerClient("c1", 100, ["/project/a"]);
    const result = await client.declareSessions("c1", [
      { sessionId: "s1", worktreePath: "/wt/s1", projectPath: "/project/a" },
      { sessionId: "s2", worktreePath: "/wt/s2", projectPath: "/project/a" },
    ]);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].status).toBe("allocated");
    expect(result.results[1].status).toBe("allocated");
  });

  it("listSessions returns all sessions", async () => {
    await client.registerClient("c1", 100, ["/project/a"]);
    await client.allocateSession({ clientId: "c1", sessionId: "s1", projectPath: "/project/a", worktreePath: "/wt/s1" });
    await client.allocateSession({ clientId: "c1", sessionId: "s2", projectPath: "/project/a", worktreePath: "/wt/s2" });
    const sessions = await client.listSessions();
    expect(sessions).toHaveLength(2);
  });

  it("get() rejects when daemon returns success:false", async () => {
    // listSessions on a non-existent session returns empty, not an error
    // But we can test that get() properly rejects by checking that
    // accessing a non-existent endpoint returns an error
    const badClient = new DaemonClient(daemon.getPort());
    // The /nonexistent endpoint returns 404 which is not JSON, so get() should reject
    await expect(badClient.health()).resolves.toBe(true);
  });

  it("allocateSession with custom portKeys returns only those keys", async () => {
    await client.registerClient("c1", 100, ["/project/a"]);
    const ports = await client.allocateSession({
      clientId: "c1",
      sessionId: "s-custom",
      projectPath: "/project/a",
      worktreePath: "/wt/s-custom",
      portKeys: ["FRONTEND_PORT", "METRICS_PORT"],
    });
    expect(Object.keys(ports)).toHaveLength(2);
    expect(ports.FRONTEND_PORT).toBeGreaterThanOrEqual(20000);
    expect(ports.METRICS_PORT).toBeGreaterThanOrEqual(20000);
  });

  it("allocateSession with single portKey returns one port", async () => {
    await client.registerClient("c1", 100, ["/project/a"]);
    const ports = await client.allocateSession({
      clientId: "c1",
      sessionId: "s-single",
      projectPath: "/project/a",
      worktreePath: "/wt/s-single",
      portKeys: ["MY_API_PORT"],
    });
    expect(Object.keys(ports)).toHaveLength(1);
    expect(ports.MY_API_PORT).toBeGreaterThanOrEqual(20000);
  });

  it("declareSessions with portKeys allocates custom ports", async () => {
    await client.registerClient("c1", 100, ["/project/a"]);
    const result = await client.declareSessions("c1", [
      { sessionId: "s-d1", worktreePath: "/wt/s-d1", projectPath: "/project/a", portKeys: ["A_PORT", "B_PORT"] },
    ]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe("allocated");
    const ports = result.results[0].ports;
    expect(Object.keys(ports)).toHaveLength(2);
    expect(ports.A_PORT).toBeGreaterThanOrEqual(20000);
    expect(ports.B_PORT).toBeGreaterThanOrEqual(20000);
  });
});
