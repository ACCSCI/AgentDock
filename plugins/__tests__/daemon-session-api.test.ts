import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { AgentDockDaemon } from "../daemon.js";
import http from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ============================================================
// Helpers
// ============================================================

function tmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `daemon-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function post(port: number, urlPath: string, body: unknown): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
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

function get(port: number, urlPath: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({ status: res.statusCode!, data: JSON.parse(data) });
      });
    }).on("error", reject);
  });
}

// ============================================================
// Tests
// ============================================================

describe("Daemon Session API", () => {
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

  // --- Client Registration ---

  describe("POST /client/register", () => {
    it("registers a client", async () => {
      const res = await post(port, "/client/register", {
        clientId: "c1",
        pid: 100,
        projectPaths: ["/project/a"],
      });
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
    });

    it("rejects missing clientId", async () => {
      const res = await post(port, "/client/register", {
        pid: 100,
        projectPaths: ["/project/a"],
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing pid", async () => {
      const res = await post(port, "/client/register", {
        clientId: "c1",
        projectPaths: ["/project/a"],
      });
      expect(res.status).toBe(400);
    });
  });

  // --- Client Heartbeat ---

  describe("POST /client/heartbeat", () => {
    it("updates heartbeat", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: [] });
      const res = await post(port, "/client/heartbeat", { clientId: "c1" });
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
    });
  });

  // --- Client Unregister ---

  describe("POST /client/unregister", () => {
    it("unregisters a client", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: [] });
      const res = await post(port, "/client/unregister", { clientId: "c1" });
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
    });
  });

  // --- Session Allocate ---

  describe("POST /sessions/allocate", () => {
    it("allocates a session with 5 ports", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/project/a"] });
      const res = await post(port, "/sessions/allocate", {
        clientId: "c1",
        sessionId: "s1",
        projectPath: "/project/a",
        worktreePath: "/project/a/.agentdock/worktrees/s1",
      });
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.ports).toBeDefined();
      expect(res.data.ports.FRONTEND_PORT).toBeGreaterThanOrEqual(20000);
      expect(res.data.ports.BACKEND_PORT).toBeGreaterThanOrEqual(20000);
      expect(res.data.ports.WS_PORT).toBeGreaterThanOrEqual(20000);
      expect(res.data.ports.DEBUG_PORT).toBeGreaterThanOrEqual(20000);
      expect(res.data.ports.PREVIEW_PORT).toBeGreaterThanOrEqual(20000);

      // All 5 ports should be unique
      const allPorts = [
        res.data.ports.FRONTEND_PORT,
        res.data.ports.BACKEND_PORT,
        res.data.ports.WS_PORT,
        res.data.ports.DEBUG_PORT,
        res.data.ports.PREVIEW_PORT,
      ];
      expect(new Set(allPorts).size).toBe(5);
    });

    it("rejects duplicate worktreePath", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/project/a"] });
      await post(port, "/sessions/allocate", {
        clientId: "c1",
        sessionId: "s1",
        projectPath: "/project/a",
        worktreePath: "/project/a/.agentdock/worktrees/s1",
      });

      const res = await post(port, "/sessions/allocate", {
        clientId: "c1",
        sessionId: "s2",
        projectPath: "/project/a",
        worktreePath: "/project/a/.agentdock/worktrees/s1", // same path!
      });
      expect(res.status).toBe(409);
      expect(res.data.error).toContain("duplicate");
    });

    it("allows same sessionId (idempotent)", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/project/a"] });
      const r1 = await post(port, "/sessions/allocate", {
        clientId: "c1",
        sessionId: "s1",
        projectPath: "/project/a",
        worktreePath: "/project/a/.agentdock/worktrees/s1",
      });
      expect(r1.status).toBe(200);

      // Same session again — should return existing ports
      const r2 = await post(port, "/sessions/allocate", {
        clientId: "c1",
        sessionId: "s1",
        projectPath: "/project/a",
        worktreePath: "/project/a/.agentdock/worktrees/s1",
      });
      expect(r2.status).toBe(200);
      expect(r2.data.ports).toEqual(r1.data.ports);
    });

    it("two sessions get different ports", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/project/a"] });
      const r1 = await post(port, "/sessions/allocate", {
        clientId: "c1",
        sessionId: "s1",
        projectPath: "/project/a",
        worktreePath: "/wt/s1",
      });
      const r2 = await post(port, "/sessions/allocate", {
        clientId: "c1",
        sessionId: "s2",
        projectPath: "/project/a",
        worktreePath: "/wt/s2",
      });
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      const ports1 = Object.values(r1.data.ports);
      const ports2 = Object.values(r2.data.ports);
      const overlap = ports1.filter((p: number) => ports2.includes(p));
      expect(overlap).toEqual([]);
    });
  });

  // --- Session Release ---

  describe("POST /sessions/release", () => {
    it("releases a session", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/project/a"] });
      await post(port, "/sessions/allocate", {
        clientId: "c1",
        sessionId: "s1",
        projectPath: "/project/a",
        worktreePath: "/wt/s1",
      });

      const res = await post(port, "/sessions/release", {
        clientId: "c1",
        sessionId: "s1",
      });
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
    });

    it("release is idempotent", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/project/a"] });
      const res = await post(port, "/sessions/release", {
        clientId: "c1",
        sessionId: "nonexistent",
      });
      expect(res.status).toBe(200);
    });
  });

  // --- Session Reassign ---

  describe("POST /sessions/reassign", () => {
    it("reassigns ports for a session", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/project/a"] });
      const alloc = await post(port, "/sessions/allocate", {
        clientId: "c1",
        sessionId: "s1",
        projectPath: "/project/a",
        worktreePath: "/wt/s1",
      });
      const oldPorts = alloc.data.ports;

      const res = await post(port, "/sessions/reassign", {
        clientId: "c1",
        sessionId: "s1",
      });
      expect(res.status).toBe(200);
      expect(res.data.ports).toBeDefined();

      // New ports should differ from old
      const newPorts = res.data.ports;
      expect(newPorts.FRONTEND_PORT).not.toBe(oldPorts.FRONTEND_PORT);
    });
  });

  // --- Sync Declare ---

  describe("POST /sync/declare", () => {
    it("declares sessions and receives ports", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/project/a"] });
      const res = await post(port, "/sync/declare", {
        clientId: "c1",
        sessions: [
          { sessionId: "s1", worktreePath: "/wt/s1", projectPath: "/project/a" },
          { sessionId: "s2", worktreePath: "/wt/s2", projectPath: "/project/a" },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.data.results).toHaveLength(2);
      expect(res.data.results[0].status).toBe("allocated");
      expect(res.data.results[0].ports).toBeDefined();
      expect(res.data.results[1].status).toBe("allocated");
    });

    it("returns existing ports for already-known sessions", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/project/a"] });

      // First allocate
      const alloc = await post(port, "/sessions/allocate", {
        clientId: "c1",
        sessionId: "s1",
        projectPath: "/project/a",
        worktreePath: "/wt/s1",
      });
      const originalPorts = alloc.data.ports;

      // Then declare
      const res = await post(port, "/sync/declare", {
        clientId: "c1",
        sessions: [
          { sessionId: "s1", worktreePath: "/wt/s1", projectPath: "/project/a" },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.data.results[0].status).toBe("existing");
      expect(res.data.results[0].ports).toEqual(originalPorts);
    });

    it("detects orphans", async () => {
      // Client c1 allocates session
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/project/a"] });
      await post(port, "/sessions/allocate", {
        clientId: "c1",
        sessionId: "s1",
        projectPath: "/project/a",
        worktreePath: "/wt/s1",
      });

      // Unregister c1
      await post(port, "/client/unregister", { clientId: "c1" });

      // Client c2 declares — should see s1 as orphan
      await post(port, "/client/register", { clientId: "c2", pid: 200, projectPaths: ["/project/a"] });
      const res = await post(port, "/sync/declare", {
        clientId: "c2",
        sessions: [
          { sessionId: "s2", worktreePath: "/wt/s2", projectPath: "/project/a" },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.data.orphans).toContain("s1");
    });
  });

  // --- GET /sessions/list ---

  describe("GET /sessions/list", () => {
    it("lists all sessions", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/project/a"] });
      await post(port, "/sessions/allocate", {
        clientId: "c1",
        sessionId: "s1",
        projectPath: "/project/a",
        worktreePath: "/wt/s1",
      });
      await post(port, "/sessions/allocate", {
        clientId: "c1",
        sessionId: "s2",
        projectPath: "/project/a",
        worktreePath: "/wt/s2",
      });

      const res = await get(port, "/sessions/list");
      expect(res.status).toBe(200);
      expect(res.data.sessions).toHaveLength(2);
    });
  });
});
