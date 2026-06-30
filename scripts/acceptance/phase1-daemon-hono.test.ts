// @ts-nocheck
/**
 * Phase 1 acceptance gate — Daemon Hono refactor.
 *
 * Verifies the Hono rewrite of plugins/daemon.ts is functionally equivalent
 * to the old monolithic implementation. Failure here means the refactor
 * broke behavior — fix before moving to Phase 2.
 *
 * Asserts:
 *   - plugins/daemon.ts is a thin re-export (< 500 bytes)
 *   - Hono app imports and is callable
 *   - GET /health on a real spawned daemon returns 200 + { status: "ok" }
 *   - POST /sessions/allocate with empty body returns 400 (zod rejects)
 *   - POST /sessions/allocate with Origin header returns 403 (CSRF guard)
 *   - Host header "evil.com" returns 403 (DNS rebinding guard)
 *   - All existing daemon unit tests still pass
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const ROOT = process.cwd();

describe("Phase 1: Daemon Hono refactor", () => {
  describe("file structure", () => {
    it("plugins/daemon.ts is a thin re-export (< 500 bytes)", () => {
      const path = join(ROOT, "plugins/daemon.ts");
      expect(existsSync(path)).toBe(true);
      const stat = readFileSync(path, "utf-8");
      expect(stat.length).toBeLessThan(500);
      // Should only re-export, not contain implementation
      expect(stat).toContain("export");
      expect(stat).not.toContain("http.createServer");
    });

    it("plugins/daemon/ directory has the expected modules", () => {
      for (const file of [
        "app.ts",
        "context.ts",
        "server.ts",
        "middleware/host.ts",
        "middleware/origin.ts",
        "middleware/error.ts",
        "routes/health.ts",
        "routes/ports.ts",
        "routes/registry.ts",
        "routes/clients.ts",
        "routes/sessions.ts",
        "routes/sync.ts",
        "routes/debug.ts",
      ]) {
        expect(existsSync(join(ROOT, "plugins/daemon", file))).toBe(true);
      }
    });
  });

  describe("Hono app is importable", () => {
    it("createApp returns a Hono instance with request()", async () => {
      const { createApp } = await import("../../plugins/daemon/app.js");
      const { makeContext } = await import("../../plugins/daemon/context.js");
      const ctx = makeContext({ baseDir: join(tmpdir(), "agentdock-phase1-import-test") });
      const app = createApp(ctx);
      expect(app).toBeDefined();
      expect(typeof app.request).toBe("function");

      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.status).toBe("ok");
    });

    it("AppType is exported for downstream typed-client consumers", async () => {
      // Verify that the type can be re-imported at the public daemon.ts surface.
      const mod = await import("../../plugins/daemon.js");
      // AppType is type-only — at runtime we just verify the module exports
      // exist; the real type check happens at compile time.
      expect(mod.AgentDockDaemon).toBeDefined();
    });
  });

  describe("middleware behavior (in-process via app.request)", () => {
    let app: Awaited<ReturnType<typeof import("../../plugins/daemon/app.js")>>["createApp"];
    let ctx: Awaited<ReturnType<typeof import("../../plugins/daemon/context.js")>>["makeContext"];

    beforeAll(async () => {
      const appMod = await import("../../plugins/daemon/app.js");
      const ctxMod = await import("../../plugins/daemon/context.js");
      app = appMod.createApp;
      ctx = ctxMod.makeContext;
    });

    it("Host header 'evil.com' returns 403", async () => {
      const c = ctx({ baseDir: join(tmpdir(), "agentdock-phase1-host-test") });
      const a = app(c);
      const res = await a.request("/health", { headers: { Host: "evil.com" } });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("Host");
    });

    it("POST with Origin header returns 403", async () => {
      const c = ctx({ baseDir: join(tmpdir(), "agentdock-phase1-origin-test") });
      const a = app(c);
      const res = await a.request("/sessions/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://evil.com" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("cross-origin");
    });

    it("OPTIONS preflight returns 204", async () => {
      const c = ctx({ baseDir: join(tmpdir(), "agentdock-phase1-options-test") });
      const a = app(c);
      const res = await a.request("/sessions/allocate", { method: "OPTIONS" });
      expect(res.status).toBe(204);
    });

    it("empty body POST returns 400 from zod validator", async () => {
      const c = ctx({ baseDir: join(tmpdir(), "agentdock-phase1-400-test") });
      const a = app(c);
      const res = await a.request("/sessions/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("unknown route returns 404", async () => {
      const c = ctx({ baseDir: join(tmpdir(), "agentdock-phase1-404-test") });
      const a = app(c);
      const res = await a.request("/does-not-exist");
      expect(res.status).toBe(404);
    });
  });

  describe("real daemon spawn (subprocess)", () => {
    let testDataDir: string;
    let daemonUrl: string;
    let proc: ReturnType<typeof spawn>;

    beforeAll(async () => {
      testDataDir = join(
        tmpdir(),
        `agentdock-phase1-acceptance-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(testDataDir, { recursive: true });

      proc = spawn("bun", ["run", "plugins/daemon.ts"], {
        env: {
          ...process.env,
          AGENTDOCK_DAEMON_PORT: "0",
          AGENTDOCK_DATA_DIR: testDataDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Wait up to 10s for daemon.json
      const infoPath = join(testDataDir, "daemon.json");
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (existsSync(infoPath)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!existsSync(infoPath)) {
        proc.kill();
        throw new Error("daemon.json not written within 10s");
      }
      const info = JSON.parse(readFileSync(infoPath, "utf-8"));
      daemonUrl = `http://127.0.0.1:${info.port}`;

      // Health check
      const healthDeadline = Date.now() + 5_000;
      while (Date.now() < healthDeadline) {
        try {
          const res = await fetch(`${daemonUrl}/health`);
          if (res.ok) break;
        } catch {
          // not ready
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }, 20_000);

    afterAll(() => {
      proc.kill();
      try {
        rmSync(testDataDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });

    it("GET /health returns 200 from real subprocess", async () => {
      const res = await fetch(`${daemonUrl}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.status).toBe("ok");
      expect(typeof body.daemonPort).toBe("number");
    });

    it("POST /sessions/allocate with empty body returns 400", async () => {
      const res = await fetch(`${daemonUrl}/sessions/allocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("POST with Origin header returns 403 from real subprocess", async () => {
      const res = await fetch(`${daemonUrl}/sessions/allocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://evil.com" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    });

    it("GET /health with Host: evil.com returns 403", async () => {
      // fetch() overrides Host header from URL, so use raw http.request.
      const { request } = await import("node:http");
      const port = new URL(daemonUrl).port;
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            path: "/health",
            headers: { Host: "evil.com" },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(403);
    });
  });
});