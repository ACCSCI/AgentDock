// Real user simulation: bun start -> open Copilot-Switch -> create session -> delete session
// No fixtures. No IPC shortcuts. All clicks are real.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, type Page, _electron as electron } from "@playwright/test";

const ROOT = "F:\\ProgramPlayground\\JavaScript\\AgentDock\\.agentdock\\worktrees\\bed4c452-74d";
const SCREENSHOT_DIR = join(ROOT, "screenshots");
const TARGET_PROJECT = "F:\\ProgramPlayground\\JavaScript\\Copilot-Switch";

mkdirSync(SCREENSHOT_DIR, { recursive: true });

interface Step {
  step: string;
  status: "passed" | "failed" | "skipped";
  detail?: string;
  screenshot?: string;
}

const steps: Step[] = [];
const errors: string[] = [];

function logStep(
  step: string,
  status: "passed" | "failed" | "skipped",
  detail?: string,
  screenshot?: string,
) {
  steps.push({ step, status, detail, screenshot });
  console.log(`[${status.toUpperCase()}] ${step}${detail ? ` — ${detail}` : ""}`);
}

function logErr(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  errors.push(msg);
  console.error("ERROR:", msg);
}

async function main() {
  const mainEntry = join(ROOT, "out", "main", "main.js");
  console.log("Launching Electron with main:", mainEntry);

  let app: ElectronApplication | null = null;
  let window: Page | null = null;

  try {
    app = await electron.launch({
      args: [mainEntry],
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_OPTIONS: "--experimental-sqlite",
      },
      timeout: 60_000,
    });
    logStep("launch_electron", "passed", `pid=${app.process().pid}`);

    window = await app.firstWindow({ timeout: 60_000 });
    window.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        console.log(`[renderer ${msg.type()}]`, msg.text().slice(0, 200));
      }
    });
    window.on("pageerror", (err) => {
      console.log("[renderer pageerror]", err.message);
    });
    logStep("first_window", "passed", `url=${window.url()}`);

    // 1. Home page — wait for the "open project" button
    await window.waitForLoadState("domcontentloaded");
    await window.waitForSelector('[data-testid="home-open-project"]', { timeout: 30_000 });
    await window.screenshot({ path: join(SCREENSHOT_DIR, "01-home.png") });
    logStep("home_loaded", "passed", "看到了 home-open-project 按钮", "01-home.png");

    // 2. Click "打开项目" button
    await window.click('[data-testid="home-open-project"]');
    await window.waitForSelector('[data-testid="dir-modal"]', { timeout: 10_000 });
    await window.screenshot({ path: join(SCREENSHOT_DIR, "02-modal.png") });
    logStep("modal_opened", "passed", "DirBrowserModal 出现", "02-modal.png");

    // 3. Navigate to F:\ProgramPlayground\JavaScript\Copilot-Switch
    const segments = TARGET_PROJECT.split(/[\\/]/).filter((s) => s.length > 0);
    if (process.platform === "win32" && /^[A-Za-z]:$/.test(segments[0]!)) {
      segments[0] = `${segments[0]}\\`;
    }
    await window.waitForSelector('[data-testid="dir-entry"]', { timeout: 15_000 });

    // Drill into every segment except the last
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      const searchInput = window.locator('[data-testid="dir-search-input"]');
      await searchInput.fill(seg);
      await window.waitForTimeout(200);
      const entryHandle = await window.evaluateHandle((segmentName: string) => {
        const entries = Array.from(document.querySelectorAll('[data-testid="dir-entry"]'));
        return entries.find((el) => {
          const nameEl = el.querySelector(".dir-entry-name");
          return nameEl?.textContent === segmentName;
        }) as HTMLElement | undefined;
      }, seg);
      const element = entryHandle.asElement();
      if (!element) throw new Error(`No dir-entry found for segment "${seg}"`);
      await element.dblclick();
      await window.waitForSelector('[data-testid="dir-entry"]', { timeout: 15_000 });
      await window.waitForTimeout(200);
    }
    logStep("dir_nav", "passed", `通过搜索 + 双击依次进入 ${segments.join(" → ")}`);

    // Last segment: single-click to select
    const last = segments[segments.length - 1]!;
    const searchInput2 = window.locator('[data-testid="dir-search-input"]');
    await searchInput2.fill(last);
    await window.waitForTimeout(200);
    const lastHandle = await window.evaluateHandle((segmentName: string) => {
      const entries = Array.from(document.querySelectorAll('[data-testid="dir-entry"]'));
      return entries.find((el) => {
        const nameEl = el.querySelector(".dir-entry-name");
        return nameEl?.textContent === segmentName;
      }) as HTMLElement | undefined;
    }, last);
    const lastEl = lastHandle.asElement();
    if (!lastEl) throw new Error(`No dir-entry found for last segment "${last}"`);
    await lastEl.click();
    await window.waitForTimeout(300);
    logStep("dir_select", "passed", `选中 ${last}`);

    // Confirm
    const confirm = window.locator('[data-testid="dir-confirm"]');
    await confirm.waitFor({ state: "visible", timeout: 10_000 });
    await confirm.click({ force: true });
    logStep("dir_confirm", "passed", "点击 dir-confirm");

    // 4. Wait for workspace to load (h2 "Copilot-Switch")
    try {
      await window.waitForFunction(
        () => {
          const h2 = document.querySelector("h2");
          return h2?.textContent?.includes("Copilot-Switch") ?? false;
        },
        { timeout: 30_000 },
      );
      await window.screenshot({ path: join(SCREENSHOT_DIR, "03-workspace.png") });
      logStep("workspace_loaded", "passed", "h2 显示 Copilot-Switch", "03-workspace.png");
    } catch (e) {
      logErr(e);
      await window.screenshot({ path: join(SCREENSHOT_DIR, "03-workspace-FAILED.png") });
      logStep("workspace_loaded", "failed", "h2 没有出现 — dir-confirm 后路由没有切换");
      throw new Error("WORKFLOW_STUCK_AT_HOME: dir-confirm did not trigger route navigation");
    }

    // 5. Click "+" button (new-session) to create a session
    await window.waitForSelector('[data-testid="new-session"]', { timeout: 10_000 });
    await window.click('[data-testid="new-session"]');
    logStep("new_session_clicked", "passed", "点击 + 新建 session");

    // 6. Wait for session card to appear
    await window.waitForSelector('[data-testid="session-card"]', { timeout: 60_000 });
    await window.waitForTimeout(3000);
    await window.screenshot({ path: join(SCREENSHOT_DIR, "04-session.png") });
    logStep("session_created", "passed", "session 卡片出现", "04-session.png");

    // 7. Right-click the session card and find Delete option
    const sessionCard = await window.$('[data-testid="session-card"]');
    if (!sessionCard) throw new Error("session-card not found before right-click");

    const box = await sessionCard.boundingBox();
    if (!box) throw new Error("session-card has no boundingBox");

    await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await window.waitForSelector(".context-menu", { timeout: 5_000 });
    logStep("context_menu", "passed", "右键出现 context-menu");

    const deleteBtn = await window.$('.context-menu-item.context-menu-danger:has-text("删除")');
    if (!deleteBtn) throw new Error("Delete context menu item not found");
    await deleteBtn.click();
    logStep("delete_clicked", "passed", "点击删除");

    // 8. Confirm delete modal
    let confirmShown = false;
    try {
      await window.waitForSelector('[data-testid="confirm-delete-modal"]', { timeout: 5_000 });
      confirmShown = true;
    } catch {}
    if (confirmShown) {
      await window.click('[data-testid="confirm-delete-ok"]');
      logStep("delete_confirm", "passed", "点击确认删除");
    } else {
      logStep("delete_confirm", "skipped", "无确认弹窗（直接删除）");
    }

    // 9. Wait for session card to disappear
    await window.waitForFunction(
      () => document.querySelectorAll('[data-testid="session-card"]').length === 0,
      { timeout: 30_000 },
    );
    await window.screenshot({ path: join(SCREENSHOT_DIR, "05-deleted.png") });
    logStep("session_deleted", "passed", "session 卡片已消失", "05-deleted.png");
  } catch (e) {
    logErr(e);
    if (window) {
      try {
        await window.screenshot({ path: join(SCREENSHOT_DIR, "error-state.png") });
      } catch {}
    }
  } finally {
    if (app) {
      try {
        await app.close();
      } catch {}
    }
  }

  const passed = steps.every((s) => s.status === "passed") && errors.length === 0;
  let summary: string;
  if (passed) {
    summary = `All ${steps.length} steps passed. Real user flow succeeded.`;
  } else {
    const failedCount = steps.filter((s) => s.status === "failed").length;
    summary = `Failed: ${failedCount} step(s) failed, ${errors.length} error(s).`;
  }

  console.log("\n=== SUMMARY ===");
  console.log(summary);

  const outPath = join(SCREENSHOT_DIR, "result.json");
  writeFileSync(outPath, JSON.stringify({ passed, steps, errors, summary }, null, 2), "utf8");
  console.log("Wrote result to:", outPath);

  process.exit(passed ? 0 : 1);
}

main();
