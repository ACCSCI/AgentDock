/**
 * Terminal interaction flow E2E.
 *
 * Creates a session, activates it, adds a terminal, waits for connected
 * status, types a command via IPC, verifies command execution via a
 * filesystem side-effect (marker file), and verifies the terminal stays
 * connected after the command.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
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

test.describe("terminal interaction flow", () => {
  test("create session -> activate -> add terminal -> wait connected -> type command -> verify via filesystem", async ({
    window,
    dataDir,
    pageErrors,
    dialogs,
    rendererLog,
    expectNoRendererErrors,
  }) => {
    const projectPath = join(dataDir, "terminal-project");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);

    const home = new HomePage(window);
    const sidebar = new SidebarPage(window);
    const terminalPage = new TerminalPage(window);

    await waitForDaemonReady(window);

    // 1. Open project.
    await home.openProject(projectPath);
    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });

    // 2. Create a session.
    await sidebar.clickNewSession();
    await expect
      .poll(async () => sidebar.cardCount(), { timeout: 30_000 })
      .toBe(1);

    // 3. Wait for ports to settle, then click the card to activate.
    const card = window.locator(`[data-testid="${TID.sessionCard}"]`).first();
    await expect(card).toBeVisible();
    await expect(card.locator(".session-ports")).toBeVisible({ timeout: 20_000 });

    // Click the card to activate it (mounts TerminalManager).
    await card.click();
    await expect(terminalPage.panel).toBeVisible({ timeout: 10_000 });

    // 4. Add a terminal.
    await terminalPage.clickNewTerminal();
    await expect(terminalPage.currentTerminal).toBeVisible({ timeout: 10_000 });

    // 5. Wait for the terminal to be connected.
    await terminalPage.waitForStatus("connected", 20_000);

    // 6. Type a command via IPC that writes a marker file.
    const markerFile = join(projectPath, ".agentdock", "e2e-terminal-marker.txt");
    const terminalTab = window.locator(`[data-testid="${TID.terminalTab}"]`).first();
    await expect(terminalTab).toBeVisible();
    const terminalId = await terminalTab.getAttribute("data-terminal-id");
    expect(terminalId, "terminal missing data-terminal-id").toBeTruthy();

    await window.evaluate(
      async ({ terminalId, markerFile }) => {
        await (
          window as unknown as {
            api: {
              terminal: {
                write: (terminalId: string, data: string) => Promise<void>;
              };
            };
          }
        ).api.terminal.write(
          terminalId,
          `echo "e2e-marker-ok" > "${markerFile.replace(/\\/g, "\\\\")}"\r`,
        );
      },
      { terminalId, markerFile },
    );

    // 7. Wait for the marker file to appear on disk.
    await expect
      .poll(
        () => {
          try {
            return existsSync(markerFile);
          } catch {
            return false;
          }
        },
        { timeout: 15_000, message: `marker file ${markerFile} was never created` },
      )
      .toBe(true);

    // 8. Verify terminal is still connected after command execution.
    const status = await terminalPage.currentTerminal.getAttribute("data-status");
    expect(status).toBe("connected");

    // 9. Clean up: delete the session.
    const deleteBtn = card.locator(".session-close");
    await deleteBtn.click();
    await card.locator(".session-delete-confirm-yes").click();
    await expect
      .poll(() => sidebar.cardCount(), { timeout: 30_000 })
      .toBe(0);

    expect(pageErrors).toHaveLength(0);
    const consoleErrors = rendererLog.filter((e) => e.type === "error");
    expect(consoleErrors).toHaveLength(0);
    expectNoRendererErrors();
  });
});
