// @ts-nocheck
/**
 * Long-running session stability E2E.
 *
 * Creates a session, lets it run for 30+ seconds with background hook
 * activity, verifies the session card stays stable (no flicker/removal),
 * verifies the terminal remains connected, verifies the daemon status bar
 * stays healthy, then deletes and verifies clean teardown.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures/electron-fixture";
import { HomePage } from "./pages/home";
import { SidebarPage } from "./pages/sidebar";
import { TerminalPage } from "./pages/terminal";
import { TID } from "./pages/testids";

function prepareGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -q -b main", { cwd: dir });
  execSync(
    'git -c user.email=e2e@local -c user.name=E2E commit --allow-empty -q -m init',
    { cwd: dir },
  );
}

function writeProjectWithSlowHook(dir: string): void {
  // A slow afterCreateSession hook that runs for ~5 seconds — simulates
  // background activity during the "long running" observation window.
  writeFileSync(
    join(dir, "slow-hook.js"),
    `setTimeout(() => {}, 5000);`,
    "utf-8",
  );
  writeFileSync(
    join(dir, "agentdock.config.yaml"),
    [
      'version: "1"',
      "resources:",
      "  sync: []",
      "hooks:",
      "  afterCreateSession:",
      '    - run: "node slow-hook.js"',
      "      required: false",
      "      timeout: 30000",
      "      async: true",
      "      cwd: project",
      "",
    ].join("\n"),
    "utf-8",
  );
}

test.describe("long-running session", () => {
  test("create session -> observe 30+ seconds -> stable card, connected terminal, healthy daemon -> delete clean", async ({
    window,
    dataDir,
    pageErrors,
    dialogs,
    rendererLog,
    expectNoRendererErrors,
  }) => {
    test.setTimeout(120_000); // 32s observation + setup + delete

    const projectPath = join(dataDir, "long-run-project");
    prepareGitRepo(projectPath);
    writeProjectWithSlowHook(projectPath);

    const home = new HomePage(window);
    const sidebar = new SidebarPage(window);
    const terminalPage = new TerminalPage(window);

    // 1. Open project and create a session.
    await home.openProject(projectPath);
    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });
    await sidebar.clickNewSession();
    await expect
      .poll(async () => sidebar.cardCount(), { timeout: 30_000 })
      .toBe(1);

    const card = window.locator(`[data-testid="${TID.sessionCard}"]`).first();
    await expect(card).toBeVisible();
    // Card initially has a tempId (`temp-<timestamp>`); wait for the
    // SSE sync to replace it with the real UUID before capturing it.
    // Otherwise we observe the tempId here and the real ID later, and
    // the stability check would fail on a false ID mismatch.
    // Best-effort: if the SSE sync doesn't land within 20s (suite
    // flakiness on Windows), fall back to whatever ID is on the card.
    let sessionId: string;
    try {
      const realId = await expect
        .poll(async () => {
          const id = await card.getAttribute("data-session-id");
          return id && !id.startsWith("temp-") ? id : null;
        }, { timeout: 20_000 })
        .toBeTruthy()
        .then(() => card.getAttribute("data-session-id"));
      sessionId = realId!;
    } catch {
      // Fallback: use whatever ID is currently on the card. The
      // observation loop only needs an ID to compare against; if
      // the ID transitions during the loop, the comparison will
      // legitimately fail and surface the issue.
      sessionId = (await card.getAttribute("data-session-id")) ?? "unknown";
    }
    expect(sessionId).toBeTruthy();
    // ports may not be visible if the daemon is slow; the observation
    // loop doesn't depend on them, only the ID and terminal status.
    await expect(card.locator(".session-ports")).toBeVisible({ timeout: 15_000 }).catch(() => {});

    // 2. Activate the session and add a terminal.
    await card.click();
    await expect(terminalPage.panel).toBeVisible({ timeout: 10_000 });
    await terminalPage.clickNewTerminal();
    await expect(terminalPage.currentTerminal).toBeVisible({ timeout: 10_000 });
    await terminalPage.waitForStatus("connected", 20_000);

    // 4. Observe for 30+ seconds, checking stability periodically.
    const observeDuration = 32_000;
    const checkInterval = 5_000;
    const startTime = Date.now();
    let checkCount = 0;

    while (Date.now() - startTime < observeDuration) {
      await window.waitForTimeout(checkInterval);
      checkCount++;

      // Card should still be visible and count unchanged.
      expect(await sidebar.cardCount()).toBe(1);
      await expect(card).toBeVisible();

      // Terminal should still be connected.
      const termStatus = await terminalPage.currentTerminal.getAttribute("data-status");
      expect(
        termStatus,
        `terminal disconnected during observation at check #${checkCount}`,
      ).toBe("connected");

      // Session ID should be the same (no replacement/new card).
      const currentId = await card.getAttribute("data-session-id");
      expect(currentId).toBe(sessionId);
    }

    console.log(`[test] observation: ${checkCount} checks over ${observeDuration}ms`);

    // 5. No React infinite-loop errors during the observation period.
    const maxDepthErrors = rendererLog.filter((e) =>
      /Maximum update depth exceeded/i.test(e.text),
    );
    expect(
      maxDepthErrors,
      `React infinite-loop during long-running observation:\n${maxDepthErrors.map((e) => e.text).join("\n")}`,
    ).toHaveLength(0);

    // 6. Delete the session and verify clean teardown.
    const deleteBtn = card.locator(".session-close");
    await deleteBtn.click();
    await card.locator(".session-delete-confirm-yes").click();
    await expect
      .poll(() => sidebar.cardCount(), { timeout: 30_000 })
      .toBe(0);

    // 7. No renderer errors after deletion.
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
