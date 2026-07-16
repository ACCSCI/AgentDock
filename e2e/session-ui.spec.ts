/**
 * UI-driven session lifecycle E2E.
 *
 * Unlike `session-lifecycle.spec.ts` (which calls `window.api.*` directly
 * via `page.evaluate`), this spec drives the renderer through actual
 * click/keyboard interactions, using the Page Object helpers:
 *
 *   home → click "open project" → DirBrowserModal → navigate + confirm
 *     → land in /app/$projectId workspace
 *     → click "+" in SessionSidebar to create a session
 *     → wait for the session card to appear
 *     → click the card's delete ✕ + ✓ confirm
 *     → wait for the card to vanish
 *     → close the app cleanly, assert no main-process EPIPE / crash dialog
 *
 * The empty agentdock.config.yaml keeps the spec under 15 s — the hook
 * path is exercised by `session-hook.spec.ts`.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures/electron-fixture";
import { dumpDb } from "./helpers/dump";
import { HomePage } from "./pages/home";
import { SidebarPage } from "./pages/sidebar";
import { TabBarPage } from "./pages/tab-bar";
import { TID } from "./pages/testids";

function prepareGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -q -b main", { cwd: dir });
  execSync("git -c user.email=e2e@local -c user.name=E2E commit --allow-empty -q -m init", {
    cwd: dir,
  });
}

function writeEmptyConfig(dir: string): void {
  writeFileSync(
    join(dir, "agentdock.config.yaml"),
    `version: "1"\nresources:\n  sync: []\nhooks: {}\n`,
    "utf-8",
  );
}

test.describe("session UI flow (real clicks)", () => {
  // Resilient against environmental load — round-5 saw 60s timeouts.
  // 120s gives the create+delete pipeline room to complete under load.
  test.setTimeout(120_000);

  test("open project → create session → delete session → exit clean", async ({
    window,
    dataDir,
    mainLog,
    pageErrors,
    dialogs,
    rendererLog,
    expectNoRendererErrors,
  }) => {
    // 1. Prepare a real git project on disk.
    const projectPath = join(dataDir, "ui-project");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);

    // 2. Home should render the open-project button.
    const home = new HomePage(window);
    await expect(home.openProjectButton).toBeVisible();

    // 3. Click through the dir browser to open the project.
    //    HomePage.openProject does the dbl-click drill + final select+confirm.
    await home.openProject(projectPath);

    // 4. The TabBar should now show a tab for the project.
    const tabBar = new TabBarPage(window);
    await expect(tabBar.tabBar).toBeVisible();
    await expect(window.locator(`[data-testid="${TID.projectTab}"]`).first()).toBeVisible({
      timeout: 10_000,
    });

    // 5. SessionSidebar should appear (we landed on /app/$projectId).
    const sidebar = new SidebarPage(window);
    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });
    expect(await sidebar.cardCount()).toBe(0);

    // 6. Click "+" to create a session. The renderer's session mutation hook
    //    handles the IPC + optimistic update; the card should appear.
    await sidebar.clickNewSession();

    // 7. Wait until exactly one session card has materialized — the
    //    sidebar's optimistic insert runs as soon as `sessions:create`
    //    resolves with `{sessionId}`. We don't know the id yet, so
    //    wait by count.
    await expect.poll(async () => sidebar.cardCount(), { timeout: 30_000 }).toBe(1);

    // 8. Find the card's sessionId from its data attribute, then assert
    //    its DB row landed with a real port.
    const card = window.locator(`[data-testid="${TID.sessionCard}"]`).first();
    await expect(card).toBeVisible();
    const sessionId = (await card.getAttribute("data-session-id")) ?? "";
    expect(sessionId, "session-card missing data-session-id").not.toBe("");

    // 9. Wait for the DB row to gain its ports — backgroundHookStatus
    //    may briefly be "running" then null (no hooks); ports JSON
    //    appears once the lifecycle finishes.
    //    The active DB lives under the Electron process's cwd
    //    (dataDir), NOT under the project's own folder — `db:projects:
    //    create` only writes the project.path; the DB itself stays at
    //    `<cwd>/.data/db.sqlite` until `db:init` is called.
    await expect
      .poll(
        () => {
          const dump = dumpDb(dataDir);
          const row = dump.sessions.find((s) => s.id === sessionId);
          // On timeout the message should show what we DID see so we
          // know whether the DB is empty (wrong file?) vs has rows with
          // null ports (race / scan not run yet).
          if (!row)
            return JSON.stringify({
              sessionId,
              sawSessions: dump.sessions.map((s) => s.id),
              sawProjects: dump.projects.length,
            });
          return row.ports;
        },
        { timeout: 30_000, message: "session ports never persisted" },
      )
      .not.toBeNull();

    // 10. Delete the session via UI: click the close ✕ inside the card,
    //     then confirm in the shared deletion modal.
    //     Use a longer timeout — in full-suite runs the card may still
    //     be transitioning to active state when we get here.
    const deleteBtn = card.locator(".session-close");
    await deleteBtn.waitFor({ state: "visible", timeout: 15_000 });
    await deleteBtn.click();
    const confirmYes = window.getByTestId("confirm-delete-ok");
    await confirmYes.waitFor({ state: "visible", timeout: 10_000 });
    await confirmYes.click();

    // 11. The card should disappear after delete completes.
    await expect
      .poll(() => sidebar.cardCount(), {
        timeout: 30_000,
        message: "session card not removed after delete",
      })
      .toBe(0);

    // 12. DB row should be gone too.
    await expect
      .poll(() => dumpDb(dataDir).sessions.find((s) => s.id === sessionId), { timeout: 5_000 })
      .toBeUndefined();

    // 13. No native dialogs should have popped during the flow.
    //     `window.api.openProject` / SessionSidebar use `window.alert`
    //     for failures; if any fired, the fixture has captured them.
    expect(
      dialogs.filter((d) => d.type === "alert"),
      `unexpected alert dialogs: ${JSON.stringify(dialogs)}`,
    ).toHaveLength(0);

    // 14. No renderer pageerrors either.
    expect(pageErrors, `renderer pageerrors: ${JSON.stringify(pageErrors)}`).toHaveLength(0);

    // 15. Verify the main-process log doesn't contain an EPIPE
    //     "uncaught exception" line — the bug surfaced as a popup
    //     dialog "A JavaScript error occurred in the main process".
    //     With the shutdown-noise guard in main.ts, EPIPE is only
    //     logged with "[main] swallowed shutdown noise"; an unguarded
    //     EPIPE would say "uncaught exception" instead.
    const joined = mainLog.join("\n");
    expect(joined).not.toMatch(/uncaught exception/i);
    expect(joined).not.toMatch(/A JavaScript error occurred in the main process/);

    // 16. Renderer must not have logged any React/console errors.
    //     React's "Maximum update depth exceeded" is a console.error
    //     (not a throw), so pageErrors alone misses it — explicitly
    //     scan rendererLog and fail fast.
    //     Filter out expected font CORS errors — the agentdock-fonts://
    //     protocol may not resolve in test environments where fonts
    //     haven't been downloaded yet. These are benign.
    const consoleErrors = rendererLog.filter(
      (e) =>
        e.type === "error" &&
        !e.text.includes("agentdock-fonts://") &&
        !(e.location?.url || "").includes("agentdock-fonts://") &&
        !e.text.includes("net::ERR_FAILED"),
    );
    expect(
      consoleErrors,
      `renderer console.error logs:\n${consoleErrors.map((e) => e.text).join("\n---\n")}`,
    ).toHaveLength(0);
    expectNoRendererErrors();
  });
});
