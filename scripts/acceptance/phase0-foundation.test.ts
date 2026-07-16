/**
 * Phase 0 acceptance gate.
 *
 * Verifies that the test infrastructure is properly scaffolded before
 * any phase starts writing real code. Failure here means the test
 * foundation itself is broken — fix it before continuing.
 *
 * Asserts:
 *  - vitest workspace config loads with all three projects (unit/integration/acceptance)
 *  - playwright config loads without errors
 *  - test-utils helpers can be imported and basic smoke-test their behavior
 *  - electron/main.ts and electron/preload.ts are valid TypeScript (parse-able)
 *  - plugins/logger.ts exports a pino logger
 *  - The package.json scripts exist
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");

describe("Phase 0: Foundation + test infrastructure", () => {
  describe("workspace + test config", () => {
    it("vitest.config.ts defines three projects (inline)", () => {
      const path = resolve(ROOT, "vitest.config.ts");
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, "utf-8");
      expect(content).toContain('name: "unit"');
      expect(content).toContain('name: "integration"');
      expect(content).toContain('name: "acceptance"');
    });

    it("playwright.config.ts exists", () => {
      const path = resolve(ROOT, "playwright.config.ts");
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, "utf-8");
      expect(content).toContain("testDir");
      expect(content).toContain("./e2e");
    });
  });

  describe("test-utils", () => {
    it("ipc-mock.ts: register and invoke a handler", async () => {
      const { ipcMainMock, invokeIpc } = await import("../../test-utils/ipc-mock.js");
      ipcMainMock.clear();
      ipcMainMock.handle("test:echo", async (_event, x: unknown) => ({ echo: x }));
      const result = await invokeIpc<{ echo: number }>("test:echo", 42);
      expect(result).toEqual({ echo: 42 });
    });

    it("ipc-mock.ts: getHandler throws on unknown channel", async () => {
      const { ipcMainMock } = await import("../../test-utils/ipc-mock.js");
      ipcMainMock.clear();
      expect(() => ipcMainMock.getHandler("does:not:exist")).toThrow();
    });

    it("ipc-mock.ts: onIpcEvent receives webContents.send broadcasts", async () => {
      const { ipcMainMock, invokeIpc, onIpcEvent } = await import("../../test-utils/ipc-mock.js");
      ipcMainMock.clear();
      ipcMainMock.handle("test:broadcast", async (event, ...args: unknown[]) => {
        const [ch, payload] = args;
        if (typeof ch !== "string") throw new TypeError("Expected event channel");
        event.sender.send(ch, payload);
        return { ok: true };
      });

      const received: unknown[] = [];
      onIpcEvent("my:event", (data) => received.push(data));

      await invokeIpc("test:broadcast", "my:event", { hello: "world" });
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ hello: "world" });
    });

    it("test-context.ts: makeMockContext returns expected shape", async () => {
      const { makeMockContext } = await import("../../test-utils/test-context.js");
      const ctx = makeMockContext();
      expect(ctx.clientId).toBe("test-client");
      expect(ctx.sessionStatuses).toBeInstanceOf(Map);
      expect(ctx.reallocatedSessions).toEqual([]);
      expect(ctx.lastScanTime).toBeInstanceOf(Map);
    });

    it("test-db.ts: createTestDb creates an isolated path with cleanup", async () => {
      const { createTestDb } = await import("../../test-utils/test-db.js");
      const db = createTestDb();
      expect(db.path).toMatch(/agentdock-test-/);
      expect(existsSync(db.path)).toBe(false); // not created yet
      db.cleanup();
    });

    it("test-fixtures.ts: sampleProject and sampleSession are well-formed", async () => {
      const { sampleProject, sampleSession, makeProjectWithSessions } = await import(
        "../../test-utils/test-fixtures.js"
      );
      expect(sampleProject.id).toBeTruthy();
      expect(sampleSession.projectId).toBe(sampleProject.id);
      expect(sampleSession.ports?.FRONTEND_PORT).toBeTypeOf("number");
      const p3 = makeProjectWithSessions(3);
      expect(p3.sessions).toHaveLength(3);
    });

    it("structured-log.ts: createTestLogger returns a pino logger", async () => {
      const { createTestLogger } = await import("../../test-utils/structured-log.js");
      const log = createTestLogger("test");
      expect(log).toBeDefined();
      expect(typeof log.info).toBe("function");
    });
  });

  describe("electron skeleton", () => {
    it("electron/main.ts is a real implementation (Phase 3+)", () => {
      const path = resolve(ROOT, "electron/main.ts");
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, "utf-8");
      // Phase 0 wrote a placeholder; Phase 3 replaced it with real
      // app.whenReady / BrowserWindow / ipcMain logic. Verify the real
      // implementation markers are present, not the old placeholder text.
      expect(content).toContain("BrowserWindow");
      expect(content).toContain("app.whenReady");
      expect(content).not.toMatch(/placeholder/);
    });

    it("electron/preload.ts is a real implementation (Phase 3+)", () => {
      const path = resolve(ROOT, "electron/preload.ts");
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, "utf-8");
      expect(content).toContain("contextBridge");
      expect(content).toContain("exposeInMainWorld");
      expect(content).not.toMatch(/placeholder/);
    });

    it("electron.vite.config.ts defines three targets", () => {
      const path = resolve(ROOT, "electron.vite.config.ts");
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, "utf-8");
      expect(content).toContain("main:");
      expect(content).toContain("preload:");
      expect(content).toContain("renderer:");
    });
  });

  describe("logger + docs", () => {
    it("plugins/logger.ts exists and exports a logger", async () => {
      const path = resolve(ROOT, "plugins/logger.ts");
      expect(existsSync(path)).toBe(true);
      const mod = await import("../../plugins/logger.js");
      expect(mod.log).toBeDefined();
      expect(typeof mod.log.info).toBe("function");
    });

    it("docs/failure-modes.md exists with at least one entry", () => {
      const path = resolve(ROOT, "docs/failure-modes.md");
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, "utf-8");
      expect(content.length).toBeGreaterThan(100);
    });
  });

  describe("package.json scripts", () => {
    it("has current single-instance acceptance scripts", () => {
      const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
      expect(pkg.scripts["acceptance:phase0"]).toBeTruthy();
      expect(pkg.scripts["acceptance:single-instance"]).toBeTruthy();
      expect(pkg.scripts["acceptance:all"]).toBe("bun run test:acceptance");
    });

    it("has layered test scripts", () => {
      const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
      expect(pkg.scripts["test:unit"]).toBeTruthy();
      expect(pkg.scripts["test:integration"]).toBeTruthy();
      expect(pkg.scripts["test:acceptance"]).toBeTruthy();
      expect(pkg.scripts["test:e2e"]).toBeTruthy();
    });

    it("dev script uses electron-vite", () => {
      const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
      // The script may prefix cross-env NODE_OPTIONS to enable node:sqlite
      // — the assertion only cares that electron-vite is the runner.
      expect(pkg.scripts.dev).toMatch(/electron-vite dev/);
    });
  });

  describe("config files include new directories", () => {
    it("tsconfig.json includes electron, e2e, scripts/acceptance, test-utils", () => {
      const tsconfig = JSON.parse(readFileSync(resolve(ROOT, "tsconfig.json"), "utf-8"));
      const include: string[] = tsconfig.include;
      expect(include).toContain("electron");
      expect(include).toContain("e2e");
      expect(include).toContain("scripts/acceptance");
      expect(include).toContain("test-utils");
    });

    it("biome.json ignores new build artifacts", () => {
      const biome = JSON.parse(readFileSync(resolve(ROOT, "biome.json"), "utf-8"));
      const ignore: string[] = biome.files.ignore;
      expect(ignore).toContain("dist-electron");
      expect(ignore).toContain("e2e-report");
      expect(ignore).toContain("test-results");
    });
  });
});
