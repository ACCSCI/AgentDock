import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { AgentDockDaemon } from "../daemon.js";
import http from "node:http";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ============================================================
// Helpers
// ============================================================

function tmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `dir-reg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function post(
  port: number,
  urlPath: string,
  body: unknown,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
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

function get(
  port: number,
  urlPath: string,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode!, data: JSON.parse(data) });
        });
      })
      .on("error", reject);
  });
}

// ============================================================
// Tests
// ============================================================

describe("Directory Registration", () => {
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

  // --- register ---

  it("register succeeds for new directory", async () => {
    const res = await post(port, "/register", {
      dir: "/tmp/test-a",
      pid: 12345,
    });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it("register rejects duplicate with alive PID", async () => {
    await post(port, "/register", {
      dir: "/tmp/test-dup",
      pid: process.pid,
    });
    const res = await post(port, "/register", {
      dir: "/tmp/test-dup",
      pid: process.pid,
    });
    expect(res.status).toBe(409);
    expect(res.data.error).toContain("already registered");
  });

  it("register reclaims stale registration (dead PID)", async () => {
    await post(port, "/register", { dir: "/tmp/test-stale", pid: 999999 });
    const res = await post(port, "/register", {
      dir: "/tmp/test-stale",
      pid: 12345,
    });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it("register allows different directories", async () => {
    await post(port, "/register", { dir: "/tmp/test-x", pid: 12345 });
    const res = await post(port, "/register", {
      dir: "/tmp/test-y",
      pid: 99999,
    });
    expect(res.status).toBe(200);
  });

  it("register validates required fields", async () => {
    const noDir = await post(port, "/register", { pid: 12345 });
    expect(noDir.status).toBe(400);

    const noPid = await post(port, "/register", { dir: "/tmp/test" });
    expect(noPid.status).toBe(400);
  });

  // --- unregister ---

  it("unregister succeeds", async () => {
    await post(port, "/register", {
      dir: "/tmp/test-unreg",
      pid: 12345,
    });
    const res = await post(port, "/unregister", {
      dir: "/tmp/test-unreg",
      pid: 12345,
    });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it("unregister allows re-registration", async () => {
    await post(port, "/register", {
      dir: "/tmp/test-rereg",
      pid: 12345,
    });
    await post(port, "/unregister", {
      dir: "/tmp/test-rereg",
      pid: 12345,
    });
    const res = await post(port, "/register", {
      dir: "/tmp/test-rereg",
      pid: 99999,
    });
    expect(res.status).toBe(200);
  });

  it("unregister non-existent directory is ok", async () => {
    const res = await post(port, "/unregister", {
      dir: "/tmp/nonexistent",
      pid: 12345,
    });
    expect(res.status).toBe(200);
  });

  // --- status ---

  it("status returns registered instances", async () => {
    await post(port, "/register", { dir: "/tmp/s1", pid: 111 });
    await post(port, "/register", { dir: "/tmp/s2", pid: 222 });

    const res = await get(port, "/status");
    expect(res.status).toBe(200);
    expect(res.data.data.instances).toHaveLength(2);
  });

  it("status shows stale instances", async () => {
    await post(port, "/register", { dir: "/tmp/stale", pid: 999999 });

    const res = await get(port, "/status");
    expect(res.status).toBe(200);
    expect(res.data.data.instances).toHaveLength(1);
    expect(res.data.data.instances[0].status).toBe("stale");
  });

  // --- registry persistence ---

  it("registry persists to disk", async () => {
    await post(port, "/register", {
      dir: "/tmp/persist",
      pid: 12345,
    });

    const registryPath = path.join(dir, "registry.json");
    expect(existsSync(registryPath)).toBe(true);
    const data = JSON.parse(readFileSync(registryPath, "utf-8"));
    expect(data["/tmp/persist"]).toBeDefined();
  });

  it("registry survives daemon restart", async () => {
    await post(port, "/register", {
      dir: "/tmp/restart",
      pid: 12345,
    });

    await daemon.stop();
    const daemon2 = new AgentDockDaemon({ port: 0, baseDir: dir });
    await daemon2.start();

    try {
      const res = await get(daemon2.getPort(), "/status");
      expect(res.data.data.instances).toHaveLength(1);
      expect(res.data.data.instances[0].dir).toBe("/tmp/restart");
    } finally {
      await daemon2.stop();
    }
  });
});
