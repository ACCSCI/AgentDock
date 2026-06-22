/**
 * Real-user interaction sequence — catches re-render / setState loops
 * the simpler UI specs miss because they don't *click* the session.
 *
 * Reproduces the user-reported "Maximum update depth exceeded" path:
 *   1. Open project
 *   2. Create session
 *   3. **Click the session card to activate it** ← mounts TerminalManager
 *      + useSessionTerminals + auto-selects first terminal effects
 *   4. Click "+" in terminal panel to add a terminal
 *   5. Add a second terminal, switch between them
 *   6. Delete one terminal
 *   7. Delete the session (while bg hooks may still be running)
 *   8. Create a second session, switch, delete
 *
 * The whole time, the fixture watches renderer console.error. Any
 * "Maximum update depth exceeded" or other React warning fails fast.
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
  // ~1 s afterCreateSession hook → background activity while user
  // interacts. Long enough that delete-during-hook is realistic.
  writeFileSync(join(dir, "slow-hook.js"), `setTimeout(() => {}, 1000);`, "utf-8");
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

test.describe("real user interaction sequence", () => {
  test("activate → +terminal → +terminal → switch → delete terminal → delete session", async ({
    window,
    dataDir,
    rendererLog,
    pageErrors,
  }) => {
    const projectPath = join(dataDir, "interaction-project");
    prepareGitRepo(projectPath);
    writeProjectWithSlowHook(projectPath);

    // 1. Open project via UI.
    const home = new HomePage(window);
    await home.openProject(projectPath);

    const sidebar = new SidebarPage(window);
    const terminalPage = new TerminalPage(window);

    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });

    // 2. Create session #1.
    await sidebar.clickNewSession();
    await expect.poll(() => sidebar.cardCount(), { timeout: 30_000 }).toBe(1);

    const card1 = window.locator(`[data-testid="${TID.sessionCard}"]`).first();
    const session1Id = await card1.getAttribute("data-session-id");
    expect(session1Id).toBeTruthy();
    await expect(card1.locator(".session-ports")).toBeVisible({ timeout: 15_000 });

    // 3. ★ Click the card to activate it — this mounts TerminalManager
    //   and triggers useSessionTerminals + the auto-select-first
    //   useEffect chain that the simpler spec never exercised.
    await card1.click();
    await expect(terminalPage.panel).toBeVisible({ timeout: 10_000 });

    // 4. Click the terminal-panel "+" to add a terminal. It should
    //    mount SessionTerminal + wire up the MessagePort.
    await terminalPage.clickNewTerminal();
    await expect(terminalPage.currentTerminal).toBeVisible({ timeout: 10_000 });
    // Wait for the PTY to connect — `data-status="connected"` is the
    // authoritative ready signal (xterm canvas is opaque to selectors).
    await terminalPage.waitForStatus("connected", 15_000);

    // 5. Add a second terminal.
    await terminalPage.clickNewTerminal();
    await window.waitForTimeout(500);
    const terminalTabs = window.locator(`[data-testid="${TID.terminalTab}"]`);
    await expect.poll(() => terminalTabs.count(), { timeout: 10_000 }).toBe(2);

    // 6. Switch to the first terminal (click its tab).
    const firstTab = terminalTabs.first();
    await firstTab.click();
    await window.waitForTimeout(300);

    // 7. Delete the second terminal via its close ✕.
    const secondTab = terminalTabs.nth(1);
    const closeBtn = secondTab.locator(".terminal-tab-close");
    await closeBtn.click();
    await expect.poll(() => terminalTabs.count(), { timeout: 10_000 }).toBe(1);

    // 8. Create session #2 and switch to it.
    await sidebar.clickNewSession();
    await expect.poll(() => sidebar.cardCount(), { timeout: 30_000 }).toBe(2);

    const cards = window.locator(`[data-testid="${TID.sessionCard}"]`);
    const card2 = cards.nth(1);
    const session2Id = await card2.getAttribute("data-session-id");
    expect(session2Id).toBeTruthy();
    await expect(card2.locator(".session-ports")).toBeVisible({ timeout: 15_000 });
    await card2.click();
    await window.waitForTimeout(500);

    // 9. Switch back to session #1.
    await card1.click();
    await window.waitForTimeout(500);
    // Terminal panel should re-mount with session #1's terminal.
    await expect(terminalPage.panel).toBeVisible();

    // 10. Delete session #1 (while async hook may still be in flight
    //     OR right after; either way it's the same code path).
    const deleteBtn1 = card1.locator(".session-close");
    await deleteBtn1.click();
    await card1.locator(".session-delete-confirm-yes").click();
    await expect.poll(() => sidebar.cardCount(), { timeout: 30_000 }).toBe(1);

    // 11. Delete session #2.
    const remaining = window.locator(`[data-testid="${TID.sessionCard}"]`).first();
    const deleteBtn2 = remaining.locator(".session-close");
    await deleteBtn2.click();
    await remaining.locator(".session-delete-confirm-yes").click();
    await expect.poll(() => sidebar.cardCount(), { timeout: 30_000 }).toBe(0);

    // Give React + queries one last beat to flush deferred state.
    await window.waitForTimeout(1000);

    // ★ The bug check — fail fast on any "Maximum update depth"
    //   or other renderer console.error.
    const errors = rendererLog.filter((e) => e.type === "error");
    const maxDepth = errors.filter((e) =>
      /Maximum update depth exceeded/i.test(e.text),
    );
    expect(
      maxDepth,
      `React infinite-loop detected:\n${maxDepth.map((e) => e.text).join("\n---\n")}`,
    ).toHaveLength(0);
    expect(
      errors,
      `unexpected renderer console.error logs:\n${errors.map((e) => `[${e.type}] ${e.text}`).join("\n---\n")}`,
    ).toHaveLength(0);
    expect(
      pageErrors,
      `renderer pageerrors:\n${JSON.stringify(pageErrors)}`,
    ).toHaveLength(0);
  });
});
