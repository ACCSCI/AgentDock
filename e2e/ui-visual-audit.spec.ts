// @ts-nocheck
/**
 * Visual UI audit — NOT a pass/fail gate.
 *
 * Purpose: boot isolated Electron instances, drive the app through every
 * key surface (home, workspace, session cards, config editor, terminal,
 * modals, menus), and capture a screenshot matrix so a human/model can
 * review layout & typography against docs/ui-ux-review-checklist.md.
 *
 * Matrix: { light, dark } × { 1280×800 } + { light } × { 900×640 narrow }.
 * Extra states: dir-browser modal, terminal add-menu, delete-confirm modal,
 * multi-session sidebar, terminal panel with real content.
 *
 * Output: e2e/audit-shots/<surface>-<theme>-<size>.png (mirrored to
 * .user-simulator/audit-<ts>/ for versioning).
 *
 * Run:  bunx playwright test e2e/ui-visual-audit.spec.ts
 */
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures/electron-fixture";
import {
  awaitSessionComplete,
  bootstrapHealth,
  createSession,
  waitForDaemonReady,
} from "./helpers/ipc";
import { HomePage } from "./pages/home";
import { SidebarPage } from "./pages/sidebar";
import { TerminalPage } from "./pages/terminal";

const ROOT = process.cwd();
const SHOTS = join(ROOT, "e2e", "audit-shots");

/** Deterministic window sizes for the audit matrix. */
const STANDARD = { width: 1280, height: 800 };
const NARROW = { width: 900, height: 640 };

function gitInitRepo(dir: string, name: string) {
  mkdirSync(dir, { recursive: true });
  execSync("git init -q -b main", { cwd: dir });
  execSync("git -c user.email=e2e@local -c user.name=E2E commit --allow-empty -q -m init", {
    cwd: dir,
  });
  // A couple of files so the dir browser / config have something real.
  writeFileSync(join(dir, "README.md"), `# ${name}\n`, "utf8");
  execSync("git add -A", { cwd: dir });
  execSync("git -c user.email=e2e@local -c user.name=E2E commit -q -m files", { cwd: dir });
}

async function setWindowSize(app, { width, height }) {
  await app.evaluate(({ BrowserWindow }, { width, height }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(width, height);
    win.center();
  }, { width, height });
  // Let layout settle after resize.
}

async function shot(window, name) {
  await window.evaluate(() => document.fonts?.ready).catch(() => {});
  await window.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Standard page setup: theme, reduced motion off for honest visuals. */
async function prime(window, colorScheme) {
  await window.emulateMedia({ colorScheme, reducedMotion: "no-preference" });
  await window.waitForLoadState("domcontentloaded");
  await waitForDaemonReady(window, 30_000);
  await bootstrapHealth(window);
}

test.describe("visual audit", () => {
  test("captures light + dark surfaces at standard size", async ({ app, window, dataDir }) => {
    test.setTimeout(180_000);
    mkdirSync(SHOTS, { recursive: true });

    // ── Light pass ────────────────────────────────────────────────────
    await setWindowSize(app, STANDARD);
    await prime(window, "light");
    await expect(window.getByTestId("home-page")).toBeVisible({ timeout: 30_000 });
    await shot(window, "01-home-light-standard");

    // Dir-browser modal (open, then dismiss).
    await window.getByTestId("home-open-project").click();
    const home = new HomePage(window);
    await home.modal.waitFor({ state: "visible" });
    await window.locator('[data-testid="dir-entry"]').first().waitFor({
      state: "visible",
      timeout: 20_000,
    });
    await shot(window, "02-dirbrowser-light-standard");
    await window.keyboard.press("Escape");
    await home.modal.waitFor({ state: "hidden" }).catch(() => {});

    // Open a project with real config so the workspace + config editor render.
    const projDir = join(dataDir, "alpha-checkout-service");
    gitInitRepo(projDir, "alpha-checkout-service");
    writeFileSync(
      join(projDir, "agentdock.config.yaml"),
      'version: "1"\nresources:\n  sync: []\nhooks: {}\n',
      "utf8",
    );
    await home.openProject(projDir);
    await expect(window.locator("main.config-editor")).toBeVisible({ timeout: 30_000 });
    await shot(window, "03-config-editor-light-standard");

    // Create two sessions via the real UI path (the "新建 Session" button runs
    // the optimistic react-query mutation, so cards actually render — unlike
    // raw IPC which bypasses cache invalidation).
    const sidebar = new SidebarPage(window);
    await sidebar.clickNewSession();
    await expect.poll(() => sidebar.cardCount(), { timeout: 60_000 }).toBe(1);
    await window.waitForTimeout(1500); // respect the 1.5s create cooldown
    await sidebar.clickNewSession();
    await expect.poll(() => sidebar.cardCount(), { timeout: 60_000 }).toBe(2);
    // Let hook/worktree settle so status badges reach their final state.
    await window.waitForTimeout(1500);

    // Select first session → workspace header + session info + terminal.
    const firstCard = window.locator('[data-testid="session-card"]').first();
    await firstCard.click();
    const s1id = await firstCard.getAttribute("data-session-id");
    const terminal = new TerminalPage(window);
    // Open a real terminal and print content so the panel isn't empty.
    try {
      const term = await window.evaluate(async (sid) => {
        const t = await (window as any).api.terminals.create(sid);
        await (window as any).api.terminals.open(t.terminalId);
        return t;
      }, s1id);
      await terminal.waitForStatus("connected", 20_000).catch(() => {});
      await window.evaluate(
        ({ id }) => (window as any).api.terminals.write(id, "echo AgentDock audit; git status; ls\n"),
        { id: term.terminalId },
      ).catch(() => {});
      await window.waitForTimeout(1000);
    } catch {
      /* terminal may be slow; capture whatever renders */
    }
    await shot(window, "04-workspace-session-light-standard");

    // Terminal "+" hover dropdown menu.
    await window.getByTestId("new-terminal").hover();
    await window.locator(".terminal-add-dropdown").waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    await window.waitForTimeout(250);
    await shot(window, "05-terminal-addmenu-light-standard");
    await window.mouse.move(10, 10);

    // Delete confirmation modal (open on 2nd card, then cancel).
    const secondCard = window.locator('[data-testid="session-card"]').nth(1);
    await secondCard.hover();
    const closeBtn = secondCard.locator(".session-close");
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
      await window.waitForTimeout(400);
      await shot(window, "06-delete-confirm-light-standard");
      await window.keyboard.press("Escape").catch(() => {});
    }

    // ── Dark pass (same instance, re-primed) ──────────────────────────
    await prime(window, "dark");
    await window.waitForTimeout(350);
    await shot(window, "10-workspace-session-dark-standard");
    await shot(window, "11-config-editor-dark-standard");

    // Home in dark: navigate back by closing the tab.
    await window.locator('[data-testid="project-tab-close"]').first().click().catch(() => {});
    await window.waitForTimeout(500);
    if (await window.getByTestId("home-page").isVisible().catch(() => false)) {
      await shot(window, "12-home-dark-standard");
    }
  });

  test("captures narrow-window layout (overflow / truncation)", async ({ app, window, dataDir }) => {
    test.setTimeout(120_000);
    mkdirSync(SHOTS, { recursive: true });

    await setWindowSize(app, NARROW);
    await prime(window, "light");
    await expect(window.getByTestId("home-page")).toBeVisible({ timeout: 30_000 });
    await shot(window, "20-home-light-narrow");

    const projDir = join(dataDir, "narrow-probe");
    gitInitRepo(projDir, "narrow-probe");
    writeFileSync(
      join(projDir, "agentdock.config.yaml"),
      'version: "1"\nresources:\n  sync: []\nhooks: {}\n',
      "utf8",
    );
    await new HomePage(window).openProject(projDir);
    await expect(window.locator("main.config-editor")).toBeVisible({ timeout: 30_000 });
    await shot(window, "21-config-editor-light-narrow");

    const pid = await projectIdByPath(window, projDir);
    expect(pid, `project id for ${projDir}`).toBeTruthy();
    // Use the UI new-session button so the card renders (IPC bypasses the
    // optimistic cache update). Rename it long afterwards to test truncation.
    const nsidebar = new SidebarPage(window);
    await nsidebar.clickNewSession();
    await expect.poll(() => nsidebar.cardCount(), { timeout: 60_000 }).toBe(1);
    await window.waitForTimeout(1500);
    await window.locator('[data-testid="session-card"]').first().click();
    await window.waitForTimeout(600);
    await shot(window, "22-workspace-light-narrow");
  });
});

/** Find a project's id by matching its on-disk path (robust against stale tabs). */
async function projectIdByPath(window, dir: string): Promise<string | null> {
  return await window.evaluate(async (target) => {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const projects = await (window as any).api.db.projects.list();
    const hit = (projects ?? []).find((p: any) => norm(p.path) === norm(target));
    return hit?.id ?? null;
  }, dir);
}
