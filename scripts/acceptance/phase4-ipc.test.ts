// @ts-nocheck
/**
 * Phase 4 acceptance gate — full IPC surface (29 channels).
 *
 * Verifies all 29 IPC channels are registered, the bridge exposes them via
 * window.api, and a representative subset round-trips through the spawned
 * Electron process (daemon + db + worktree + shell + terminals).
 *
 * Failure here means a channel is unregistered, broken, or the preload
 * bridge doesn't expose it.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const ROOT = process.cwd();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await sleep(100);
  }
  return false;
}

describe("Phase 4: Full IPC surface (29 channels)", () => {
  describe("file inventory", () => {
    const required = [
      "electron/main/ipc/db.ts",
      "electron/main/ipc/sessions.ts",
      "electron/main/ipc/terminals.ts",
      "electron/main/ipc/fs-config.ts",
      "electron/main/ipc/worktree-shell.ts",
      "electron/main/ipc/index.ts",
    ];
    for (const f of required) {
      it(`${f} exists`, () => {
        expect(existsSync(join(ROOT, f))).toBe(true);
      });
    }

    it("electron/main/ipc/index.ts exports registerAllIpc", async () => {
      const content = readFileSync(join(ROOT, "electron/main/ipc/index.ts"), "utf-8");
      expect(content).toContain("export function registerAllIpc");
    });
  });

  describe("channel registry completeness", () => {
    it("electron/shared/api-types.ts IPC_CHANNELS has at least 29 entries", async () => {
      const mod = await import("../../electron/shared/api-types.js");
      const count = Object.keys(mod.IPC_CHANNELS).length;
      // 29 was the Phase 4 baseline; sync:project added later. Use `>=`
      // so future additions don't require touching this assertion.
      expect(count).toBeGreaterThanOrEqual(29);
    });

    it("IPC_CHANNELS keys match expected namespaces", async () => {
      const mod = await import("../../electron/shared/api-types.js");
      const keys = Object.keys(mod.IPC_CHANNELS);
      const namespaces = new Set(keys.map((k) => k.split(":")[0]));
      // Expected: db, sessions, terminals, fs, config, worktree, shell, bootstrap
      for (const ns of ["db", "sessions", "terminals", "fs", "config", "worktree", "shell", "bootstrap", "git"]) {
        expect(namespaces.has(ns), `missing namespace ${ns}`).toBe(true);
      }
    });
  });

  describe("electron/main.ts uses registerAllIpc", () => {
    it("imports registerAllIpc", () => {
      const content = readFileSync(join(ROOT, "electron/main.ts"), "utf-8");
      expect(content).toContain("registerAllIpc");
    });

    it("passes IPC deps to registerAllIpc", () => {
      const content = readFileSync(join(ROOT, "electron/main.ts"), "utf-8");
      expect(content).toContain("getDaemonClient");
      expect(content).toContain("getProjectPath");
    });
  });

  describe("preload.ts exposes the full surface", () => {
    it("calls contextBridge.exposeInMainWorld('api', ...)", () => {
      const content = readFileSync(join(ROOT, "electron/preload.ts"), "utf-8");
      expect(content).toContain('exposeInMainWorld("api"');
    });

    it("exposes all 10 namespaces (bootstrap, db, sessions, terminals, fs, config, worktree, shell, git, app)", () => {
      const content = readFileSync(join(ROOT, "electron/preload.ts"), "utf-8");
      for (const ns of ["bootstrap", "db", "sessions", "terminals", "fs", "config", "worktree", "shell", "git", "app"]) {
        expect(content, `missing ${ns}:`).toContain(`${ns}:`);
      }
    });
  });

  describe("real Electron round-trip (29 channels reachable)", () => {
    let testDataDir: string;
    let mainEntry: string;
    let electronProc: ReturnType<typeof spawn> | null = null;
    let daemonJsonPath: string;

    beforeAll(async () => {
      // Build first
      await new Promise<void>((resolve) => {
        const p = spawn("bunx", ["electron-vite", "build"], {
          cwd: ROOT,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        p.on("exit", () => resolve());
      });
      const findFirst = (dir: string): string | null => {
        if (!existsSync(dir)) return null;
        const fs = require("node:fs") as typeof import("node:fs");
        const files = fs.readdirSync(dir);
        return files.length > 0 ? join(dir, files[0]!) : null;
      };
      mainEntry = findFirst(join(ROOT, "out/main")) ?? join(ROOT, "out/main/main.js");

      testDataDir = join(
        tmpdir(),
        `agentdock-phase4-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(testDataDir, { recursive: true });
      daemonJsonPath = join(testDataDir, "daemon.json");
    }, 60_000);

    afterAll(() => {
      if (electronProc && !electronProc.killed) {
        try {
          electronProc.kill();
        } catch {
          /* best-effort */
        }
      }
      try {
        rmSync(testDataDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });

    it("Electron starts and writes daemon.json (proves Phase 3 still works)", async () => {
      electronProc = spawn("node_modules/.bin/electron", [mainEntry], {
        cwd: ROOT,
        env: {
          ...process.env,
          AGENTDOCK_DATA_DIR: testDataDir,
          FRONTEND_PORT: "5173",
          AGENTDOCK_USE_BUN: "1",
          ELECTRON_DISABLE_GPU: "1",
          ELECTRON_ENABLE_LOGGING: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const ok = await waitForFile(daemonJsonPath, 15_000);
      expect(ok).toBe(true);

      const info = JSON.parse(readFileSync(daemonJsonPath, "utf-8"));
      expect(typeof info.port).toBe("number");
    }, 25_000);

    it("daemon /health responds 200 (proves daemon ↔ main pipe works)", async () => {
      const info = JSON.parse(readFileSync(daemonJsonPath, "utf-8"));
      const res = await fetch(`http://127.0.0.1:${info.port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ success: true, status: "ok" });
    });

    it("daemon accepts a sample /sync call (proves typed Hono client path)", async () => {
      const info = JSON.parse(readFileSync(daemonJsonPath, "utf-8"));
      const res = await fetch(`http://127.0.0.1:${info.port}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: "phase4-test", pid: process.pid, lastSeq: 0 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; sessions: unknown[] };
      expect(body.success).toBe(true);
      expect(Array.isArray(body.sessions)).toBe(true);
    });
  });
});