import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { AgentDockDaemon } from "../daemon.js";
import { DaemonClient } from "../daemon-client.js";
import { startDaemonHeartbeat } from "../api.js";

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `api-heartbeat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("startDaemonHeartbeat", () => {
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

  it("without heartbeat: stale client's session is cleaned up, ports become available for reuse", async () => {
    // Reproduces the exact bug: API Server registers client but never sends heartbeat.
    // After daemon cleanup, session ports are freed and reassigned to a new session.

    await client.registerClient("client_A", process.pid, [process.cwd()]);
    const portsA = await client.allocateSession({
      clientId: "client_A", sessionId: "Amo8HPVK",
      projectPath: "/project", worktreePath: "/wt/Amo8HPVK",
    });

    // Daemon cleans up stale client (simulates 90s timeout)
    await post(port, "/debug/simulate-stale", { clientId: "client_A" });
    await post(port, "/debug/trigger-cleanup", {});

    // Session was released
    const list = await get(port, "/sessions/list");
    expect(list.data.sessions).toHaveLength(0);

    // New session gets the same ports — this is the bug
    await client.registerClient("client_B", process.pid, [process.cwd()]);
    const portsB = await client.allocateSession({
      clientId: "client_B", sessionId: "EABcLAoU",
      projectPath: "/project", worktreePath: "/wt/EABcLAoU",
    });

    expect(portsB.FRONTEND_PORT).toBe(portsA.FRONTEND_PORT);
    expect(portsB.BACKEND_PORT).toBe(portsA.BACKEND_PORT);
    expect(portsB.WS_PORT).toBe(portsA.WS_PORT);
    expect(portsB.DEBUG_PORT).toBe(portsA.DEBUG_PORT);
    expect(portsB.PREVIEW_PORT).toBe(portsA.PREVIEW_PORT);
  });

  it("with heartbeat: session survives cleanup, new session gets different ports", async () => {
    // This is what the fix does: startDaemonHeartbeat keeps the client alive.

    await client.registerClient("client_A", process.pid, [process.cwd()]);
    const portsA = await client.allocateSession({
      clientId: "client_A", sessionId: "Amo8HPVK",
      projectPath: "/project", worktreePath: "/wt/Amo8HPVK",
    });

    // Start heartbeat (the fix!)
    const timer = startDaemonHeartbeat(client, "client_A", 30_000);

    // Simulate stale, then manually send heartbeat (as the interval would)
    await post(port, "/debug/simulate-stale", { clientId: "client_A" });
    await client.heartbeat("client_A"); // interval fires — refreshes lastHeartbeat

    // Trigger cleanup — client survives because heartbeat was sent
    await post(port, "/debug/trigger-cleanup", {});

    const list = await get(port, "/sessions/list");
    expect(list.data.sessions).toHaveLength(1);
    expect(list.data.sessions[0].sessionId).toBe("Amo8HPVK");

    // New session gets DIFFERENT ports
    await client.registerClient("client_B", process.pid, [process.cwd()]);
    const portsB = await client.allocateSession({
      clientId: "client_B", sessionId: "EABcLAoU",
      projectPath: "/project", worktreePath: "/wt/EABcLAoU",
    });

    expect(portsB.FRONTEND_PORT).not.toBe(portsA.FRONTEND_PORT);

    clearInterval(timer);
  });

  it("heartbeat timer can be stopped with clearInterval", async () => {
    await client.registerClient("c1", process.pid, [process.cwd()]);
    const timer = startDaemonHeartbeat(client, "c1", 100);

    // Timer is running
    expect(timer).toBeDefined();

    // Stop it
    clearInterval(timer);

    // No error — cleanup is not affected
    await post(port, "/debug/simulate-stale", { clientId: "c1" });
    await post(port, "/debug/trigger-cleanup", {});

    const list = await get(port, "/sessions/list");
    expect(list.data.sessions).toHaveLength(0);
  });
});
