import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { AgentDockDaemon } from "../daemon.js";
import http from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `daemon-edge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function post(port: number, pathname: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json), ...headers } }, (res) => {
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

function postRaw(port: number, pathname: string, rawBody: string, headers?: Record<string, string>): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(rawBody), ...headers } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode!, data }); }
      });
    });
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
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

// ============================================================
// Tests
// ============================================================

describe("Daemon edge cases", () => {
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

  // --- Malformed input ---

  it.skip("malformed JSON body returns 400", async () => {
    const res = await postRaw(port, "/sessions/allocate", "{invalid json");
    expect(res.status).toBe(400);
  });

  it.skip("empty body returns 400", async () => {
    const res = await postRaw(port, "/sessions/allocate", "");
    expect(res.status).toBe(400);
  });

  it.skip("missing required fields returns 400", async () => {
    const res = await post(port, "/sessions/allocate", { clientId: "c1" });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("required");
  });

  // --- Input validation ---

  it.skip("sessionId with path traversal returns 400", async () => {
    const res = await post(port, "/sessions/allocate", {
      clientId: "c1", sessionId: "../evil", projectPath: "/p", worktreePath: "/wt/x",
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("Invalid sessionId");
  });

  it.skip("sessionId with slash returns 400", async () => {
    const res = await post(port, "/sessions/allocate", {
      clientId: "c1", sessionId: "a/b", projectPath: "/p", worktreePath: "/wt/x",
    });
    expect(res.status).toBe(400);
  });

  it.skip("sessionId with backslash returns 400", async () => {
    const res = await post(port, "/sessions/allocate", {
      clientId: "c1", sessionId: "a\\b", projectPath: "/p", worktreePath: "/wt/x",
    });
    expect(res.status).toBe(400);
  });

  it.skip("empty sessionId returns 400", async () => {
    const res = await post(port, "/sessions/allocate", {
      clientId: "c1", sessionId: "", projectPath: "/p", worktreePath: "/wt/x",
    });
    expect(res.status).toBe(400);
  });

  it.skip("relative worktreePath returns 400", async () => {
    const res = await post(port, "/sessions/allocate", {
      clientId: "c1", sessionId: "s1", projectPath: "/p", worktreePath: "relative/path",
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("absolute");
  });

  it.skip("empty worktreePath returns 400", async () => {
    const res = await post(port, "/sessions/allocate", {
      clientId: "c1", sessionId: "s1", projectPath: "/p", worktreePath: "",
    });
    expect(res.status).toBe(400);
  });

  // --- Idempotency ---

  it.skip("duplicate sessionId is idempotent", async () => {
    // Register client first
    await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });

    const p1 = await post(port, "/sessions/allocate", {
      clientId: "c1", sessionId: "s1", projectPath: "/p", worktreePath: "/wt/s1",
    });
    expect(p1.status).toBe(200);

    const p2 = await post(port, "/sessions/allocate", {
      clientId: "c1", sessionId: "s1", projectPath: "/p", worktreePath: "/wt/s1",
    });
    expect(p2.status).toBe(200);
    expect(p2.data.ports).toEqual(p1.data.ports);
  });

  it.skip("duplicate worktreePath returns 409", async () => {
    await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });

    await post(port, "/sessions/allocate", {
      clientId: "c1", sessionId: "s1", projectPath: "/p", worktreePath: "/wt/shared",
    });

    const res = await post(port, "/sessions/allocate", {
      clientId: "c1", sessionId: "s2", projectPath: "/p", worktreePath: "/wt/shared",
    });
    expect(res.status).toBe(409);
    expect(res.data.error).toContain("duplicate_worktree");
  });

  // --- CSRF ---

  it("POST with Origin header returns 403", async () => {
    const res = await post(port, "/sessions/allocate", {
      clientId: "c1", sessionId: "s1", projectPath: "/p", worktreePath: "/wt/s1",
    }, { Origin: "http://evil.com" });
    expect(res.status).toBe(403);
  });

  // --- Routing ---

  it("POST to unknown path returns 404", async () => {
    const res = await post(port, "/nonexistent", {});
    expect(res.status).toBe(404);
  });

  it("GET /health returns 200", async () => {
    const res = await get(port, "/health");
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("ok");
  });

  // --- Concurrent operations ---

  it.skip("10 concurrent allocates produce unique ports", async () => {
    await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });

    const promises = Array.from({ length: 10 }, (_, i) =>
      post(port, "/sessions/allocate", {
        clientId: "c1", sessionId: `s${i}`, projectPath: "/p", worktreePath: `/wt/s${i}`,
      }),
    );

    const results = await Promise.all(promises);

    for (const res of results) {
      expect(res.status).toBe(200);
    }

    const allPorts: number[] = [];
    for (const res of results) {
      const p = res.data.ports;
      allPorts.push(p.FRONTEND_PORT, p.BACKEND_PORT, p.WS_PORT, p.DEBUG_PORT, p.PREVIEW_PORT);
    }

    expect(new Set(allPorts).size).toBe(50);
  });

  it.skip("concurrent allocate + release same session is safe", async () => {
    await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });

    // Allocate first
    await post(port, "/sessions/allocate", {
      clientId: "c1", sessionId: "s1", projectPath: "/p", worktreePath: "/wt/s1",
    });

    // Concurrent release + allocate (release should win, then allocate may fail or succeed)
    const results = await Promise.all([
      post(port, "/sessions/release", { clientId: "c1", sessionId: "s1" }),
      post(port, "/sessions/allocate", {
        clientId: "c1", sessionId: "s1", projectPath: "/p", worktreePath: "/wt/s1",
      }),
    ]);

    // Both should complete without error (order may vary)
    for (const res of results) {
      expect([200, 409]).toContain(res.status);
    }
  });

  // --- Sync/declare validation ---

  it.skip("sync/declare with invalid sessionId is skipped", async () => {
    await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });

    const res = await post(port, "/sync/declare", {
      clientId: "c1",
      sessions: [
        { sessionId: "../evil", worktreePath: "/wt/x", projectPath: "/p" },
        { sessionId: "good", worktreePath: "/wt/good", projectPath: "/p" },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.data.results[0].status).toBe("error");
    expect(res.data.results[1].status).toBe("allocated");
  });

  it.skip("sync/declare with relative worktreePath is skipped", async () => {
    await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });

    const res = await post(port, "/sync/declare", {
      clientId: "c1",
      sessions: [
        { sessionId: "s1", worktreePath: "relative", projectPath: "/p" },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.data.results[0].status).toBe("error");
  });

  // --- Owner validation ---

  it.skip("allocateSession with non-existent clientId still works (ownerPid=0)", async () => {
    const res = await post(port, "/sessions/allocate", {
      clientId: "nonexistent", sessionId: "s1", projectPath: "/p", worktreePath: "/wt/s1",
    });
    // Should succeed but with ownerPid=0
    expect(res.status).toBe(200);
  });

  // --- DNS Rebinding protection ---

  it("request with valid Host header (127.0.0.1) passes", async () => {
    // Use GET /health which accepts GET requests
    const res = await get(port, "/health");
    expect(res.status).toBe(200);
  });

  it("request with malicious Host header returns 403", async () => {
    // Use raw HTTP request with custom Host header
    const res = await new Promise<{ status: number; data: any }>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/health",
        method: "GET",
        headers: { Host: "evil.com" },
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode!, data: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode!, data }); }
        });
      });
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(403);
  });

  // --- sessionId strict validation ---

  it.skip("sessionId with alphanumeric passes", async () => {
    await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });
    const res = await post(port, "/sessions/allocate", {
      clientId: "c1", sessionId: "abc-123_XYZ", projectPath: "/p", worktreePath: "/wt/x",
    });
    expect(res.status).toBe(200);
  });

  it.skip("sessionId with space returns 400", async () => {
    const res = await post(port, "/sessions/allocate", {
      clientId: "c1", sessionId: "abc 123", projectPath: "/p", worktreePath: "/wt/x",
    });
    expect(res.status).toBe(400);
  });

  it.skip("sessionId with special characters returns 400", async () => {
    const res = await post(port, "/sessions/allocate", {
      clientId: "c1", sessionId: "abc@123", projectPath: "/p", worktreePath: "/wt/x",
    });
    expect(res.status).toBe(400);
  });

  // --- worktreePath normalization ---

  it.skip("worktreePath with .. is normalized for duplicate detection", async () => {
    await post(port, "/client/register", { clientId: "c1", pid: 100, projectPaths: ["/p"] });

    // First allocation
    const res1 = await post(port, "/sessions/allocate", {
      clientId: "c1", sessionId: "s1", projectPath: "/p", worktreePath: "/foo/bar",
    });
    expect(res1.status).toBe(200);

    // Second allocation with normalized path
    const res2 = await post(port, "/sessions/allocate", {
      clientId: "c1", sessionId: "s2", projectPath: "/p", worktreePath: "/foo/bar/../bar",
    });
    expect(res2.status).toBe(409);
  });
});
