// @ts-nocheck
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { AgentDockDaemon } from "../daemon.js";
import http from "node:http";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
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

  describe.skip("POST /sessions/allocate", () => {
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
      expect(res.data.ports.FRONTEND_PORT).toBeGreaterThanOrEqual(30000);
      expect(res.data.ports.BACKEND_PORT).toBeGreaterThanOrEqual(30000);
      expect(res.data.ports.WS_PORT).toBeGreaterThanOrEqual(30000);
      expect(res.data.ports.DEBUG_PORT).toBeGreaterThanOrEqual(30000);
      expect(res.data.ports.PREVIEW_PORT).toBeGreaterThanOrEqual(30000);

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

  describe.skip("POST /sessions/release", () => {
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

    it("rejects release from another live client", async () => {
      await post(port, "/client/register", { clientId: "owner", pid: 100, projectPaths: ["/project/a"] });
      await post(port, "/client/register", { clientId: "other", pid: 200, projectPaths: ["/project/a"] });
      await post(port, "/sessions/allocate", {
        clientId: "owner",
        sessionId: "s1",
        projectPath: "/project/a",
        worktreePath: "/wt/s1",
      });

      const res = await post(port, "/sessions/release", {
        clientId: "other",
        sessionId: "s1",
      });
      expect(res.status).toBe(403);
      expect(res.data.error).toContain("owned by another client");

      const sessions = await get(port, "/sessions/list");
      expect(sessions.data.sessions).toHaveLength(1);
      expect(sessions.data.sessions[0].ownerClientId).toBe("owner");
    });

  });

  // --- Session Reassign ---

  describe.skip("POST /sessions/reassign", () => {
    it("rejects reassign from another live client", async () => {
      await post(port, "/client/register", { clientId: "owner", pid: 100, projectPaths: ["/project/a"] });
      await post(port, "/client/register", { clientId: "other", pid: 200, projectPaths: ["/project/a"] });
      const alloc = await post(port, "/sessions/allocate", {
        clientId: "owner",
        sessionId: "s1",
        projectPath: "/project/a",
        worktreePath: "/wt/s1",
      });

      const res = await post(port, "/sessions/reassign", {
        clientId: "other",
        sessionId: "s1",
      });
      expect(res.status).toBe(403);
      expect(res.data.error).toContain("owned by another client");

      const sessions = await get(port, "/sessions/list");
      expect(sessions.data.sessions[0].ports).toEqual(alloc.data.ports);
      expect(sessions.data.sessions[0].ownerClientId).toBe("owner");
    });

  });

  // --- Sync Declare ---

  describe.skip("POST /sync/declare", () => {
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

    it("reassigns ports for a reclaimable session and transfers ownership", async () => {
      await post(port, "/client/register", { clientId: "owner", pid: 100, projectPaths: ["/project/a"] });
      const alloc = await post(port, "/sessions/allocate", {
        clientId: "owner",
        sessionId: "s1",
        projectPath: "/project/a",
        worktreePath: "/wt/s1",
      });
      await post(port, "/client/unregister", { clientId: "owner" });
      await post(port, "/client/register", { clientId: "rescuer", pid: 200, projectPaths: ["/project/a"] });

      const res = await post(port, "/sessions/reassign", {
        clientId: "rescuer",
        sessionId: "s1",
      });
      expect(res.status).toBe(200);
      expect(res.data.status).toBe("reclaimed");
      expect(res.data.ports.FRONTEND_PORT).not.toBe(alloc.data.ports.FRONTEND_PORT);

      const sessions = await get(port, "/sessions/list");
      expect(sessions.data.sessions[0].ownerClientId).toBe("rescuer");
    });

    it("returns foreign when another live client declares an existing session", async () => {
      await post(port, "/client/register", { clientId: "owner", pid: 100, projectPaths: ["/project/a"] });
      const alloc = await post(port, "/sessions/allocate", {
        clientId: "owner",
        sessionId: "s1",
        projectPath: "/project/a",
        worktreePath: "/wt/s1",
      });
      await post(port, "/client/register", { clientId: "other", pid: 200, projectPaths: ["/project/a"] });

      const res = await post(port, "/sync/declare", {
        clientId: "other",
        sessions: [
          { sessionId: "s1", worktreePath: "/wt/s1", projectPath: "/project/a" },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.data.results[0].status).toBe("foreign");
      expect(res.data.results[0].ports).toEqual(alloc.data.ports);

      const sessions = await get(port, "/sessions/list");
      expect(sessions.data.sessions[0].ownerClientId).toBe("owner");
    });

    it("returns reclaimed when declare revives a session from a missing owner", async () => {
      await post(port, "/client/register", { clientId: "owner", pid: 100, projectPaths: ["/project/a"] });
      const alloc = await post(port, "/sessions/allocate", {
        clientId: "owner",
        sessionId: "s1",
        projectPath: "/project/a",
        worktreePath: "/wt/s1",
      });
      await post(port, "/client/unregister", { clientId: "owner" });
      await post(port, "/client/register", { clientId: "rescuer", pid: 200, projectPaths: ["/project/a"] });

      const res = await post(port, "/sync/declare", {
        clientId: "rescuer",
        sessions: [
          { sessionId: "s1", worktreePath: "/wt/s1", projectPath: "/project/a" },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.data.results[0].status).toBe("reclaimed");
      expect(res.data.results[0].ports).toEqual(alloc.data.ports);

      const sessions = await get(port, "/sessions/list");
      expect(sessions.data.sessions[0].ownerClientId).toBe("rescuer");
    });

  });

  // --- GET /sessions/list ---

  describe.skip("GET /sessions/list", () => {
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

  // --- Heartbeat timeout cleanup ---

  describe("heartbeat timeout cleanup", () => {
    it.skip("stale client sessions are released after timeout", async () => {
      // Register client and allocate session
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });
      await post(port, "/sessions/allocate", {
        clientId: "c1", sessionId: "s1", projectPath: "/p", worktreePath: "/wt/s1",
      });

      // Verify session exists
      const before = await get(port, "/sessions/list");
      expect(before.data.sessions).toHaveLength(1);

      // Manually set lastHeartbeat to past (simulate stale client)
      // We need to access the daemon's internal state for this test
      // In real usage, the heartbeat timer handles this automatically
      // For testing, we'll verify the mechanism works by checking that
      // the heartbeat endpoint doesn't write to WAL
    });

    it("heartbeat eventually persists to WAL after throttle interval", async () => {
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });
      const walPath = path.join(dir, "daemon-state.json");
      const before = JSON.parse(readFileSync(walPath, "utf-8"));
      const beforeHeartbeat = before.clients.c1.lastHeartbeat;

      await new Promise((resolve) => setTimeout(resolve, 50));
      await post(port, "/client/heartbeat", { clientId: "c1" });

      const immediate = JSON.parse(readFileSync(walPath, "utf-8"));
      expect(immediate.clients.c1.lastHeartbeat).toBe(beforeHeartbeat);

      await new Promise((resolve) => setTimeout(resolve, 50));
      await post(port, "/client/unregister", { clientId: "c1" });
      await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });

      const after = JSON.parse(readFileSync(walPath, "utf-8"));
      expect(after.clients.c1.lastHeartbeat).toBeGreaterThan(beforeHeartbeat);
    });

  });
});
