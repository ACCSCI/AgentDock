import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-nocheck
/**
 * Raw E2E test — no fixture wrapping, direct electron.launch.
 * Simulates user: open project, create session, delete session.
 *
 * Run standalone:
 *   npx tsx e2e/agent-e2e-raw.ts
 */
import { _electron as electron } from "@playwright/test";

const ROOT = process.cwd();

const SCREENSHOT_DIR = join(ROOT, "e2e", "screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

function screenshotPath(name: string): string {
  return join(SCREENSHOT_DIR, name);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function findMainEntry(): string {
  const dir = join(ROOT, "out", "main");
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  if (files.length === 0) throw new Error(`No .js entry in ${dir}`);
  return join(dir, files[0]!);
}

interface StepResult {
  step: string;
  status: "passed" | "failed" | "skipped";
  detail: string;
  screenshot: string;
}

const steps: StepResult[] = [];
const errors: string[] = [];

function recordStep(
  step: string,
  status: "passed" | "failed" | "skipped",
  detail: string,
  screenshot: string,
) {
  const entry: StepResult = { step, status, detail, screenshot };
  steps.push(entry);
  if (status === "failed") {
    errors.push(`[${step}] ${detail}`);
  }
  console.log(
    `[STEP] ${status.toUpperCase()}: ${step} — ${detail}${screenshot ? ` (screenshot: ${screenshot})` : ""}`,
  );
}

async function main() {
  console.log("=== AgentDock Raw E2E Test ===");
  console.log(`Root: ${ROOT}`);
  console.log(`Screenshots: ${SCREENSHOT_DIR}`);

  // Set up isolated data dir
  const dataDir = join(
    tmpdir(),
    `agentdock-raw-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const userDataDir = join(dataDir, "electron-user-data");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });
  console.log(`Data dir: ${dataDir}`);

  const mainEntry = findMainEntry();
  console.log(`Main entry: ${mainEntry}`);

  const targetProject = "F:\\ProgramPlayground\\JavaScript\\Copilot-Switch";

  // ---------- Launch Electron ----------
  console.log("\n>>> Launching Electron app...");
  const app = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    cwd: dataDir,
    env: {
      ...process.env,
      AGENTDOCK_DATA_DIR: dataDir,
      AGENTDOCK_DEV_INSTANCE: "raw-e2e",
      FRONTEND_PORT: "5173",
      AGENTDOCK_USE_BUN: "1",
      ELECTRON_DISABLE_GPU: "1",
      ELECTRON_ENABLE_LOGGING: "1",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --experimental-sqlite`.trim(),
      NODE_ENV: "test",
      AGENTDOCK_V2: "1",
    },
    timeout: 30_000,
  });

  const childProcess = app.process();
  const mainLog: string[] = [];
  if (childProcess.stdout) {
    childProcess.stdout.on("data", (d: Buffer) => mainLog.push(`[out] ${d.toString()}`));
  }
  if (childProcess.stderr) {
    childProcess.stderr.on("data", (d: Buffer) => mainLog.push(`[err] ${d.toString()}`));
  }

  let window: import("@playwright/test").Page | null = null;

  try {
    // ---------- Wait for main window ----------
    console.log("\n>>> Waiting for main window...");
    window = await app.firstWindow({ timeout: 20_000 });
    await window.waitForLoadState("domcontentloaded");
    console.log(">>> Waiting for window.api bridge...");
    await window.waitForFunction(
      () => typeof (window as unknown as { api?: unknown }).api === "object",
      null,
      { timeout: 10_000 },
    );
    console.log(">>> window.api is ready.");

    // Record renderer console + dialogs
    const rendererLog: string[] = [];
    window.on("console", (msg) => {
      rendererLog.push(`[${msg.type()}] ${msg.text()}`);
    });
    window.on("dialog", async (dialog) => {
      console.log(`[DIALOG] ${dialog.type()}: ${dialog.message()}`);
      await dialog.accept().catch(() => {});
    });

    // ---------- Step 1: Screenshot home page after cold start ----------
    console.log("\n--- Step 1: Screenshot home page ---");
    await sleep(2000); // let UI settle
    const ssHome = "01-home-cold-start.png";
    await window.screenshot({ path: screenshotPath(ssHome), fullPage: false });
    recordStep("冷启动后主页", "passed", "应用冷启动完成，显示主页", ssHome);

    // ---------- Step 2: Verify "打开项目" button visible ----------
    console.log("\n--- Step 2: Verify open project button ---");
    try {
      const openBtn = window.locator('[data-testid="home-open-project"]');
      await openBtn.waitFor({ state: "visible", timeout: 10_000 });
      recordStep("验证打开项目按钮", "passed", "home-open-project 按钮可见", "");
    } catch (e: any) {
      recordStep("验证打开项目按钮", "failed", `按钮不可见: ${e.message}`, "");
      throw e;
    }

    // ---------- Step 3: Click "打开项目" ----------
    console.log("\n--- Step 3: Click Open Project button ---");
    try {
      await window.locator('[data-testid="home-open-project"]').click();
      await window
        .locator('[data-testid="dir-modal"]')
        .waitFor({ state: "visible", timeout: 10_000 });
      await sleep(1000);
      const ssModal = "02-modal-open.png";
      await window.screenshot({ path: screenshotPath(ssModal), fullPage: false });
      recordStep("打开项目对话框", "passed", "dir-modal 可见", ssModal);
    } catch (e: any) {
      recordStep("打开项目对话框", "failed", `modal 未打开: ${e.message}`, "");
      throw e;
    }

    // ---------- Step 4: Navigate to Copilot-Switch project ----------
    console.log("\n--- Step 4: Navigate to target project ---");
    const targetPath = targetProject;
    const segments = targetPath.split(/[\\/]/).filter((s) => s.length > 0 && s !== ".");

    try {
      // Wait for initial dir listing
      let deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const count = await window.locator('[data-testid="dir-entry"]').count();
        if (count > 0) break;
        await sleep(100);
      }

      // Debug: print visible entries
      const entryNames = await window
        .locator('[data-testid="dir-entry"] .dir-entry-name')
        .allTextContents();
      console.log(`  Initial entries (${entryNames.length}):`, entryNames.slice(0, 10));

      // Helper: find an entry matching a segment name (flexible matching)
      async function findAndClickEntry(segName: string, doubleClick: boolean) {
        const activeWindow = window;
        if (!activeWindow) throw new Error("Electron window is not available");
        // Try exact match first, then case-insensitive, then contains
        const escaped = segName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const patterns = [
          new RegExp(`^${escaped}\\s*$`, "i"), // exact, case-insensitive
          new RegExp(`^${escaped}\\s*$`), // exact, case-sensitive
          new RegExp(escaped, "i"), // contains, case-insensitive
        ];

        for (const pattern of patterns) {
          const entry = activeWindow
            .locator('[data-testid="dir-entry"]')
            .filter({ has: activeWindow.locator(".dir-entry-name") })
            .filter({ hasText: pattern })
            .first();
          try {
            await entry.waitFor({ state: "attached", timeout: 2000 });
            const isVisible = await entry.isVisible();
            if (isVisible) {
              console.log(`    Found entry for "${segName}" matching pattern ${pattern}`);
              if (doubleClick) {
                await entry.dblclick();
              } else {
                await entry.click();
              }
              return true;
            }
          } catch {
            // try next pattern
          }
        }
        return false;
      }

      // Drill into each segment except the last
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i]!;
        // For drive letters like "F:", also try with trailing slash
        const segVariants = [seg];
        if (process.platform === "win32" && /^[A-Za-z]:$/.test(seg)) {
          segVariants.push(`${seg}\\`, seg.toLowerCase(), seg.toUpperCase());
        }
        console.log(
          `  Drilling into segment ${i}: "${seg}" (variants: ${JSON.stringify(segVariants)})`,
        );

        // Try search first
        const searchInput = window.locator('[data-testid="dir-search-input"]');
        await searchInput.fill(seg);
        await sleep(500);

        let found = false;
        for (const variant of segVariants) {
          if (await findAndClickEntry(variant, true)) {
            found = true;
            break;
          }
        }

        if (!found) {
          // Clear search and try without it
          await searchInput.fill("");
          await sleep(300);
          for (const variant of segVariants) {
            if (await findAndClickEntry(variant, true)) {
              found = true;
              break;
            }
          }
        }

        if (!found) {
          const currentEntries = await window
            .locator('[data-testid="dir-entry"] .dir-entry-name')
            .allTextContents();
          throw new Error(
            `Could not find entry for segment "${seg}". Visible entries: ${JSON.stringify(currentEntries.slice(0, 20))}`,
          );
        }

        // Wait for next directory listing
        deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const count = await window.locator('[data-testid="dir-entry"]').count();
          if (count > 0) break;
          await sleep(100);
        }
      }

      // Select the last segment
      const last = segments[segments.length - 1]!;
      console.log(`  Selecting last segment: "${last}"`);
      const searchInput = window.locator('[data-testid="dir-search-input"]');
      await searchInput.fill(last);
      await sleep(500);

      const lastFound = await findAndClickEntry(last, false);
      if (!lastFound) {
        // Clear search and try again
        await searchInput.fill("");
        await sleep(300);
        const lastFound2 = await findAndClickEntry(last, false);
        if (!lastFound2) {
          const currentEntries = await window
            .locator('[data-testid="dir-entry"] .dir-entry-name')
            .allTextContents();
          throw new Error(
            `Could not find entry for last segment "${last}". Visible entries: ${JSON.stringify(currentEntries.slice(0, 20))}`,
          );
        }
      }
      await sleep(300);

      // Click confirm
      console.log("  Clicking confirm...");
      await window.locator('[data-testid="dir-confirm"]').click();
      await window
        .locator('[data-testid="dir-modal"]')
        .waitFor({ state: "hidden", timeout: 15_000 });
      console.log("  Modal closed.");

      recordStep("导航到目标项目", "passed", `导航到 ${targetPath}`, "");
    } catch (e: any) {
      recordStep("导航到目标项目", "failed", `导航失败: ${e.message}`, "");
      throw e;
    }

    // ---------- Step 5: Verify project loaded ----------
    console.log("\n--- Step 5: Verify project loaded ---");
    await sleep(3000); // let workspace render
    try {
      // The project name should appear in an h2
      const h2 = window.locator("h2").filter({ hasText: "Copilot-Switch" });
      await h2.first().waitFor({ state: "visible", timeout: 15_000 });
      const ssWorkspace = "03-project-loaded.png";
      await window.screenshot({ path: screenshotPath(ssWorkspace), fullPage: false });
      recordStep("项目加载验证", "passed", "Copilot-Switch 在 h2 中可见", ssWorkspace);
    } catch (e: any) {
      // Try alternative: check tab bar
      try {
        const tabBar = window.locator('[data-testid="tab-bar"]');
        await tabBar.waitFor({ state: "visible", timeout: 5_000 });
        const tab = window.locator('[data-testid="project-tab"]').first();
        const tabText = await tab.textContent();
        console.log(`  Tab bar visible, first tab: "${tabText}"`);
        const ssWorkspace = "03-project-loaded.png";
        await window.screenshot({ path: screenshotPath(ssWorkspace), fullPage: false });
        recordStep("项目加载验证", "passed", `TabBar 可见, tab内容: "${tabText}"`, ssWorkspace);
      } catch (e2: any) {
        recordStep("项目加载验证", "failed", `h2/tab 都不可见: ${e.message} / ${e2.message}`, "");
        // Don't throw -- take screenshot anyway and continue
        const ssWorkspace = "03-project-loaded.png";
        await window.screenshot({ path: screenshotPath(ssWorkspace), fullPage: false });
      }
    }

    // ---------- Step 6: Create session via sidebar "+" ----------
    console.log("\n--- Step 6: Create session via sidebar '+' ---");
    await sleep(3000);
    try {
      // Collect existing sessions via db:projects:list
      const preInfo = await window.evaluate(async () => {
        try {
          const projects = await (window as any).api.db.projects.list();
          const active = projects.find((p: any) => p.path.includes("Copilot-Switch"));
          return {
            activeProjectId: active?.id ?? null,
            existingIds: (active?.sessions ?? []).map((s: any) => s.id),
            allProjectIds: projects.map((p: any) => ({
              id: p.id,
              name: p.name,
              sessionCount: p.sessions.length,
            })),
          };
        } catch (e: any) {
          return { error: e.message };
        }
      });
      console.log("  Pre-info:", JSON.stringify(preInfo));

      const existingIds: string[] = preInfo && "existingIds" in preInfo ? preInfo.existingIds : [];

      // Click UI button to trigger the React mutation hook
      const newBtn = window.locator('[data-testid="new-session"]');
      await newBtn.waitFor({ state: "visible", timeout: 10_000 });
      console.log(`  Button disabled: ${await newBtn.isDisabled()}`);
      await newBtn.click();
      console.log("  Clicked '+'.");

      // Poll for 60s
      let cardAppeared = false;
      const startTime = Date.now();
      while (Date.now() - startTime < 60_000) {
        const info = await window.evaluate(async () => {
          try {
            const projects = await (window as any).api.db.projects.list();
            const active = projects.find((p: any) => p.path.includes("Copilot-Switch"));
            return {
              ids: (active?.sessions ?? []).map((s: any) => s.id),
              count: active?.sessions.length ?? 0,
              statuses: (active?.sessions ?? []).map((s: any) => ({ id: s.id, status: s.status })),
            };
          } catch (e: any) {
            return { error: e.message };
          }
        });
        if (info && "error" in info) {
          console.log(`  DB query error: ${info.error}`);
        } else if (info) {
          const newIds = info.ids.filter((id: string) => !existingIds.includes(id));
          if (newIds.length > 0) {
            console.log(`  New session in DB: ${newIds[0]} (total: ${info.count})`);
            console.log("  All statuses:", JSON.stringify(info.statuses));
            cardAppeared = true;

            // Also check if card rendered in DOM
            const domIds = await window
              .locator('[data-testid="session-card"][data-session-id]')
              .evaluateAll((els) =>
                els.map((el) => el.getAttribute("data-session-id")).filter(Boolean),
              );
            console.log("  DOM card IDs:", domIds);
            break;
          }
        }
        await sleep(1000);
      }

      if (cardAppeared) {
        const ssSession = "04-session-created.png";
        await window.screenshot({ path: screenshotPath(ssSession), fullPage: false });
        recordStep("创建Session", "passed", "新 session 已出现在 DB 中", ssSession);
      } else {
        const finalInfo = await window.evaluate(async () => {
          const projects = await (window as any).api.db.projects.list();
          const active = projects.find((p: any) => p.path.includes("Copilot-Switch"));
          return {
            ids: (active?.sessions ?? []).map((s: any) => s.id),
            count: active?.sessions.length ?? 0,
          };
        });
        recordStep("创建Session", "failed", `Session 未创建 (DB count: ${finalInfo.count})`, "");
      }
    } catch (e: any) {
      recordStep("创建Session", "failed", `异常: ${e.message}`, "");
    }

    // ---------- Step 7: Delete a session via inline X button ----------
    console.log("\n--- Step 7: Delete a session via inline X button ---");
    await sleep(3000);
    try {
      // Get the latest list of session cards
      const preDeleteIds = await window
        .locator('[data-testid="session-card"][data-session-id]')
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-session-id")).filter(Boolean));
      console.log(`  Pre-delete sessions (${preDeleteIds.length}):`, preDeleteIds);

      if (preDeleteIds.length === 0) {
        recordStep("删除Session", "skipped", "没有 session 可删除", "");
      } else {
        // Target the first session card
        const firstCard = window.locator('[data-testid="session-card"]').first();
        const sessionId = await firstCard.getAttribute("data-session-id");
        console.log(`  Targeting session: ${sessionId}`);

        await firstCard.hover();
        await sleep(300);

        // Click .session-close (X button)
        const closeBtn = firstCard.locator(".session-close");
        await closeBtn.waitFor({ state: "visible", timeout: 5_000 });
        await closeBtn.click();
        console.log("  Clicked .session-close (X button)");

        // Wait for ConfirmDeleteModal to appear
        await sleep(500);
        const confirmModal = window.locator('[data-testid="confirm-delete-modal"]');
        await confirmModal.waitFor({ state: "visible", timeout: 5_000 });
        console.log("  Confirm delete modal visible");

        // Capture the row's DB status before clicking confirm
        const beforeConfirm = await window.evaluate(async (sid) => {
          const projects = await (window as any).api.db.projects.list();
          const active = projects.find((p: any) => p.path.includes("Copilot-Switch"));
          const session = active?.sessions.find((s: any) => s.id === sid);
          return session ? { id: session.id, status: session.status } : { error: "not found" };
        }, sessionId);
        console.log("  Pre-confirm DB state:", JSON.stringify(beforeConfirm));

        // Click the confirm (delete) button
        const confirmBtn = window.locator('[data-testid="confirm-delete-ok"]');
        await confirmBtn.waitFor({ state: "visible", timeout: 3_000 });
        await confirmBtn.click();
        console.log("  Clicked confirm-delete-ok");

        // Check DB after the delete click to see if status changed to "deleting"
        await sleep(500);
        const afterClick = await window.evaluate(async (sid) => {
          const projects = await (window as any).api.db.projects.list();
          const active = projects.find((p: any) => p.path.includes("Copilot-Switch"));
          const session = active?.sessions.find((s: any) => s.id === sid);
          return session ? { id: session.id, status: session.status } : { deleted: true };
        }, sessionId);
        console.log("  After-confirm DB state:", JSON.stringify(afterClick));

        // Wait up to 90s for the session to disappear (delete can be slow due to worktree removal)
        const startTime = Date.now();
        let deleted = false;
        while (Date.now() - startTime < 90_000) {
          const dbInfo = await window.evaluate(async (sid) => {
            const projects = await (window as any).api.db.projects.list();
            const active = projects.find((p: any) => p.path.includes("Copilot-Switch"));
            const session = active?.sessions.find((s: any) => s.id === sid);
            return session ? { found: true, status: session.status } : { found: false };
          }, sessionId);

          if (!dbInfo.found) {
            console.log(`  Session ${sessionId} removed from DB.`);
            deleted = true;
            break;
          }
          // Print status every 5s
          if (
            Math.floor((Date.now() - startTime) / 5000) !==
            Math.floor((Date.now() - startTime - 1000) / 5000)
          ) {
            console.log(
              `  ... waiting (${Math.floor((Date.now() - startTime) / 1000)}s elapsed), DB status: ${dbInfo.status}`,
            );
          }
          await sleep(1000);
        }

        const ssDeleted = "05-session-deleted.png";
        await window.screenshot({ path: screenshotPath(ssDeleted), fullPage: false });

        if (deleted) {
          recordStep("删除Session", "passed", `Session ${sessionId} 已删除`, ssDeleted);
        } else {
          recordStep("删除Session", "failed", `Session 未消失 (ID: ${sessionId})`, ssDeleted);
        }
      }
    } catch (e: any) {
      recordStep("删除Session", "failed", `删除失败: ${e.message}`, "");
    }

    // ---------- Done ----------
    const allPassed = steps.every((s) => s.status === "passed");
    console.log("\n=== ALL STEPS ===");
    for (const s of steps) {
      console.log(`  [${s.status}] ${s.step}: ${s.detail}`);
    }
    console.log(`\nOverall: ${allPassed ? "ALL PASSED" : "SOME FAILED"}`);

    // Return structured result
    const result = {
      passed: allPassed,
      steps,
      errors,
      summary: allPassed
        ? "所有步骤通过: 冷启动 -> 打开项目对话框 -> 导航到 Copilot-Switch -> 项目加载 -> 创建Session -> 删除Session"
        : `部分步骤失败: ${errors.join("; ")}`,
    };

    console.log("\n=== STRUCTURED RESULT ===");
    console.log(JSON.stringify(result, null, 2));

    // Write result to file for external consumption
    const resultPath = join(ROOT, "e2e", "agent-e2e-result.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf-8");
    console.log(`Result written to: ${resultPath}`);

    return result;
  } catch (e: any) {
    console.error("FATAL ERROR:", e.message);
    if (window) {
      try {
        const ssError = "99-fatal-error.png";
        await window.screenshot({ path: screenshotPath(ssError) });
        console.log(`Error screenshot: ${screenshotPath(ssError)}`);
      } catch {}
    }
    const result = {
      passed: false,
      steps,
      errors: [...errors, `Fatal: ${e.message}`],
      summary: `Fatal error: ${e.message}`,
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    console.log("\n>>> Closing Electron app...");
    try {
      await app.close();
      console.log(">>> App closed.");
    } catch (e: any) {
      console.log(`>>> App close error: ${e.message}`);
    }

    // Wait a bit for cleanup
    await sleep(1000);

    // Cleanup data dir
    try {
      rmSync(dataDir, { recursive: true, force: true });
      console.log(`>>> Cleaned up: ${dataDir}`);
    } catch {
      console.log(`>>> Could not clean up: ${dataDir}`);
    }
  }
}

main().catch((e) => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
