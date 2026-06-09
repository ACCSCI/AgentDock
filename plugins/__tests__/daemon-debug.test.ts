import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { AgentDockDaemon } from "../daemon.js";
import http from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `daemon-debug-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function get(port: number, pathname: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: pathname }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode!, data }); }
      });
    }).on("error", reject);
  });
}

function post(port: number, pathname: string, body: unknown): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode!, data }); }
      });
    });
    req.on("error", reject);
    req.write(json);
    req.end();
  });
}

describe("Daemon Debug Endpoints", () => {
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

  describe("GET /debug/state", () => {
    it("returns empty state initially", async () => {
      const res = await get(port, "/debug/state");
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.state.sessions).toEqual({});
      expect(res.data.state.clients).toEqual({});
      expect(res.data.state.allocatedPorts).toEqual([]);
      expect(res.data.stats.sessionCount).toBe(0);
      expect(res.data.stats.clientCount).toBe(0);
      expect(res.data.stats.allocatedPortCount).toBe(0);
    });

    it("returns state after session allocation", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });
      await post(port, "/sessions/allocate", {
        clientId: "c1", sessionId: "s1", projectPath: "/p", worktreePath: "/wt/s1",
      });

      const res = await get(port, "/debug/state");
      expect(res.status).toBe(200);
      expect(res.data.stats.sessionCount).toBe(1);
      expect(res.data.stats.clientCount).toBe(1);
      expect(res.data.stats.allocatedPortCount).toBe(5);
      expect(res.data.state.sessions.s1).toBeDefined();
      expect(res.data.state.clients.c1).toBeDefined();
    });
  });

  describe("GET /debug/invariants", () => {
    it("passes with empty state", async () => {
      const res = await get(port, "/debug/invariants");
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.valid).toBe(true);
      expect(res.data.checks).toHaveLength(5);
      for (const check of res.data.checks) {
        expect(check.passed).toBe(true);
      }
    });

    it("passes after session allocation", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });
      await post(port, "/sessions/allocate", {
        clientId: "c1", sessionId: "s1", projectPath: "/p", worktreePath: "/wt/s1",
      });

      const res = await get(port, "/debug/invariants");
      expect(res.data.valid).toBe(true);
    });

    it("passes after session release", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });
      await post(port, "/sessions/allocate", {
        clientId: "c1", sessionId: "s1", projectPath: "/p", worktreePath: "/wt/s1",
      });
      await post(port, "/sessions/release", { clientId: "c1", sessionId: "s1" });

      const res = await get(port, "/debug/invariants");
      expect(res.data.valid).toBe(true);
      expect(res.data.checks.find((c: any) => c.name === "port_count_matches").detail).toContain("0 ports");
    });
  });

  describe("GET /debug/wal", () => {
    it("returns WAL status", async () => {
      // Trigger a persist first by registering a client
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });

      const res = await get(port, "/debug/wal");
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.wal.exists).toBe(true);
      expect(res.data.wal.path).toContain("daemon-state.json");
      expect(res.data.wal.sizeBytes).toBeGreaterThan(0);
      expect(res.data.wal.isValidJson).toBe(true);
      expect(res.data.wal.clientCount).toBe(1);
    });
  });

  describe("GET /debug/ports", () => {
    it("returns empty port info initially", async () => {
      const res = await get(port, "/debug/ports");
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.totalAllocated).toBe(0);
      expect(res.data.range.start).toBe(30000);
      expect(res.data.range.end).toBe(65535);
      expect(res.data.bySession).toEqual({});
    });

    it("returns port info after allocation", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });
      await post(port, "/sessions/allocate", {
        clientId: "c1", sessionId: "s1", projectPath: "/p", worktreePath: "/wt/s1",
      });

      const res = await get(port, "/debug/ports");
      expect(res.data.totalAllocated).toBe(5);
      expect(res.data.bySession.s1).toBeDefined();
      expect(res.data.bySession.s1.ports).toHaveLength(5);
      expect(res.data.bySession.s1.named.FRONTEND_PORT).toBeGreaterThanOrEqual(30000);
    });
  });

  describe("GET /debug/clients", () => {
    it("returns empty client list initially", async () => {
      const res = await get(port, "/debug/clients");
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.clients).toEqual([]);
      expect(res.data.heartbeatTimeout).toBe(90000);
      expect(res.data.staleCount).toBe(0);
    });

    it("returns client info after registration", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });

      const res = await get(port, "/debug/clients");
      expect(res.data.clients).toHaveLength(1);
      expect(res.data.clients[0].clientId).toBe("c1");
      expect(res.data.clients[0].pid).toBe(100);
      expect(res.data.clients[0].heartbeatAge).toBeLessThan(5000);
      expect(res.data.clients[0].isStale).toBe(false);
    });
  });

  describe("POST /debug/simulate-stale", () => {
    it("simulates client staleness", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });

      const res = await post(port, "/debug/simulate-stale", { clientId: "c1" });
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.message).toContain("c1");

      // Verify client is now stale
      const clientsRes = await get(port, "/debug/clients");
      expect(clientsRes.data.clients[0].isStale).toBe(true);
    });

    it("returns 404 for non-existent client", async () => {
      const res = await post(port, "/debug/simulate-stale", { clientId: "nonexistent" });
      expect(res.status).toBe(404);
    });

    it("returns 400 for missing clientId", async () => {
      const res = await post(port, "/debug/simulate-stale", {});
      expect(res.status).toBe(400);
    });
  });
});
