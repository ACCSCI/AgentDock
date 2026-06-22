/**
 * Port allocation under load E2E.
 *
 * Creates 5+ sessions sequentially, verifies each session gets unique
 * FRONTEND_PORT values, verifies all ports are > 1024, verifies DB
 * records all distinct ports, then cleans up all sessions.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures/electron-fixture";
import { HomePage } from "./pages/home";
import { SidebarPage } from "./pages/sidebar";
import { TID } from "./pages/testids";
import { dumpDb } from "./helpers/dump";

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

const SESSION_COUNT = 5;

test.describe("port allocation stress", () => {
  test(`create ${SESSION_COUNT} sessions -> verify unique ports -> all > 1024 -> DB records distinct -> cleanup`, async ({
    window,
    dataDir,
    pageErrors,
    dialogs,
    rendererLog,
    expectNoRendererErrors,
  }) => {
    const projectPath = join(dataDir, "port-stress-project");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);

    const home = new HomePage(window);
    const sidebar = new SidebarPage(window);

    // 1. Open project.
    await home.openProject(projectPath);
    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });
    expect(await sidebar.cardCount()).toBe(0);

    // 2. Create SESSION_COUNT sessions sequentially.
    const sessionIds: string[] = [];
    for (let i = 0; i < SESSION_COUNT; i++) {
      await sidebar.clickNewSession();
      // Wait until card count increments.
      await expect
        .poll(async () => sidebar.cardCount(), { timeout: 30_000 })
        .toBe(i + 1);

      // Wait for the latest card's ports to appear.
      const latestCard = window.locator(`[data-testid="${TID.sessionCard}"]`).nth(i);
      await expect(latestCard.locator(".session-ports")).toBeVisible({ timeout: 30_000 });

      const id = await latestCard.getAttribute("data-session-id");
      expect(id, `card ${i} missing data-session-id`).toBeTruthy();
      sessionIds.push(id!);
    }

    // 3. Verify all session IDs are unique.
    const uniqueIds = new Set(sessionIds);
    expect(uniqueIds.size).toBe(SESSION_COUNT);

    // 4. DB verification: all ports are distinct and > 1024.
    const dump = dumpDb(dataDir);
    const frontendPorts: number[] = [];
    for (const sid of sessionIds) {
      const row = dump.sessions.find((s) => s.id === sid);
      expect(row, `session ${sid} not found in DB`).toBeTruthy();
      expect(row!.ports, `session ${sid} has no ports`).toBeTruthy();
      const ports = JSON.parse(row!.ports!) as Record<string, number>;
      expect(ports.FRONTEND_PORT).toBeGreaterThan(1024);
      frontendPorts.push(ports.FRONTEND_PORT);
    }

    // All frontend ports must be unique.
    const uniquePorts = new Set(frontendPorts);
    expect(uniquePorts.size).toBe(
      SESSION_COUNT,
      `expected ${SESSION_COUNT} unique ports, got ${uniquePorts.size}: [${frontendPorts.join(", ")}]`,
    );

    // 5. Delete all sessions one by one.
    for (let i = SESSION_COUNT - 1; i >= 0; i--) {
      const card = window.locator(`[data-testid="${TID.sessionCard}"]`).nth(i);
      const deleteBtn = card.locator(".session-close");
      await deleteBtn.waitFor({ state: "visible", timeout: 5_000 });
      await deleteBtn.click();
      const confirmYes = card.locator(".session-delete-confirm-yes");
      await confirmYes.waitFor({ state: "visible", timeout: 5_000 });
      await confirmYes.click();
    }

    // 6. All cards should be gone.
    await expect
      .poll(() => sidebar.cardCount(), { timeout: 60_000 })
      .toBe(0);

    // 7. DB should have no sessions.
    const finalDump = dumpDb(dataDir);
    expect(finalDump.sessions.length).toBe(0);

    // 8. No renderer errors.
    expect(pageErrors).toHaveLength(0);
    const consoleErrors = rendererLog.filter((e) => e.type === "error");
    expect(consoleErrors).toHaveLength(0);
    expectNoRendererErrors();
  });
});
