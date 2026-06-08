import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { AgentDockDaemon } from "../daemon.js";
import { DaemonClient } from "../daemon-client.js";
import http from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `sync-declare-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function post(port: number, pathname: string, body: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on("error", reject);
    req.write(json);
    req.end();
  });
}

describe("Sync/declare protocol", () => {
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

  it("declare known session returns existing ports", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    // First allocate
    const original = await client.allocateSession({
      clientId: "c1", sessionId: "s1", projectPath: "/project", worktreePath: "/wt/s1",
    });

    // Declare same session
    const result = await client.declareSessions("c1", [
      { sessionId: "s1", worktreePath: "/wt/s1", projectPath: "/project" },
    ]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe("existing");
    expect(result.results[0].ports).toEqual(original);
  });

  it("declare unknown session allocates new ports", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    const result = await client.declareSessions("c1", [
      { sessionId: "new1", worktreePath: "/wt/new1", projectPath: "/project" },
    ]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe("allocated");
    expect(result.results[0].ports.FRONTEND_PORT).toBeGreaterThanOrEqual(20000);
  });

  it("declare conflicting worktreePath returns conflict", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    // Allocate session with this worktreePath
    await client.allocateSession({
      clientId: "c1", sessionId: "s1", projectPath: "/project", worktreePath: "/wt/shared",
    });

    // Declare different session with same worktreePath
    const result = await client.declareSessions("c1", [
      { sessionId: "s2", worktreePath: "/wt/shared", projectPath: "/project" },
    ]);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe("conflict");
  });

  it("declare empty sessions array returns empty results", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    const result = await client.declareSessions("c1", []);
    expect(result.results).toHaveLength(0);
    expect(result.orphans).toHaveLength(0);
  });

  it("declare 100 sessions all succeed", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    const sessions = Array.from({ length: 100 }, (_, i) => ({
      sessionId: `s${i}`,
      worktreePath: `/wt/s${i}`,
      projectPath: "/project",
    }));

    const result = await client.declareSessions("c1", sessions);
    expect(result.results).toHaveLength(100);

    const allocated = result.results.filter((r) => r.status === "allocated");
    expect(allocated.length).toBe(100);

    // All ports should be unique
    const allPorts: number[] = [];
    for (const r of result.results) {
      allPorts.push(
        r.ports.FRONTEND_PORT,
        r.ports.BACKEND_PORT,
        r.ports.WS_PORT,
        r.ports.DEBUG_PORT,
        r.ports.PREVIEW_PORT,
      );
    }
    expect(new Set(allPorts).size).toBe(500);
  }, 15000);

  it("orphan detection: sessions from dead client reported", async () => {
    const daemonPort = daemon.getPort();

    // Client A registers and allocates
    await client.registerClient("clientA", 100, ["/project"]);
    await client.allocateSession({
      clientId: "clientA", sessionId: "sA", projectPath: "/project", worktreePath: "/wt/sA",
    });

    // Unregister clientA (simulates client death) — use raw HTTP since DaemonClient has no unregisterClient
    await post(daemonPort, "/client/unregister", { clientId: "clientA" });

    // Client B registers and declares nothing
    await client.registerClient("clientB", 200, ["/project"]);
    const result = await client.declareSessions("clientB", []);

    // Session sA's owner (clientA) no longer exists — should be reported as orphan
    expect(result.orphans).toContain("sA");
  });

  it("orphan detection: own sessions not reported as orphans", async () => {
    await client.registerClient("c1", 100, ["/project"]);
    await client.allocateSession({
      clientId: "c1", sessionId: "s1", projectPath: "/project", worktreePath: "/wt/s1",
    });

    const result = await client.declareSessions("c1", [
      { sessionId: "s1", worktreePath: "/wt/s1", projectPath: "/project" },
    ]);

    expect(result.orphans).toHaveLength(0);
  });

  it("declare from another live client returns foreign and preserves ownership", async () => {
    await client.registerClient("clientA", 100, ["/project"]);
    const original = await client.allocateSession({
      clientId: "clientA", sessionId: "s1", projectPath: "/project", worktreePath: "/wt/s1",
    });

    await client.registerClient("clientB", 200, ["/project"]);
    const result = await client.declareSessions("clientB", [
      { sessionId: "s1", worktreePath: "/wt/s1", projectPath: "/project" },
    ]);

    expect(result.results[0].status).toBe("foreign");
    expect(result.results[0].ports).toEqual(original);

    const sessions = await client.listSessions();
    const s1 = sessions.find((s) => s.sessionId === "s1");
    expect(s1?.ownerClientId).toBe("clientA");
  });

  it("declare reclaims session when prior owner is stale/unregistered", async () => {
    const daemonPort = daemon.getPort();

    await client.registerClient("clientA", 100, ["/project"]);
    const original = await client.allocateSession({
      clientId: "clientA", sessionId: "s1", projectPath: "/project", worktreePath: "/wt/s1",
    });

    await post(daemonPort, "/client/unregister", { clientId: "clientA" });
    await client.registerClient("clientB", 200, ["/project"]);

    const result = await client.declareSessions("clientB", [
      { sessionId: "s1", worktreePath: "/wt/s1", projectPath: "/project" },
    ]);

    expect(result.results[0].status).toBe("reclaimed");
    expect(result.results[0].ports).toEqual(original);

    const sessions = await client.listSessions();
    const s1 = sessions.find((s) => s.sessionId === "s1");
    expect(s1?.ownerClientId).toBe("clientB");
  });

  it("declare mixes known, unknown, and conflict", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    // Pre-allocate one session
    await client.allocateSession({
      clientId: "c1", sessionId: "existing", projectPath: "/project", worktreePath: "/wt/existing",
    });

    const result = await client.declareSessions("c1", [
      { sessionId: "existing", worktreePath: "/wt/existing", projectPath: "/project" },
      { sessionId: "brand-new", worktreePath: "/wt/brand-new", projectPath: "/project" },
    ]);

    expect(result.results[0].status).toBe("existing");
    expect(result.results[1].status).toBe("allocated");
  });
});
