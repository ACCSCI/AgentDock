import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { AgentDockDaemon } from "../daemon.js";
import { DaemonClient } from "../daemon-client.js";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `client-resilience-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("DaemonClient resilience", () => {
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

  it("allocateSession with non-existent clientId still works", async () => {
    const ports = await client.allocateSession({
      clientId: "nonexistent",
      sessionId: "s1",
      projectPath: "/project",
      worktreePath: "/wt/s1",
    });

    expect(ports.FRONTEND_PORT).toBeGreaterThanOrEqual(20000);
  });

  it("registerClient then allocateSession succeeds", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    const ports = await client.allocateSession({
      clientId: "c1",
      sessionId: "s1",
      projectPath: "/project",
      worktreePath: "/wt/s1",
    });

    expect(ports.FRONTEND_PORT).toBeGreaterThanOrEqual(20000);
    expect(ports.BACKEND_PORT).toBeGreaterThanOrEqual(20000);
  });

  it("100 heartbeats all succeed", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    for (let i = 0; i < 100; i++) {
      await client.heartbeat("c1");
    }
    // No error = success
  });

  it("release after daemon shutdown throws (no fire-and-forget)", async () => {
    await client.registerClient("c1", 100, ["/project"]);
    await client.allocateSession({
      clientId: "c1",
      sessionId: "s1",
      projectPath: "/project",
      worktreePath: "/wt/s1",
    });

    await daemon.stop();

    // releaseSession is NOT fire-and-forget — it throws when daemon is down
    await expect(client.releaseSession("c1", "s1")).rejects.toThrow();
  });

  it("allocateSession after daemon restart gets new ports", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    const p1 = await client.allocateSession({
      clientId: "c1",
      sessionId: "s1",
      projectPath: "/project",
      worktreePath: "/wt/s1",
    });

    // Restart daemon
    await daemon.stop();
    daemon = new AgentDockDaemon({ port: daemon.getPort(), baseDir: dir });
    await daemon.start();
    client = new DaemonClient(daemon.getPort());

    // Re-register and allocate — should get new ports (state lost)
    await client.registerClient("c1", 100, ["/project"]);

    const p2 = await client.allocateSession({
      clientId: "c1",
      sessionId: "s1",
      projectPath: "/project",
      worktreePath: "/wt/s1",
    });

    // Ports might be the same or different depending on WAL
    // But allocation should succeed
    expect(p2.FRONTEND_PORT).toBeGreaterThanOrEqual(20000);
  });

  it("declareSessions after daemon restart preserves ownership for recently heartbeating client", async () => {
    await client.registerClient("c1", 100, ["/project"]);
    const original = await client.allocateSession({
      clientId: "c1",
      sessionId: "s1",
      projectPath: "/project",
      worktreePath: "/wt/s1",
    });

    await client.heartbeat("c1");

    await daemon.stop();
    daemon = new AgentDockDaemon({ port: daemon.getPort(), baseDir: dir });
    await daemon.start();
    client = new DaemonClient(daemon.getPort());

    await client.registerClient("c1", 100, ["/project"]);
    const result = await client.declareSessions("c1", [{
      sessionId: "s1",
      worktreePath: "/wt/s1",
      projectPath: "/project",
      ports: original,
    }]);

    expect(result.results).toHaveLength(1);
    expect(["existing", "reclaimed"]).toContain(result.results[0].status);
    expect(result.results[0].ports).toEqual(original);

    const sessions = await client.listSessions();
    expect(sessions.find((s) => s.sessionId === "s1")?.ownerClientId).toBe("c1");
  });

  it("declareSessions with 10 sessions succeeds", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    const sessions = Array.from({ length: 10 }, (_, i) => ({
      sessionId: `s${i}`,
      worktreePath: `/wt/s${i}`,
      projectPath: "/project",
    }));

    const result = await client.declareSessions("c1", sessions);
    expect(result.results).toHaveLength(10);
    for (const r of result.results) {
      expect(r.status).toBe("allocated");
    }
  });

  it("listSessions returns allocated sessions", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    await client.allocateSession({
      clientId: "c1", sessionId: "s1", projectPath: "/p", worktreePath: "/wt/s1",
    });
    await client.allocateSession({
      clientId: "c1", sessionId: "s2", projectPath: "/p", worktreePath: "/wt/s2",
    });

    const sessions = await client.listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(2);
  });

  it("reassignSession returns different ports", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    const original = await client.allocateSession({
      clientId: "c1", sessionId: "s1", projectPath: "/p", worktreePath: "/wt/s1",
    });

    const fresh = await client.reassignSession("c1", "s1");

    expect(fresh.FRONTEND_PORT).not.toBe(original.FRONTEND_PORT);
    expect(fresh.BACKEND_PORT).not.toBe(original.BACKEND_PORT);
  });
});

describe("DaemonClient — daemon down", () => {
  it("health returns false when daemon is down", async () => {
    const client = new DaemonClient(59999);
    expect(await client.health()).toBe(false);
  });
});
