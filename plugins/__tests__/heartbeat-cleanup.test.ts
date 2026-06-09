import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { AgentDockDaemon } from "../daemon.js";
import { DaemonClient } from "../daemon-client.js";

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `heartbeat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function post(port: number, urlPath: string, body: Record<string, unknown>): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, data: JSON.parse(body) }); } catch { resolve({ status: res.statusCode!, data: body }); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function get(port: number, urlPath: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, data: JSON.parse(body) }); } catch { resolve({ status: res.statusCode!, data: body }); }
      });
    }).on("error", reject);
  });
}

describe("Heartbeat timeout cleanup", () => {
  let dir: string;
  let daemon: AgentDockDaemon;
  let port: number;
  let client: DaemonClient;

  beforeEach(async () => {
    dir = tmpDir();
    daemon = new AgentDockDaemon({ port: 0, baseDir: dir });
    await daemon.start();
    port = daemon.getPort();
    client = new DaemonClient(port);
  });

  afterEach(async () => {
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stale client's sessions are released after heartbeat timeout", async () => {
    // Register client and allocate a session
    await client.registerClient("c1", process.pid, ["/project/a"]);
    const ports = await client.allocateSession({ clientId: "c1", sessionId: "s1", projectPath: "/project/a", worktreePath: "/wt/s1" });
    expect(ports.FRONTEND_PORT).toBeGreaterThanOrEqual(20000);

    // Verify session exists
    const list1 = await get(port, "/sessions/list");
    expect(list1.data.sessions).toHaveLength(1);
    expect(list1.data.sessions[0].sessionId).toBe("s1");

    // Simulate stale client (set lastHeartbeat to 0)
    const stale = await post(port, "/debug/simulate-stale", { clientId: "c1" });
    expect(stale.status).toBe(200);

    // Trigger cleanup
    const cleanup = await post(port, "/debug/trigger-cleanup", {});
    expect(cleanup.status).toBe(200);

    // Verify session was released
    const list2 = await get(port, "/sessions/list");
    expect(list2.data.sessions).toHaveLength(0);
  });

  it("active client's sessions survive cleanup", async () => {
    // Register client and allocate a session
    await client.registerClient("c1", process.pid, ["/project/a"]);
    const ports = await client.allocateSession({ clientId: "c1", sessionId: "s1", projectPath: "/project/a", worktreePath: "/wt/s1" });

    // Send heartbeat to keep client alive
    await client.heartbeat("c1");

    // Simulate stale (set lastHeartbeat to 0)
    await post(port, "/debug/simulate-stale", { clientId: "c1" });

    // Send another heartbeat — resets lastHeartbeat to now
    await client.heartbeat("c1");

    // Trigger cleanup
    await post(port, "/debug/trigger-cleanup", {});

    // Session should still exist because heartbeat refreshed lastHeartbeat
    const list = await get(port, "/sessions/list");
    expect(list.data.sessions).toHaveLength(1);
    expect(list.data.sessions[0].sessionId).toBe("s1");
  });

  it("released ports can be reused by new sessions", async () => {
    // Client A allocates session s1
    await client.registerClient("c1", process.pid, ["/project/a"]);
    const portsA = await client.allocateSession({ clientId: "c1", sessionId: "s1", projectPath: "/project/a", worktreePath: "/wt/s1" });

    // Simulate stale and cleanup — releases s1's ports
    await post(port, "/debug/simulate-stale", { clientId: "c1" });
    await post(port, "/debug/trigger-cleanup", {});

    // Client B allocates session s2 — should get the same ports (they're free now)
    await client.registerClient("c2", process.pid, ["/project/b"]);
    const portsB = await client.allocateSession({ clientId: "c2", sessionId: "s2", projectPath: "/project/b", worktreePath: "/wt/s2" });

    expect(portsB.FRONTEND_PORT).toBe(portsA.FRONTEND_PORT);
    expect(portsB.BACKEND_PORT).toBe(portsA.BACKEND_PORT);
  });

  it("heartbeat prevents port reuse — active session keeps its ports", async () => {
    // Client A allocates session s1 and keeps heartbeat alive
    await client.registerClient("c1", process.pid, ["/project/a"]);
    const portsA = await client.allocateSession({ clientId: "c1", sessionId: "s1", projectPath: "/project/a", worktreePath: "/wt/s1" });
    await client.heartbeat("c1");

    // Client B allocates session s2 — must get different ports
    await client.registerClient("c2", process.pid, ["/project/b"]);
    const portsB = await client.allocateSession({ clientId: "c2", sessionId: "s2", projectPath: "/project/b", worktreePath: "/wt/s2" });

    expect(portsB.FRONTEND_PORT).not.toBe(portsA.FRONTEND_PORT);
    expect(portsB.BACKEND_PORT).not.toBe(portsA.BACKEND_PORT);
  });
});
