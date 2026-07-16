/**
 * Extended E2E — session create + multiple terminals + close one + delete session.
 *
 * Mirrors a real user flow:
 *   1. Cold start → home page
 *   2. Click 打开项目 → modal
 *   3. Navigate dir browser to F:\ProgramPlayground\JavaScript\Copilot-Switch
 *   4. Project workspace loads
 *   5. Create session → wait for active
 *   6. Create 3 terminals
 *   7. Close 1 terminal
 *   8. Delete session
 *
 * Uses the e2e fixture (e2e/fixtures/electron-fixture.ts) which has the
 * working Playwright/Electron launch path for this Node v24 + Electron
 * 42 environment. The standalone .flue/tools/launch-electron.ts is
 * currently broken on Node v24 (Playwright inspector WebSocket
 * handshake hangs), so we don't use it here.
 */
import { expect, test } from "./fixtures/electron-fixture";

const PROJECT_PATH = "F:\\ProgramPlayground\\JavaScript\\Copilot-Switch";
const PROJECT_NAME = "Copilot-Switch";

async function waitForDirEntries(window: import("@playwright/test").Page, timeoutMs = 15_000) {
  const entries = window.locator('[data-testid="dir-entry"]');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await entries.count()) > 0) return;
    await window.waitForTimeout(100);
  }
  throw new Error("dir-entry never rendered");
}

function entryByName(window: import("@playwright/test").Page, name: string) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return window
    .locator('[data-testid="dir-entry"]')
    .filter({ has: window.locator(".dir-entry-name", { hasText: new RegExp(`^${esc}$`) }) })
    .first();
}

test("extended user flow: open project → create session → 3 terminals → close 1 → delete session", async ({
  window,
}) => {
  // Steps 1-4: open the project.
  await window
    .locator('[data-testid="home-open-project"]')
    .waitFor({ state: "visible", timeout: 15_000 });
  await window.locator('[data-testid="home-open-project"]').click();
  await window.locator('[data-testid="dir-modal"]').waitFor({ state: "visible", timeout: 10_000 });

  const segments = PROJECT_PATH.split(/[\\/]/).filter((s) => s.length > 0);
  segments[0] = `${segments[0]}\\`;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    await window.locator('[data-testid="dir-search-input"]').fill(seg);
    await window.waitForTimeout(300);
    await entryByName(window, seg).dblclick();
    await waitForDirEntries(window);
  }
  const last = segments[segments.length - 1]!;
  await window.locator('[data-testid="dir-search-input"]').fill(last);
  await window.waitForTimeout(300);
  await entryByName(window, last).click();
  await window.locator('[data-testid="dir-confirm"]').click();
  await window.locator('[data-testid="dir-modal"]').waitFor({ state: "hidden", timeout: 10_000 });

  // Project workspace loads.
  await window.waitForTimeout(3000);
  await window
    .locator("h2")
    .filter({ hasText: PROJECT_NAME })
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });

  // Step 5: Create session.
  await window
    .locator('[data-testid="new-session"]')
    .waitFor({ state: "visible", timeout: 10_000 });
  const sessionBefore = await window.locator('[data-testid="session-card"]').count();
  await window.locator('[data-testid="new-session"]').click();
  await window.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="session-card"]').length > n,
    sessionBefore,
    { timeout: 60_000 },
  );
  const sessionId =
    (await window.locator('[data-testid="session-card"]').last().getAttribute("data-session-id")) ??
    "";
  expect(sessionId, "new session missing data-session-id").not.toBe("");

  // Wait for the session to leave the "creating" state. Use the inner
  // .session-card class (the creating/deleting class lives there, the
  // testid is on the wrapper).
  const createDeadline = Date.now() + 120_000;
  let leftCreating = false;
  while (Date.now() < createDeadline) {
    const state = await window.evaluate((sid) => {
      const wrapper = document.querySelector(
        `[data-testid="session-card"][data-session-id="${sid}"]`,
      );
      if (!wrapper) return "gone";
      const inner = wrapper.querySelector(".session-card") ?? wrapper;
      if (inner.classList.contains("session-card-creating")) return "creating";
      if (inner.classList.contains("session-card-deleting")) return "deleting";
      return "active";
    }, sessionId);
    if (state === "active" || state === "gone") {
      leftCreating = true;
      break;
    }
    await window.waitForTimeout(5_000);
  }
  expect(leftCreating, `session ${sessionId} stuck in creating after 120s`).toBe(true);

  // Click the session card to enter the workspace view.
  await window.locator(`[data-testid="session-card"][data-session-id="${sessionId}"]`).click();
  await window
    .locator('[data-testid="terminal-panel"]')
    .waitFor({ state: "visible", timeout: 10_000 });

  // Step 6: Create 3 terminals. Note: TerminalManager does NOT auto-create
  // a terminal when a session becomes active — the user has to click "+".
  const newTerminalBtn = window.locator('[data-testid="new-terminal"]');
  await newTerminalBtn.waitFor({ state: "visible", timeout: 5_000 });
  const initialTabs = await window.locator('[data-testid="terminal-tab"]').count();

  for (let i = 0; i < 3; i++) {
    await newTerminalBtn.click();
    // Wait for the new tab to appear. Each create is a real IPC call so
    // it can take a moment.
    await window.waitForFunction(
      (target) => document.querySelectorAll('[data-testid="terminal-tab"]').length >= target,
      initialTabs + i + 1,
      { timeout: 15_000 },
    );
  }
  const finalTabCount = await window.locator('[data-testid="terminal-tab"]').count();
  expect(finalTabCount, "expected 3+ terminals after create").toBeGreaterThanOrEqual(
    initialTabs + 3,
  );

  // Step 7: Close 1 terminal. Click the × button on the second tab.
  const firstCloseBtn = window
    .locator('[data-testid="terminal-tab"]')
    .nth(1)
    .locator(".terminal-tab-close");
  await firstCloseBtn.click();
  await window.waitForFunction(
    (target) => document.querySelectorAll('[data-testid="terminal-tab"]').length === target,
    finalTabCount - 1,
    { timeout: 10_000 },
  );

  // Step 8: Delete session. Right-click the session card → 删除.
  // Use the session sidebar's right-click context menu.
  const sessionCard = window.locator(
    `[data-testid="session-card"][data-session-id="${sessionId}"]`,
  );
  // The session card is currently selected and we're in the workspace.
  // Navigate back to the home/tab view first by clicking somewhere.
  // Actually we can delete from the workspace too — use the close button
  // on the active session card. The active session-card has an × button.
  // First scroll back to the sidebar.
  const closeSessionBtn = sessionCard.locator(".session-close");
  if ((await closeSessionBtn.count()) > 0) {
    await closeSessionBtn.click();
  } else {
    // Fallback: right-click context menu.
    await sessionCard.click({ button: "right" });
    await window.waitForTimeout(300);
    await window
      .locator(".context-menu-item")
      .filter({ hasText: /删除|Delete/i })
      .first()
      .click();
  }
  // Confirm-delete modal.
  const confirm = window.locator('[data-testid="confirm-delete-ok"]');
  await confirm.waitFor({ state: "visible", timeout: 5_000 });
  await confirm.click();
  await window.waitForFunction(
    (sid) => !document.querySelector(`[data-testid="session-card"][data-session-id="${sid}"]`),
    sessionId,
    { timeout: 30_000 },
  );

  // Cleanup: any leftover worktree entries from this test run.
  // (The fixture's `dataDir` is auto-cleaned; only the global project DB
  //  and the per-project's .agentdock/worktrees/ might leak. The test
  //  removes the session we created above, which removes its worktree.)
});
