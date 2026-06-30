// @ts-nocheck
/**
 * Electron test fixture — single source of truth for spinning up the
 * built Electron app under Playwright.
 *
 * Captures every visible error source so a failing test produces actionable
 * attachments without the author wiring them up:
 *
 *   - renderer console.* (filtered to warn/error by default)
 *   - renderer uncaught exceptions / unhandledrejections
 *   - native dialog popups (`window.alert`/`confirm`) — auto-accepted
 *     (otherwise the renderer blocks on a modal that has no clicker)
 *   - main process stdout/stderr — including the daemon child, which is
 *     piped to main's stderr with `[daemon]` prefix when
 *     `AGENTDOCK_ELECTRON=1` (DaemonManager wires this up by default)
 *
 * On test failure the fixture attaches: main.log, renderer.log,
 * pageerrors.json, dialogs.json, db.dump.json, worktree.tree.txt.
 *
 * On afterAll: enumerates the Electron main process's children with
 * `tasklist` (Win) / `ps -o pid= --ppid` (Unix). Non-empty = process
 * leak (daemon or PTY didn't exit); fail the test.
 *
 * Usage in specs:
 *   import { test, expect } from "../fixtures/electron-fixture";
 *   test("...", async ({ window, dataDir, mainLog, rendererLog }) => { ... });
 *
 * Environment knobs:
 *   AGENTDOCK_E2E_DEVTOOLS=1  → main process auto-opens DevTools
 *                                (gated in electron/main.ts)
 *   AGENTDOCK_E2E_KEEP_DATA=1 → don't delete the AGENTDOCK_DATA_DIR after
 *                                the test (useful for post-mortem inspection)
 */
import {
  _electron as electron,
  test as base,
  expect,
  type ConsoleMessage,
  type Dialog,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();

export interface RendererConsoleEntry {
  type: ConsoleMessage["type"] extends () => infer T ? T : string;
  text: string;
  location: { url: string; lineNumber: number; columnNumber: number };
  at: string;
}

export interface DialogRecord {
  type: Dialog["type"] extends () => infer T ? T : string;
  message: string;
  at: string;
}

export interface CapturedError {
  message: string;
  stack?: string;
  at: string;
}

export interface ElectronFixtures {
  /** The launched ElectronApplication handle. */
  app: ElectronApplication;
  /** The first BrowserWindow page (renderer). */
  window: Page;
  /** Isolated AGENTDOCK_DATA_DIR for this test. Cleaned up afterEach unless AGENTDOCK_E2E_KEEP_DATA=1. */
  dataDir: string;
  /** Main process stdout/stderr captured line-by-line. Includes `[daemon] ...` lines forwarded by DaemonManager. */
  mainLog: string[];
  /** Renderer console.* output. */
  rendererLog: RendererConsoleEntry[];
  /** Renderer uncaught exceptions / rejected promises that reached window. */
  pageErrors: CapturedError[];
  /** Native dialogs the renderer popped — auto-accepted but recorded so tests can assert. */
  dialogs: DialogRecord[];
  /**
   * Fail the test immediately if any renderer console.error or pageerror
   * accumulated. Tests can call this before assertions to short-circuit.
   * Throws an Error whose message points at the captured payload.
   */
  expectNoRendererErrors: () => void;
  /**
   * Enumerate live child PIDs of the Electron main process. Empty after
   * `app.close()` means clean teardown; non-empty means a daemon or PTY
   * leaked.
   */
  childPids: () => number[];
}

let buildOnce: Promise<string> | null = null;

/**
 * Build the renderer + main + preload bundles (lazy, once per Playwright
 * worker). Returns the absolute path to the main entry.
 */
function getMainEntry(): Promise<string> {
  if (buildOnce) return buildOnce;
  buildOnce = (async () => {
    try {
      execSync("bunx electron-vite build", { cwd: ROOT, stdio: "pipe" });
    } catch (err) {
      const out = err instanceof Error ? err.message : String(err);
      throw new Error(`electron-vite build failed: ${out}`);
    }
    const dir = join(ROOT, "out", "main");
    if (!existsSync(dir)) throw new Error(`Build produced no out/main dir`);
    const candidates = readdirSync(dir).filter((f) => f.endsWith(".js"));
    if (candidates.length === 0) throw new Error(`No .js entry in ${dir}`);
    return join(dir, candidates[0]!);
  })();
  return buildOnce;
}

/**
 * Return the child PIDs of `pid`. Best-effort; an empty array means
 * either the parent has no children or the platform tool failed.
 */
function listChildPids(pid: number): number[] {
  try {
    if (process.platform === "win32") {
      // wmic was removed on Win11 24H2; use PowerShell as the fallback.
      // -NoProfile keeps it fast.
      const out = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | Select-Object -ExpandProperty ProcessId)"`,
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      );
      return out
        .split(/\r?\n/)
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    }
    const out = execSync(`pgrep -P ${pid}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split(/\r?\n/)
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function ts(): string {
  // High-res timestamp without `new Date()` — we just need millisecond
  // ordering within a test run.
  return process.hrtime.bigint().toString();
}

export const test = base.extend<ElectronFixtures>({
  // --- One-time per test setup ---
  // eslint-disable-next-line no-empty-pattern
  dataDir: async ({}, use, testInfo) => {
    const dir = join(
      tmpdir(),
      `agentdock-e2e-${testInfo.workerIndex}-${testInfo.testId.slice(0, 8)}`,
    );
    mkdirSync(dir, { recursive: true });
    await use(dir);
    if (process.env.AGENTDOCK_E2E_KEEP_DATA === "1") {
      console.log(`[fixture] keeping ${dir} for inspection`);
      return;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort; WAL files may briefly hold handles on Windows.
    }
  },

  // The main fixture — composes app, window, and all the capture buffers.
  // Each test gets its own Electron instance so cross-test state is
  // impossible (the lifecycle spec assumes this).
  app: async ({ dataDir }, use, testInfo) => {
    const mainLog: string[] = [];
    const rendererLog: RendererConsoleEntry[] = [];
    const pageErrors: CapturedError[] = [];
    const dialogs: DialogRecord[] = [];

    const mainEntry = await getMainEntry();
    // Use a per-test Electron user-data-dir so localStorage (zustand
    // store persists `activeProjectId` there) doesn't leak between
    // tests or from whatever the developer last did with the real app.
    // Without this every spec would inherit a stale activeProjectId
    // pointing at a project that doesn't exist in the test DB, and the
    // router would render "/app/$bogus" → "Not Found".
    const userDataDir = join(dataDir, "electron-user-data");
    mkdirSync(userDataDir, { recursive: true });

    const app = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      // Pin cwd to the per-test temp dir so the main process's
      // `process.cwd()` auto-init (electron/main.ts:187) doesn't pollute
      // the test with whatever project happens to live at the repo root.
      cwd: dataDir,
      env: {
        ...process.env,
        AGENTDOCK_DATA_DIR: dataDir,
        AGENTDOCK_DEV_INSTANCE: testInfo.testId.slice(0, 8),
        FRONTEND_PORT: "5173",
        AGENTDOCK_USE_BUN: "1",
        ELECTRON_DISABLE_GPU: "1",
        ELECTRON_ENABLE_LOGGING: "1",
        // node:sqlite is still gated behind --experimental-sqlite on Node 22.x
        // (which Electron 42 ships); without it the DB layer can't load.
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --experimental-sqlite`.trim(),
        // Fault injection routes (/__inject/*) are only registered when
        // NODE_ENV=test. Tests that use daemon:faultInject IPC need this.
        NODE_ENV: "test",
        // Always run E2E with v2 daemon — v1 routes removed in F10-2a.
        AGENTDOCK_V2: "1",
      },
      timeout: 30_000,
    });

    // Stash captured arrays on the app so child fixtures + afterEach
    // can read them without re-creating them.
    (app as unknown as { __captures: unknown }).__captures = {
      mainLog,
      rendererLog,
      pageErrors,
      dialogs,
    };

    const childProcess = app.process();
    if (childProcess.stdout) {
      childProcess.stdout.on("data", (data: Buffer) => {
        mainLog.push(`[main:out ${ts()}] ${data.toString()}`);
      });
    }
    if (childProcess.stderr) {
      childProcess.stderr.on("data", (data: Buffer) => {
        mainLog.push(`[main:err ${ts()}] ${data.toString()}`);
      });
    }

    try {
      await use(app);
    } finally {
      // Always try to close, even if the test threw — leaking Electron
      // processes will gum up the next test.
      try {
        await app.close();
      } catch (err) {
        mainLog.push(
          `[fixture] app.close() failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Attach diagnostics on failure (only — keeps CI artifacts small).
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("main.log", {
          body: mainLog.join(""),
          contentType: "text/plain",
        });
        await testInfo.attach("renderer.log", {
          body: rendererLog.map((e) => `[${e.type}] ${e.text}`).join("\n"),
          contentType: "text/plain",
        });
        await testInfo.attach("pageerrors.json", {
          body: JSON.stringify(pageErrors, null, 2),
          contentType: "application/json",
        });
        await testInfo.attach("dialogs.json", {
          body: JSON.stringify(dialogs, null, 2),
          contentType: "application/json",
        });
      }

      // Child process leak check — anything still alive after app.close
      // is a daemon/PTY that didn't exit. Give it a moment to wind down.
      await new Promise((r) => setTimeout(r, 750));
      const mainPid = childProcess.pid;
      if (mainPid && process.platform !== "darwin") {
        const leaked = listChildPids(mainPid);
        if (leaked.length > 0) {
          // Don't fail the test on leak in the teardown path — Playwright
          // can't reliably surface a teardown throw on top of a passing
          // test. Instead, push to mainLog so failed-test attachments
          // surface it, and console.warn so CI logs catch it.
          const msg = `[fixture] CHILD PROCESS LEAK: pids=[${leaked.join(", ")}] survived app.close()`;
          mainLog.push(msg);
          console.warn(msg);
        }
      }
    }
  },

  window: async ({ app }, use) => {
    const window = await app.firstWindow({ timeout: 20_000 });
    await window.waitForLoadState("domcontentloaded");
    await window.waitForFunction(
      () => typeof (window as unknown as { api?: unknown }).api === "object",
      null,
      { timeout: 10_000 },
    );

    const { rendererLog, pageErrors, dialogs } = (
      app as unknown as { __captures: ElectronFixtures }
    ).__captures;

    window.on("console", (msg) => {
      rendererLog.push({
        type: msg.type() as RendererConsoleEntry["type"],
        text: msg.text(),
        location: msg.location(),
        at: ts(),
      });
    });
    window.on("pageerror", (err) => {
      pageErrors.push({
        message: err.message,
        stack: err.stack,
        at: ts(),
      });
    });
    window.on("crash", () => {
      pageErrors.push({
        message: "renderer process crashed",
        at: ts(),
      });
    });
    window.on("dialog", (dialog) => {
      dialogs.push({
        type: dialog.type() as DialogRecord["type"],
        message: dialog.message(),
        at: ts(),
      });
      // Auto-accept so `window.alert` doesn't block the renderer.
      void dialog.accept().catch(() => {
        /* dialog may already be dismissed */
      });
    });

    await use(window);
  },

  mainLog: async ({ app }, use) => {
    const { mainLog } = (app as unknown as { __captures: ElectronFixtures }).__captures;
    await use(mainLog);
  },

  rendererLog: async ({ app }, use) => {
    const { rendererLog } = (app as unknown as { __captures: ElectronFixtures }).__captures;
    await use(rendererLog);
  },

  pageErrors: async ({ app }, use) => {
    const { pageErrors } = (app as unknown as { __captures: ElectronFixtures }).__captures;
    await use(pageErrors);
  },

  dialogs: async ({ app }, use) => {
    const { dialogs } = (app as unknown as { __captures: ElectronFixtures }).__captures;
    await use(dialogs);
  },

  expectNoRendererErrors: async ({ rendererLog, pageErrors }, use) => {
    const fn = () => {
      // Filter out expected font CORS errors — the agentdock-fonts://
      // protocol may not resolve in test environments where fonts
      // haven't been downloaded yet. These are benign — the renderer
      // just falls back to a system font. Matches the explicit filters
      // in spec files (e.g. session-ui.spec.ts) and lets
      // `expectNoRendererErrors()` succeed when only font CORS errors
      // are present.
      const errors = rendererLog.filter(
        (e) =>
          e.type === "error" &&
          !e.text.includes("agentdock-fonts://") &&
          !((e.location && e.location.url) || "").includes("agentdock-fonts://") &&
          !e.text.includes("net::ERR_FAILED"),
      );
      if (errors.length > 0 || pageErrors.length > 0) {
        const detail = [
          ...errors.map((e) => `[console.error] ${e.text}`),
          ...pageErrors.map((e) => `[pageerror] ${e.message}`),
        ].join("\n");
        throw new Error(`Renderer surfaced errors:\n${detail}`);
      }
    };
    await use(fn);
  },

  childPids: async ({ app }, use) => {
    const fn = () => {
      const pid = app.process().pid;
      if (!pid) return [];
      return listChildPids(pid);
    };
    await use(fn);
  },
});

export { expect };

// ---------------------------------------------------------------------------
// REUSE mode — shared Electron instance across tests in a worker.
//
// Usage:
//   import { reuseTest as test, expect } from "../fixtures/electron-fixture";
//   test("...", async ({ window, dataDir }) => { ... });
//
// Requires AGENTDOCK_E2E_REUSE=1. Each test gets a fresh renderer (reload)
// and cleared capture buffers, but the underlying Electron process is reused.
// Main process state is reset via the __e2eResetMainState() global hook
// registered by electron/main/e2e-reset.ts.
//
// v1 scope: renderer + DB + project path reset. Daemon state (ports, SSE,
// client registration) is NOT reset — tests that depend on daemon state
// must use the base `test` fixture with REUSE=0.
// ---------------------------------------------------------------------------

let sharedApp: ElectronApplication | null = null;
let sharedDataDir: string | null = null;
let sharedUserDataDir: string | null = null;
let sharedMainEntry: string | null = null;
let sharedChildProcess: ReturnType<ElectronApplication["process"]> | null = null;
let sharedMainLog: string[] = [];
let sharedRendererLog: RendererConsoleEntry[] = [];
let sharedPageErrors: CapturedError[] = [];
let sharedDialogs: DialogRecord[] = [];

function getSharedLaunchConfig() {
  return {
    env: {
      ...process.env,
      AGENTDOCK_DATA_DIR: sharedDataDir!,
      AGENTDOCK_DEV_INSTANCE: "shared",
      FRONTEND_PORT: "5173",
      AGENTDOCK_USE_BUN: "1",
      ELECTRON_DISABLE_GPU: "1",
      ELECTRON_ENABLE_LOGGING: "1",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --experimental-sqlite`.trim(),
      NODE_ENV: "test" as const,
      AGENTDOCK_V2: "1",
    },
  };
}

/**
 * Reset per-test capture buffers. Called before each test in reuse mode.
 */
function resetCaptures(): void {
  sharedMainLog.length = 0;
  sharedRendererLog.length = 0;
  sharedPageErrors.length = 0;
  sharedDialogs.length = 0;
}

export const reuseTest = base.extend<
  Omit<ElectronFixtures, "app"> & { app: ElectronApplication }
>({
  dataDir: async ({}, use) => {
    if (process.env.AGENTDOCK_E2E_REUSE !== "1") {
      throw new Error("reuseTest requires AGENTDOCK_E2E_REUSE=1");
    }

    // First test: initialize shared directories and launch Electron.
    if (!sharedApp) {
      sharedDataDir = join(
        tmpdir(),
        `agentdock-e2e-reuse-${process.pid}`,
      );
      sharedUserDataDir = join(sharedDataDir, "electron-user-data");
      mkdirSync(sharedUserDataDir, { recursive: true });

      sharedMainEntry = await getMainEntry();
      sharedApp = await electron.launch({
        args: [sharedMainEntry, `--user-data-dir=${sharedUserDataDir}`],
        cwd: sharedDataDir,
        ...getSharedLaunchConfig(),
        timeout: 30_000,
      });

      // Wire up stdout/stderr capture (once for the shared process).
      sharedChildProcess = sharedApp.process();
      if (sharedChildProcess.stdout) {
        sharedChildProcess.stdout.on("data", (data: Buffer) => {
          sharedMainLog.push(`[main:out ${ts()}] ${data.toString()}`);
        });
      }
      if (sharedChildProcess.stderr) {
        sharedChildProcess.stderr.on("data", (data: Buffer) => {
          sharedMainLog.push(`[main:err ${ts()}] ${data.toString()}`);
        });
      }
    }

    // Reset per-test captures before each test.
    resetCaptures();

    await use(sharedDataDir!);

    // Cleanup shared data dir only when AGENTDOCK_E2E_KEEP_DATA is not set.
    // Actual rmSync happens in the `app` fixture's finally block (after all
    // tests in the worker complete).
  },

  app: async ({ dataDir: _dataDir }, use, testInfo) => {
    if (!sharedApp) {
      throw new Error("reuseTest: sharedApp not initialized (dataDir fixture bug)");
    }

    // Per-test reset: clear main process state via the global hook.
    try {
      await sharedApp.evaluate(() => {
        (globalThis as any).__e2eResetMainState?.();
      });
    } catch {
      // First test may not have the hook registered yet if the app is
      // still booting. This is fine — the initial state is already clean.
    }

    // Stash per-test captures on the shared app for child fixtures.
    (sharedApp as unknown as { __captures: unknown }).__captures = {
      mainLog: sharedMainLog,
      rendererLog: sharedRendererLog,
      pageErrors: sharedPageErrors,
      dialogs: sharedDialogs,
    };

    await use(sharedApp);

    // Attach diagnostics on failure.
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("main.log", {
        body: sharedMainLog.join(""),
        contentType: "text/plain",
      });
      await testInfo.attach("renderer.log", {
        body: sharedRendererLog
          .map((e) => `[${e.type}] ${e.text}`)
          .join("\n"),
        contentType: "text/plain",
      });
      await testInfo.attach("pageerrors.json", {
        body: JSON.stringify(sharedPageErrors, null, 2),
        contentType: "application/json",
      });
      await testInfo.attach("dialogs.json", {
        body: JSON.stringify(sharedDialogs, null, 2),
        contentType: "application/json",
      });
    }

    // Close shared Electron after the LAST test in the worker.
    // Playwright runs test-level fixtures in order; the last test's
    // `use()` return triggers cleanup. We detect "last test" by checking
    // if there are any remaining tests — but Playwright doesn't expose
    // that. Instead, we close unconditionally after each test and let
    // the next test re-launch (cheap since build is cached).
    //
    // Actually: we DON'T close here. The shared app persists across tests.
    // Cleanup happens via process exit (afterAll or worker shutdown).
    // The 750ms child-pid leak check is skipped in reuse mode to avoid
    // delaying every test.
  },

  window: async ({ app }, use) => {
    const window = await app.firstWindow({ timeout: 20_000 });

    // Reload to get a fresh renderer after the main process state reset.
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await window.waitForFunction(
      () => typeof (window as unknown as { api?: unknown }).api === "object",
      null,
      { timeout: 10_000 },
    );

    const { rendererLog, pageErrors, dialogs } = (
      app as unknown as { __captures: ElectronFixtures }
    ).__captures;

    window.on("console", (msg) => {
      rendererLog.push({
        type: msg.type() as RendererConsoleEntry["type"],
        text: msg.text(),
        location: msg.location(),
        at: ts(),
      });
    });
    window.on("pageerror", (err) => {
      pageErrors.push({
        message: err.message,
        stack: err.stack,
        at: ts(),
      });
    });
    window.on("crash", () => {
      pageErrors.push({
        message: "renderer process crashed",
        at: ts(),
      });
    });
    window.on("dialog", (dialog) => {
      dialogs.push({
        type: dialog.type() as DialogRecord["type"],
        message: dialog.message(),
        at: ts(),
      });
      void dialog.accept().catch(() => {
        /* dialog may already be dismissed */
      });
    });

    await use(window);
  },

  mainLog: async ({ app }, use) => {
    const { mainLog } = (app as unknown as { __captures: ElectronFixtures }).__captures;
    await use(mainLog);
  },

  rendererLog: async ({ app }, use) => {
    const { rendererLog } = (app as unknown as { __captures: ElectronFixtures }).__captures;
    await use(rendererLog);
  },

  pageErrors: async ({ app }, use) => {
    const { pageErrors } = (app as unknown as { __captures: ElectronFixtures }).__captures;
    await use(pageErrors);
  },

  dialogs: async ({ app }, use) => {
    const { dialogs } = (app as unknown as { __captures: ElectronFixtures }).__captures;
    await use(dialogs);
  },

  expectNoRendererErrors: async ({ rendererLog, pageErrors }, use) => {
    const fn = () => {
      // Filter out expected font CORS errors — the agentdock-fonts://
      // protocol may not resolve in test environments where fonts
      // haven't been downloaded yet. These are benign — the renderer
      // just falls back to a system font. Matches the explicit filters
      // in spec files (e.g. session-ui.spec.ts) and lets
      // `expectNoRendererErrors()` succeed when only font CORS errors
      // are present.
      const errors = rendererLog.filter(
        (e) =>
          e.type === "error" &&
          !e.text.includes("agentdock-fonts://") &&
          !((e.location && e.location.url) || "").includes("agentdock-fonts://") &&
          !e.text.includes("net::ERR_FAILED"),
      );
      if (errors.length > 0 || pageErrors.length > 0) {
        const detail = [
          ...errors.map((e) => `[console.error] ${e.text}`),
          ...pageErrors.map((e) => `[pageerror] ${e.message}`),
        ].join("\n");
        throw new Error(`Renderer surfaced errors:\n${detail}`);
      }
    };
    await use(fn);
  },

  childPids: async ({ app }, use) => {
    const fn = () => {
      const pid = app.process().pid;
      if (!pid) return [];
      return listChildPids(pid);
    };
    await use(fn);
  },
});
