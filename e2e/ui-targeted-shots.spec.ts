// @ts-nocheck
/**
 * Targeted shots for the 3 surfaces the user flagged:
 *   1. DirBrowserModal — breadcrumb/selected-path inconsistent widths
 *   2. Settings page — mixed button/section styling
 *   3. Modal buttons — ConfirmDelete / dir browser actions
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures/electron-fixture";
import { bootstrapHealth, waitForDaemonReady } from "./helpers/ipc";
import { HomePage } from "./pages/home";

const ROOT = process.cwd();
const SHOTS = join(ROOT, "e2e", "audit-shots");

async function shot(window, name) {
  await window.evaluate(() => document.fonts?.ready).catch(() => {});
  await window.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test.describe("targeted UI problem shots", () => {
  test("dir browser path UI + settings page + modal buttons", async ({ app, window, dataDir }) => {
    test.setTimeout(120_000);
    mkdirSync(SHOTS, { recursive: true });
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setSize(1280, 800);
      w.center();
    });
    await window.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    await window.waitForLoadState("domcontentloaded");
    await waitForDaemonReady(window, 30_000);
    await bootstrapHealth(window);
    await expect(window.getByTestId("home-page")).toBeVisible({ timeout: 30_000 });

    // ── 1. Dir browser: drill into a real dir, select an entry ─────────
    const projDir = join(dataDir, "sample-project");
    mkdirSync(projDir, { recursive: true });
    execSync("git init -q -b main", { cwd: projDir });
    await window.getByTestId("home-open-project").click();
    const home = new HomePage(window);
    await home.modal.waitFor({ state: "visible" });
    await window.locator('[data-testid="dir-entry"]').first().waitFor({ state: "visible", timeout: 20_000 });
    // Drill one level so the breadcrumb has real segments, then select an entry.
    const firstName = await window.locator('[data-testid="dir-entry"] .dir-entry-name').first().textContent();
    await window.locator('[data-testid="dir-entry"]').first().dblclick();
    await window.waitForTimeout(500);
    await window.locator('[data-testid="dir-entry"]').first().waitFor({ state: "visible", timeout: 15_000 });
    // Select (single click) the first real entry so the "已选择" path shows.
    await window.locator('[data-testid="dir-entry"]').nth(1).click().catch(() => {});
    await window.waitForTimeout(300);
    await shot(window, "30-dirbrowser-selected-light");
    // Screenshot the breadcrumb + selected-path strip zoomed.
    const breadcrumb = window.locator(".dir-modal-breadcrumb");
    if (await breadcrumb.isVisible().catch(() => false)) {
      await breadcrumb.screenshot({ path: join(SHOTS, "31-dirbrowser-breadcrumb.png") }).catch(() => {});
    }
    const selected = window.locator(".dir-modal-selected");
    if (await selected.isVisible().catch(() => false)) {
      await selected.screenshot({ path: join(SHOTS, "32-dirbrowser-selected-strip.png") }).catch(() => {});
    }
    const actions = window.locator(".dir-modal-actions");
    if (await actions.isVisible().catch(() => false)) {
      await actions.screenshot({ path: join(SHOTS, "33-dirbrowser-actions.png") }).catch(() => {});
    }
    await window.keyboard.press("Escape");

    // ── 2. Settings page ────────────────────────────────────────────────
    await window.getByRole("button", { name: /Settings|设置/ }).click();
    await expect(window.getByTestId("settings-page")).toBeVisible({ timeout: 15_000 });
    await window.waitForTimeout(400);
    await shot(window, "34-settings-light");
    // Full-page (taller) to catch all sections.
    await window.screenshot({ path: join(SHOTS, "35-settings-light-full.png"), fullPage: true }).catch(() => {});
    // Dark settings.
    await window.emulateMedia({ colorScheme: "dark" });
    await window.waitForTimeout(350);
    await shot(window, "36-settings-dark");
    await window.emulateMedia({ colorScheme: "light" });
  });
});
