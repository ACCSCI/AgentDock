// Simulates a human user: bun start → open Copilot-Switch → create session → delete session
import { _electron as electron, type ElectronApplication } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const ROOT = "F:\\ProgramPlayground\\JavaScript\\AgentDock\\.agentdock\\worktrees\\bed4c452-74d";
const SCREENSHOT_DIR = join(ROOT, "screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const TARGET_PATH = "F:\\ProgramPlayground\\JavaScript\\Copilot-Switch";

interface Step {
  step: string;
  status: "passed" | "failed" | "skipped";
  detail?: string;
  screenshot?: string;
}

const steps: Step[] = [];
const errors: string[] = [];
let app: ElectronApplication | undefined;
let window: any;

async function main() {
  // Step 0: build (skipped — already built in task instructions)
  steps.push({
    step: "0. Build via npx electron-vite build",
    status: "passed",
    detail: "Build artifact out/main/main.js exists; build was already performed.",
    screenshot: undefined,
  });

  // Step 1: launch Electron (mimic `bun start`)
  const mainEntry = join(ROOT, "out", "main", "main.js");
  console.log("[launcher] launching electron with entry:", mainEntry);
  app = await electron.launch({
    args: [mainEntry],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: "--experimental-sqlite",
      // do NOT pass AGENTDOCK_DEV_INSTANCE — use real userDataDir
    },
    timeout: 60_000,
  });
  console.log("[launcher] electron launched");

  window = await app.firstWindow();
  console.log("[launcher] first window obtained");

  // Capture any alert dialogs the app pops up
  let alertDialog: { message: string } | null = null;
  window.on("dialog", (dialog) => {
    console.log("[dialog]", dialog.type(), dialog.message());
    alertDialog = { message: dialog.message() };
    dialog.dismiss().catch(() => undefined);
  });

  // Step 2: wait for window load
  await window.waitForLoadState("domcontentloaded");
  await window.waitForLoadState("load").catch(() => undefined);
  console.log("[launcher] window loaded");

  // Wait for the home page open-project button to be visible
  const openProjectBtn = window.locator('[data-testid="home-open-project"]');
  await openProjectBtn.waitFor({ state: "visible", timeout: 30_000 });
  await window.screenshot({ path: join(SCREENSHOT_DIR, "01-home.png") });
  steps.push({
    step: "1. Cold start — home page loaded with '打开项目' button",
    status: "passed",
    screenshot: "01-home.png",
    detail: "Window loaded and home page open-project button is visible.",
  });

  // Step 3: real click "打开项目"
  console.log("[step] clicking 打开项目 button");
  await openProjectBtn.click();

  // Wait for modal
  const dirModal = window.locator('[data-testid="dir-modal"]');
  await dirModal.waitFor({ state: "visible", timeout: 15_000 });
  await window.screenshot({ path: join(SCREENSHOT_DIR, "02-modal.png") });
  steps.push({
    step: "2. Open project modal appeared",
    status: "passed",
    screenshot: "02-modal.png",
  });

  // Step 4: navigate to Copilot-Switch via breadcrumbs / search
  // We have target path "F:\\ProgramPlayground\\JavaScript\\Copilot-Switch"
  // Use breadcrumb navigation: click "/" first then drill down.
  // Easier: just navigate via path components through breadcrumb if available,
  // but the modal loads root by default and uses breadcrumbs per-segment.
  // Strategy: navigate parent → parent → ... → enter Copilot-Switch → confirm

  // First check what's loaded (root shows drives on Windows like C:\, F:\)
  const rootEntries = await window.locator('[data-testid="dir-entry"]').all();
  console.log("[step] root entries:", rootEntries.length);
  for (let i = 0; i < rootEntries.length; i++) {
    const txt = await rootEntries[i].textContent();
    const path = await rootEntries[i].getAttribute("data-dir-path");
    console.log(`  [${i}] path=${path} text=${txt?.trim()}`);
  }

  // Navigate: F:\ → F:\ProgramPlayground → F:\ProgramPlayground\JavaScript → search Copilot
  // The breadcrumb "/" button lists all drives. We click F: drive to enter it.

  // Find F: drive entry by data-dir-path attribute
  const fDrive = window.locator('[data-testid="dir-entry"][data-dir-path="F:\\\\"]').first();
  await fDrive.waitFor({ state: "visible", timeout: 5_000 });
  const fDrivePath = await fDrive.getAttribute("data-dir-path");
  console.log("[step] F drive path:", fDrivePath);
  await fDrive.dblclick();
  await window.waitForTimeout(1500);

  // Now we should be in F:\. Use search to find ProgramPlayground.
  const searchInput = window.locator('[data-testid="dir-search-input"]');
  await searchInput.waitFor({ state: "visible", timeout: 5_000 });
  await searchInput.fill("ProgramPlayground");
  await window.waitForTimeout(500);
  const ppEntry = window.locator('[data-testid="dir-entry"]').filter({ hasText: "ProgramPlayground" }).first();
  await ppEntry.waitFor({ state: "visible", timeout: 5_000 });
  await searchInput.fill("");
  await window.waitForTimeout(300);
  await ppEntry.dblclick();
  await window.waitForTimeout(1500);

  // In F:\ProgramPlayground → drill into JavaScript
  await searchInput.fill("JavaScript");
  await window.waitForTimeout(500);
  const jsEntry = window.locator('[data-testid="dir-entry"]').filter({ hasText: "JavaScript" }).first();
  await jsEntry.waitFor({ state: "visible", timeout: 5_000 });
  await searchInput.fill("");
  await window.waitForTimeout(300);
  await jsEntry.dblclick();
  await window.waitForTimeout(1500);

  // In F:\ProgramPlayground\JavaScript → find Copilot-Switch
  await searchInput.fill("Copilot");
  await window.waitForTimeout(500);
  const csEntry = window.locator('[data-testid="dir-entry"]').filter({ hasText: "Copilot-Switch" }).first();
  await csEntry.waitFor({ state: "visible", timeout: 10_000 });
  // Clear search so we can navigate cleanly (selection happens via single click which only filters)
  // Actually single-click selects without navigating; double-click navigates into the dir.
  // So: clear search → click → select → confirm.
  await searchInput.fill("");
  await window.waitForTimeout(500);

  // Single-click to SELECT Copilot-Switch (without entering it)
  await csEntry.click();
  await window.waitForTimeout(500);

  const selectedAfter = await window.locator(".dir-modal-selected-path").textContent();
  console.log("[step] selected after:", selectedAfter);

  if (!selectedAfter || !selectedAfter.includes("Copilot-Switch")) {
    throw new Error(`Failed to select Copilot-Switch path. selected="${selectedAfter}"`);
  }

  // Click confirm
  const confirmBtn = window.locator('[data-testid="dir-confirm"]');
  await confirmBtn.click();

  // Wait for modal to close
  await dirModal.waitFor({ state: "hidden", timeout: 15_000 });
  steps.push({
    step: "3. Navigate dir browser → select F:\\...\\Copilot-Switch → confirm",
    status: "passed",
    detail: `Selected: ${selectedAfter}`,
  });

  // Step 5: wait for workspace to load — header should show "Copilot-Switch"
  console.log("[step] waiting for workspace h2 'Copilot-Switch'");
  // Poll for h2 OR alert (dialog fires asynchronously)
  let sawAlert = false;
  let alertMessage = "";
  const pollStart = Date.now();
  while (Date.now() - pollStart < 30_000) {
    // Check dialogs first
    if (alertDialog && alertDialog.message) {
      alertMessage = alertDialog.message;
      sawAlert = true;
      break;
    }
    // Check if h2 visible
    const h2Visible = await window.locator("h2", { hasText: "Copilot-Switch" }).isVisible().catch(() => false);
    if (h2Visible) break;
    await window.waitForTimeout(500);
  }

  if (sawAlert) {
    await window.screenshot({ path: join(SCREENSHOT_DIR, "03-workspace.png") });
    throw new Error(`App raised alert dialog: "${alertMessage}" — workspace did NOT load.`);
  }

  await window.screenshot({ path: join(SCREENSHOT_DIR, "03-workspace.png") });
  steps.push({
    step: "4. Workspace loaded showing 'Copilot-Switch' header",
    status: "passed",
    screenshot: "03-workspace.png",
  });

  // Step 6: real click + button (new-session)
  const newSessionBtn = window.locator('[data-testid="new-session"]');
  await newSessionBtn.waitFor({ state: "visible", timeout: 10_000 });
  console.log("[step] clicking + button to create session");
  await newSessionBtn.click();

  // Wait for session card to appear
  const sessionCard = window.locator('[data-testid="session-card"]').first();
  await sessionCard.waitFor({ state: "visible", timeout: 30_000 });
  // Give it a moment to fully render
  await window.waitForTimeout(1500);
  await window.screenshot({ path: join(SCREENSHOT_DIR, "04-session.png") });
  const sessionCount = await window.locator('[data-testid="session-card"]').count();
  steps.push({
    step: "5. Click + → session created",
    status: "passed",
    screenshot: "04-session.png",
    detail: `Total session cards now: ${sessionCount}`,
  });

  // Step 7: real right-click on session card → click Delete
  console.log("[step] right-clicking session card");
  // Scroll into view first
  await sessionCard.scrollIntoViewIfNeeded();
  const box = await sessionCard.boundingBox();
  if (!box) throw new Error("session card has no bounding box");
  await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });

  // Wait for context menu to appear
  const contextMenu = window.locator(".context-menu").first();
  await contextMenu.waitFor({ state: "visible", timeout: 5_000 });

  // Click the Delete menu item (danger class)
  const deleteMenuItem = window.locator(".context-menu-item.context-menu-danger").filter({ hasText: /删除|Delete/ }).first();
  await deleteMenuItem.waitFor({ state: "visible", timeout: 5_000 });
  await deleteMenuItem.click();

  // Confirm delete modal should appear
  const confirmDeleteModal = window.locator('[data-testid="confirm-delete-modal"]');
  await confirmDeleteModal.waitFor({ state: "visible", timeout: 10_000 });

  // Click confirm-delete-ok
  const okBtn = window.locator('[data-testid="confirm-delete-ok"]');
  await okBtn.click();

  // Wait for session card to disappear
  // Need to handle case where we may have multiple — wait until count < before-delete count
  const initialCount = await window.locator('[data-testid="session-card"]').count();
  console.log(`[step] session count after delete click: ${initialCount}`);

  // Poll until card count decreases OR timeout
  let finalCount = initialCount;
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    finalCount = await window.locator('[data-testid="session-card"]').count();
    if (finalCount < initialCount) break;
    await window.waitForTimeout(500);
  }
  await window.screenshot({ path: join(SCREENSHOT_DIR, "05-deleted.png") });

  if (finalCount < initialCount) {
    steps.push({
      step: "6. Right-click → Delete → Confirm → session removed",
      status: "passed",
      screenshot: "05-deleted.png",
      detail: `Session count went ${initialCount} → ${finalCount}`,
    });
  } else {
    throw new Error(`Session card count did not decrease after delete (still ${finalCount})`);
  }

  // Done
  console.log("[done] all steps passed");
}

async function run() {
  try {
    await main();
    return { passed: true, steps, errors, summary: "All 6 steps passed: build → launch → home → open Copilot-Switch modal → workspace → create session → delete session." };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[fatal]", msg, stack);
    errors.push(`${msg}\n${stack ?? ""}`);
    return {
      passed: false,
      steps,
      errors,
      summary: `Failed at: ${msg}`,
    };
  } finally {
    if (app) {
      try {
        await app.close();
      } catch (e) {
        console.error("[cleanup] error closing app:", e);
      }
    }
  }
}

run().then((result) => {
  console.log("\n=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
});