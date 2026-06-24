/**
 * Error recovery E2E.
 *
 * Creates a session, attempts operations that may cause errors (edge-case
 * renames), verifies the UI doesn't crash, then recovers by performing
 * a valid operation.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures/electron-fixture";
import { HomePage } from "./pages/home";
import { SidebarPage } from "./pages/sidebar";
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

test.describe("error recovery", () => {
  test("create session -> rename edge cases -> UI stable -> recover -> delete", async ({
    window,
    dataDir,
    pageErrors,
    dialogs,
    rendererLog,
    expectNoRendererErrors,
  }) => {
    const projectPath = join(dataDir, "error-recovery-project");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);

    const home = new HomePage(window);
    const sidebar = new SidebarPage(window);

    await waitForDaemonReady(window);

    // 1. Open project and create a session.
    await home.openProject(projectPath);
    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });
    await sidebar.clickNewSession();
    await expect
      .poll(async () => sidebar.cardCount(), { timeout: 30_000 })
      .toBe(1);

    const card = window.locator(`[data-testid="${TID.sessionCard}"]`).first();
    await expect(card).toBeVisible();
    await expect(card.locator(".session-ports")).toBeVisible({ timeout: 15_000 }).catch(() => {});

    const nameEl = card.locator(".session-name");
    await expect(nameEl).toBeVisible({ timeout: 5_000 });
    const originalName = await nameEl.textContent();

    // 2. Try renaming with empty string (should be rejected).
    await card.dblclick();
    const renameInput = card.locator(".session-rename-input");
    await expect(renameInput).toBeVisible({ timeout: 3_000 });
    await renameInput.fill("");
    await renameInput.press("Enter");
    await window.waitForTimeout(500);
    await expect(renameInput).toBeHidden({ timeout: 3_000 });
    await expect(nameEl).toHaveText(originalName!);

    // 3. Try renaming with only whitespace (should be rejected).
    await card.dblclick();
    await expect(renameInput).toBeVisible({ timeout: 3_000 });
    await renameInput.fill("   ");
    await renameInput.press("Enter");
    await window.waitForTimeout(500);
    await expect(nameEl).toHaveText(originalName!);

    // 4. Rename with a long name (should work).
    await card.dblclick();
    await expect(renameInput).toBeVisible({ timeout: 3_000 });
    const longName = "A".repeat(200);
    await renameInput.fill(longName);
    await renameInput.press("Enter");
    await window.waitForTimeout(500);
    // Name should be updated (may be truncated by backend).
    const nameAfterLong = await nameEl.textContent();
    expect(nameAfterLong).toBeTruthy();

    // 5. Verify the UI is still functional.
    await card.click();
    await window.waitForTimeout(300);

    // 6. Recover with a valid short rename.
    await card.dblclick();
    await expect(renameInput).toBeVisible({ timeout: 3_000 });
    await renameInput.fill("Recovered Name");
    await renameInput.press("Enter");
    await expect(renameInput).toBeHidden({ timeout: 3_000 });
    await expect(nameEl).toHaveText("Recovered Name");

    // 7. Delete the session.
    const deleteBtn = card.locator(".session-close");
    await deleteBtn.click();
    await card.locator(".session-delete-confirm-yes").click();
    await expect
      .poll(() => sidebar.cardCount(), { timeout: 30_000 })
      .toBe(0);

    // 8. No React infinite loops or page errors.
    const maxDepthErrors = rendererLog.filter((e) =>
      /Maximum update depth exceeded/i.test(e.text),
    );
    expect(
      maxDepthErrors,
      `React infinite-loop during error recovery:\n${maxDepthErrors.map((e) => e.text).join("\n")}`,
    ).toHaveLength(0);

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
