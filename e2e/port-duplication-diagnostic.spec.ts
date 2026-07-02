/**
 * Diagnostic: create two sessions rapidly and check port allocation.
 *
 * This is a one-off diagnostic, not a permanent spec.
 */
import { test, expect } from "./fixtures/electron-fixture";
import { execSync } from "node:child_process";

const PROJECT_PATH = "F:\\ProgramPlayground\\JavaScript\\Copilot-Switch";
const PROJECT_NAME = "Copilot-Switch";

async function waitForDirEntries(window: import("@playwright/test").Page, timeoutMs = 15_000) {
  const entries = window.locator('[data-testid="dir-entry"]');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await entries.count() > 0) return;
    await window.waitForTimeout(100);
  }
  throw new Error("dir-entry never rendered");
}

function entryByName(window: import("@playwright/test").Page, name: string) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return window.locator('[data-testid="dir-entry"]')
    .filter({ has: window.locator(".dir-entry-name", { hasText: new RegExp(`^${esc}$`) }) })
    .first();
}

test.setTimeout(300_000);

test("diagnostic: rapid double-create → check port duplication", async ({ window, dataDir }) => {
  // Step 1: open Copilot-Switch
  await window.locator('[data-testid="home-open-project"]').waitFor({ state: "visible", timeout: 15_000 });
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
  await window.waitForTimeout(3000);
  await window.locator("h2").filter({ hasText: PROJECT_NAME }).first().waitFor({ state: "visible", timeout: 20_000 });

  // Step 2+3: create TWO sessions in parallel — click + twice immediately
  // WITHOUT waiting for the first session to appear. This triggers
  // two concurrent IPC sessions:create calls and two parallel lifecycle runs.
  const countBefore = await window.locator('[data-testid="session-card"]').count();
  await window.locator('[data-testid="new-session"]').click();
  // Immediately click again — don't wait for session 1 card to appear
  await window.locator('[data-testid="new-session"]').click();

  // Wait for both cards to appear
  await window.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="session-card"]').length >= n,
    countBefore + 2,
    { timeout: 30_000 },
  );

  const allSessionIds = await window.locator('[data-testid="session-card"]').evaluateAll(
    (els) => els.map((el) => el.getAttribute("data-session-id")).filter(Boolean) as string[],
  );
  // Take the last two as our sessions
  const id1 = allSessionIds[allSessionIds.length - 2]!;
  const id2 = allSessionIds[allSessionIds.length - 1]!;
  expect(id1).not.toBe("");
  expect(id2).not.toBe("");
  expect(id2).not.toBe(id1);

  // Step 4: wait for both to leave "creating" state (up to 120s total)
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const s1 = await window.evaluate((sid) => {
      const w = document.querySelector(`[data-testid="session-card"][data-session-id="${sid}"]`);
      if (!w) return "gone";
      const i = w.querySelector(".session-card") ?? w;
      return i.classList.contains("session-card-creating") ? "creating" : "active";
    }, id1);
    const s2 = await window.evaluate((sid) => {
      const w = document.querySelector(`[data-testid="session-card"][data-session-id="${sid}"]`);
      if (!w) return "gone";
      const i = w.querySelector(".session-card") ?? w;
      return i.classList.contains("session-card-creating") ? "creating" : "active";
    }, id2);
    if (s1 === "active" && s2 === "active") break;
    await window.waitForTimeout(3_000);
  }

  // Step 5: read .env files from each worktree
  const worktreesDir = "F:\\ProgramPlayground\\JavaScript\\Copilot-Switch\\.agentdock\\worktrees";
  const env1 = execSync(`type "${worktreesDir}\\${id1}\\.env" 2>nul || echo NOT_FOUND`, { encoding: "utf-8" });
  const env2 = execSync(`type "${worktreesDir}\\${id2}\\.env" 2>nul || echo NOT_FOUND`, { encoding: "utf-8" });

  console.log(`\n=== Session 1 (${id1}) .env ===\n${env1}`);
  console.log(`\n=== Session 2 (${id2}) .env ===\n${env2}`);

  // Extract FRONTEND_PORT from each
  const fe1 = env1.match(/FRONTEND_PORT=(\d+)/)?.[1];
  const fe2 = env2.match(/FRONTEND_PORT=(\d+)/)?.[1];
  console.log(`\nSession 1 FRONTEND_PORT: ${fe1 ?? "NOT FOUND"}`);
  console.log(`Session 2 FRONTEND_PORT: ${fe2 ?? "NOT FOUND"}`);

  if (fe1 && fe2 && fe1 === fe2) {
    console.log(`\n⚠️  DUPLICATE PORT DETECTED: both sessions have FRONTEND_PORT=${fe1}`);
  } else if (fe1 && fe2) {
    console.log(`\n✓ Ports are different: ${fe1} vs ${fe2}`);
  }

  // Step 6: cleanup - delete both sessions
  for (const sid of [id2, id1]) {
    const card = window.locator(`[data-testid="session-card"][data-session-id="${sid}"]`);
    if (await card.count() > 0) {
      const closeBtn = card.locator('.session-close');
      if (await closeBtn.count() > 0) {
        await closeBtn.click();
        const confirm = window.locator('[data-testid="confirm-delete-ok"]');
        if (await confirm.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await confirm.click();
        }
        await window.waitForFunction(
          (sid) => !document.querySelector(`[data-testid="session-card"][data-session-id="${sid}"]`),
          sid,
          { timeout: 15_000 },
        ).catch(() => {});
      }
    }
  }
});
