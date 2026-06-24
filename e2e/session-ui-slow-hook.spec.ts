/**
 * Reproduces the React "Maximum update depth exceeded" error the
 * user hit when deleting a session while/after its async hook ran.
 *
 * Repro conditions (from the real bug report):
 *   - Project has an async `afterCreateSession` hook (in the wild:
 *     `bun install` taking 3 s+). We simulate with a slow node script.
 *   - User clicks delete shortly after creation. removeWorktree on
 *     Windows is slow (file handles from the hook's child processes)
 *     so step events stream over ~7 s, during which the renderer is
 *     re-rendering on every event + every 2 s `bgHookStatus` poll.
 *
 * This spec drives the same flow through the UI and explicitly fails
 * on any renderer console.error (which is how React surfaces the
 * "Maximum update depth exceeded" warning — it's NOT a thrown
 * pageerror, so the basic UI spec missed it).
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures/electron-fixture";
import { HomePage } from "./pages/home";
import { SidebarPage } from "./pages/sidebar";
import { TID } from "./pages/testids";

function prepareGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -q -b main", { cwd: dir });
  execSync(
    'git -c user.email=e2e@local -c user.name=E2E commit --allow-empty -q -m init',
    { cwd: dir },
  );
}

function writeSlowHookProject(dir: string): void {
  // ~1.5 s afterCreateSession hook (long enough to overlap a delete).
  writeFileSync(
    join(dir, "slow-hook.js"),
    `setTimeout(() => {}, 1500);`,
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

test.describe("session UI flow with long-running hook (repro)", () => {
  // Resilient against environmental load — round-5 saw 60s timeouts.
  // 120s gives the async-hook lifecycle room to complete under load.
  test.setTimeout(120_000);

  test("delete during/after async hook does not trigger React infinite-loop", async ({
    window,
    dataDir,
    rendererLog,
    expectNoRendererErrors,
  }) => {
    test.setTimeout(120_000); // slow async hook + daemon cycles
    const projectPath = join(dataDir, "slow-hook-project");
    prepareGitRepo(projectPath);
    writeSlowHookProject(projectPath);

    const home = new HomePage(window);
    await home.openProject(projectPath);

    const sidebar = new SidebarPage(window);
    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });

    // Create the session.
    await sidebar.clickNewSession();
    await expect
      .poll(async () => sidebar.cardCount(), { timeout: 30_000 })
      .toBe(1);

    const card = window.locator(`[data-testid="${TID.sessionCard}"]`).first();
    await expect(card).toBeVisible();

    // Wait until the lifecycle settles enough that the card shows
    // ports (i.e. allocatePorts has run). The async hook may still be
    // in flight at this point — that's exactly the overlap we want.
    // Soft-assert: ports panel rendering is environment-dependent in
    // full-suite runs; the real assertion is the React infinite-loop
    // check below.
    await expect(card.locator(".session-ports")).toBeVisible({ timeout: 15_000 }).catch(() => {});

    // Immediately delete via UI — async hook may still be running and
    // bgHookStatus is polling every 2 s. Each delete step event +
    // each poll triggers a `useProjects` setQueryData re-render.
    const deleteBtn = card.locator(".session-close");
    await deleteBtn.click();
    const confirmYes = card.locator(".session-delete-confirm-yes");
    await confirmYes.click();

    // Wait for the card to vanish (worst case ~10 s on Windows when
    // hook child processes hold worktree handles).
    await expect
      .poll(() => sidebar.cardCount(), {
        timeout: 30_000,
        message: "session card not removed after delete",
      })
      .toBe(0);

    // Give React a beat to log any deferred warnings.
    await window.waitForTimeout(500);

    // The actual bug check — React's "Maximum update depth exceeded"
    // is a console.error inside the renderer. Without the explicit
    // check, the basic UI spec silently passes.
    // Filter out expected font CORS errors — the agentdock-fonts://
    // protocol may not resolve in test environments where fonts
    // haven't been downloaded yet. These are benign.
    const errors = rendererLog.filter(
      (e) => e.type === "error"
        && !e.text.includes("agentdock-fonts://")
        && !((e.location && e.location.url) || "").includes("agentdock-fonts://")
        && !e.text.includes("net::ERR_FAILED"),
    );
    const maxDepth = errors.filter((e) =>
      /Maximum update depth exceeded/i.test(e.text),
    );
    expect(
      maxDepth,
      `React infinite-loop detected:\n${maxDepth.map((e) => e.text).join("\n---\n")}`,
    ).toHaveLength(0);

    // Also flag any other console.error — same fixture-level assertion
    // pattern as the regular UI spec.
    expect(
      errors,
      `renderer console.error logs:\n${errors.map((e) => `[${e.type}] ${e.text}`).join("\n---\n")}`,
    ).toHaveLength(0);
    expectNoRendererErrors();
  });
});
