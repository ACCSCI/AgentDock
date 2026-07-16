import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Electron + Playwright launcher for the user-agent.
 *
 * Boots Electron exactly like the working e2e/fixtures/electron-fixture.ts
 * does, then drives the UI through cold-start → open-project → workspace
 * and emits a JSON report.
 *
 * Why copy the e2e fixture's env block instead of importing it:
 *   - The fixture is written for Playwright's `test` runner with
 *     `extend()`/`use()` semantics; it's not a reusable launcher.
 *   - We need a one-shot bun/tsx entrypoint, not a Playwright spec.
 *   - Copying 10 env vars is cheaper than refactoring the fixture.
 *
 * Critical env vars (from the working fixture — without them, Playwright's
 * Node-inspector WebSocket handshake hangs on Node v24 + Electron 42):
 *   - AGENTDOCK_USE_BUN=1           → main process uses bun
 *   - NODE_ENV=test                 → fault injection routes registered
 *   - ELECTRON_DISABLE_GPU=1        → headless-friendly
 *   - ELECTRON_ENABLE_LOGGING=1     → more diagnostic output
 *   - AGENTDOCK_DATA_DIR=<path>     → isolates project DB to a temp dir
 *   - AGENTDOCK_DEV_INSTANCE=1      → isolates global projects.db
 *
 * Usage:
 *   bun run .flue/tools/launch-electron.ts <projectPath> [--out report.json]
 */
import { type ElectronApplication, type Page, _electron as electron } from "@playwright/test";

const ROOT = "F:\\ProgramPlayground\\JavaScript\\AgentDock\\.agentdock\\worktrees\\bed4c452-74d";
const SHOT_DIR = join(ROOT, "test-results", "user-agent-shots");

interface StepResult {
  step: string;
  status: "passed" | "failed";
  detail?: string;
  screenshot?: string;
}

interface TestReport {
  targetProject: string;
  startedAt: string;
  finishedAt: string;
  steps: StepResult[];
  passed: boolean;
}

async function shot(window: Page, name: string): Promise<string> {
  if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true });
  const path = join(SHOT_DIR, name);
  await window.screenshot({ path });
  return path;
}

async function step(window: Page, label: string, fn: () => Promise<void>): Promise<StepResult> {
  try {
    await fn();
    const s = await shot(window, `ok-${label.replace(/\s+/g, "-")}.png`);
    return { step: label, status: "passed", screenshot: s };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const s = await shot(window, `FAIL-${label.replace(/\s+/g, "-")}.png`).catch(() => undefined);
    return { step: label, status: "failed", detail: msg, screenshot: s };
  }
}

function mainEntry(): string {
  const dir = join(ROOT, "out", "main");
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  if (files.length === 0)
    throw new Error("No main entry in out/main — run `npx electron-vite build` first");
  return join(dir, files[0]!);
}

async function run(projectPath: string): Promise<TestReport> {
  const startedAt = new Date().toISOString();
  const steps: StepResult[] = [];
  let app: ElectronApplication | null = null;

  // Per-run temp dir → isolates AGENTDOCK_DATA_DIR (project DB lives here in dev mode)
  const dataDir = mkdtempSync(join(tmpdir(), "agentdock-ua-"));
  const userDataDir = join(dataDir, "electron-user-data");
  mkdirSync(userDataDir, { recursive: true });

  try {
    app = await electron.launch({
      args: [mainEntry(), `--user-data-dir=${userDataDir}`],
      cwd: dataDir,
      env: {
        ...process.env,
        // The crucial isolation + WS-handshake-friendly env vars.
        // Keep these aligned with e2e/fixtures/electron-fixture.ts.
        AGENTDOCK_DATA_DIR: dataDir,
        AGENTDOCK_DEV_INSTANCE: "1",
        AGENTDOCK_USE_BUN: "1",
        FRONTEND_PORT: "5173",
        ELECTRON_DISABLE_GPU: "1",
        ELECTRON_ENABLE_LOGGING: "1",
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --experimental-sqlite`.trim(),
        NODE_ENV: "test",
      },
      timeout: 60_000,
    });
    const window = await app.firstWindow({ timeout: 60_000 });
    window.on("dialog", async (d) => {
      console.error(`[dialog] ${d.message()}`);
      await d.accept().catch(() => {});
    });

    await window.waitForLoadState("domcontentloaded");
    await window.waitForTimeout(3000);

    // Step 1: cold start — home button visible
    steps.push(
      await step(window, "cold start home button", async () => {
        await window
          .locator('[data-testid="home-open-project"]')
          .waitFor({ state: "visible", timeout: 15_000 });
      }),
    );

    // Step 2: click open project → modal appears
    steps.push(
      await step(window, "click open project modal", async () => {
        await window.locator('[data-testid="home-open-project"]').click();
        await window
          .locator('[data-testid="dir-modal"]')
          .waitFor({ state: "visible", timeout: 10_000 });
      }),
    );

    // Step 3: navigate dir browser to target project
    steps.push(
      await step(window, "navigate to target project", async () => {
        const segments = projectPath.split(/[\\/]/).filter((s) => s.length > 0);
        segments[0] = `${segments[0]}\\`;
        const waitEntries = async () => {
          const entries = window.locator('[data-testid="dir-entry"]');
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline) {
            if ((await entries.count()) > 0) return;
            await window.waitForTimeout(100);
          }
          throw new Error("dir-entry never rendered");
        };
        for (let i = 0; i < segments.length - 1; i++) {
          const seg = segments[i]!;
          await window.locator('[data-testid="dir-search-input"]').fill(seg);
          await window.waitForTimeout(300);
          await window
            .locator('[data-testid="dir-entry"]')
            .filter({
              has: window.locator(".dir-entry-name", {
                hasText: new RegExp(`^${seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
              }),
            })
            .first()
            .dblclick();
          await waitEntries();
        }
        const last = segments[segments.length - 1]!;
        await window.locator('[data-testid="dir-search-input"]').fill(last);
        await window.waitForTimeout(300);
        await window
          .locator('[data-testid="dir-entry"]')
          .filter({
            has: window.locator(".dir-entry-name", {
              hasText: new RegExp(`^${last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
            }),
          })
          .first()
          .click();
        await window.locator('[data-testid="dir-confirm"]').click();
        await window
          .locator('[data-testid="dir-modal"]')
          .waitFor({ state: "hidden", timeout: 10_000 });
      }),
    );

    // Step 4: project loads (h2 shows project basename) — this is the one
    // that crashed before the fix; should now pass.
    const projectName = projectPath.split(/[\\/]/).filter(Boolean).pop()!;
    steps.push(
      await step(window, "project workspace loaded", async () => {
        // Wait for the workspace to settle; bail fast if the ErrorBoundary fires.
        await window.waitForTimeout(3000);
        // Defensive: if the ErrorBoundary "Cannot read properties of undefined
        // (reading 'find')" appears, fail with a clear message.
        const errorBoundary = await window
          .locator("text=Cannot read properties of undefined")
          .isVisible()
          .catch(() => false);
        if (errorBoundary) {
          throw new Error(
            "ErrorBoundary fired: 'Cannot read properties of undefined' — sessions.find crash regressed",
          );
        }
        await window
          .locator("h2")
          .filter({ hasText: projectName })
          .first()
          .waitFor({ state: "visible", timeout: 20_000 });
      }),
    );
  } finally {
    if (app) await app.close();
  }

  const finishedAt = new Date().toISOString();
  return {
    targetProject: projectPath,
    startedAt,
    finishedAt,
    steps,
    passed: steps.every((s) => s.status === "passed"),
  };
}

const projectPath = process.argv[2];
if (!projectPath) {
  console.error("Usage: bun run .flue/tools/launch-electron.ts <projectPath>");
  process.exit(2);
}

run(projectPath)
  .then((report) => {
    const out = process.argv.includes("--out")
      ? process.argv[process.argv.indexOf("--out") + 1]
      : join(SHOT_DIR, `report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.passed ? 0 : 1);
  })
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(2);
  });
