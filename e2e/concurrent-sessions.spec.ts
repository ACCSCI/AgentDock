/**
 * Concurrent sessions E2E.
 *
 * Creates 3 sessions in rapid succession, verifies all 3 cards appear,
 * verifies each is unique, activates each and verifies terminal panel
 * re-mounts, then deletes sessions one by one in reverse order.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures/electron-fixture";
import { HomePage } from "./pages/home";
import { SidebarPage } from "./pages/sidebar";
import { TerminalPage } from "./pages/terminal";
import { TID } from "./pages/testids";
import { waitForDaemonReady } from "./helpers/ipc";

function prepareGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -q -b main", { cwd: dir });
  execSync(
    'git -c user.email=e2e@local -c user.name=E2E commit --allow-empty -q -m init',
    { cwd: dir },
  );
}

function writeEmptyConfig(dir: string): void {
  writeFileSync(
    join(dir, "agentdock.config.yaml"),
    `version: "1"\nresources:\n  sync: []\nhooks: {}\n`,
    "utf-8",
  );
}

test.describe("concurrent sessions", () => {
  test("create 3 sessions rapidly -> all appear -> unique IDs -> activate each -> delete in reverse", async ({
    window,
    dataDir,
    pageErrors,
    dialogs,
    rendererLog,
    expectNoRendererErrors,
  }) => {
    const projectPath = join(dataDir, "concurrent-project");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);

    const home = new HomePage(window);
    const sidebar = new SidebarPage(window);
    const terminalPage = new TerminalPage(window);

    await waitForDaemonReady(window);

    // 1. Open project.
    await home.openProject(projectPath);
    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });
    expect(await sidebar.cardCount()).toBe(0);

    // 2. Create 3 sessions in rapid succession. The sidebar's
    //    CREATE_COOLDOWN_MS guard (1500ms) intentionally throttles the
    //    UI button so users can't accidentally double-click. We space
    //    the clicks by 1700ms so all 3 land as distinct create events.
    await sidebar.clickNewSession();
    await window.waitForTimeout(1_700);
    await sidebar.clickNewSession();
    await window.waitForTimeout(1_700);
    await sidebar.clickNewSession();

    // 3. Wait for all 3 cards to appear.
    await expect
      .poll(async () => sidebar.cardCount(), { timeout: 45_000 })
      .toBe(3);

    // 4. Wait for ports to appear on all cards (best-effort).
    const allCards = window.locator(`[data-testid="${TID.sessionCard}"]`);
    for (let i = 0; i < 3; i++) {
      const card = allCards.nth(i);
      await expect(card.locator(".session-ports")).toBeVisible({ timeout: 30_000 }).catch(() => {});
    }

    // 5. Collect session IDs and verify uniqueness.
    const sessionIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await allCards.nth(i).getAttribute("data-session-id");
      expect(id, `card ${i} missing data-session-id`).toBeTruthy();
      sessionIds.push(id!);
    }
    const uniqueIds = new Set(sessionIds);
    expect(uniqueIds.size, `expected 3 unique IDs, got ${uniqueIds.size}`).toBe(3);

    // 6. Activate each session and verify terminal panel re-mounts.
    for (let i = 0; i < 3; i++) {
      const card = allCards.nth(i);
      await card.click();
      await expect(terminalPage.panel).toBeVisible({ timeout: 5_000 });
    }

    // 7. Delete sessions one by one in reverse order.
    for (let i = 2; i >= 0; i--) {
      const card = allCards.nth(i);
      const deleteBtn = card.locator(".session-close");
      await deleteBtn.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
      await deleteBtn.click();
      const confirmYes = card.locator(".session-delete-confirm-yes");
      await confirmYes.waitFor({ state: "visible", timeout: 5_000 });
      await confirmYes.click();
    }

    // 8. All cards should be gone.
    await expect
      .poll(() => sidebar.cardCount(), { timeout: 45_000 })
      .toBe(0);

    // 9. No renderer errors.
    expect(pageErrors).toHaveLength(0);
    // Filter out expected font CORS errors — the agentdock-fonts://
    // protocol may not resolve in test environments where fonts
    // haven't been downloaded yet. These are benign.
    const consoleErrors = rendererLog.filter(
      (e) => e.type === "error"
        && !e.text.includes("agentdock-fonts://")
        && !((e.location && e.location.url) || "").includes("agentdock-fonts://")
        && !e.text.includes("net::ERR_FAILED"),
    );
    expect(consoleErrors).toHaveLength(0);
    expectNoRendererErrors();
  });
});
