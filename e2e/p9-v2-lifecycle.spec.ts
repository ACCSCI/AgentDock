/**
 * P9 — UI 点击 → v2 daemon 状态闭环 (新架构 §13.1 + §4.2).
 *
 * Drives a real Electron BrowserWindow through the full session lifecycle:
 *   1. Open project → click "+" in SessionSidebar → wait for card
 *   2. Verify daemon's v2 three-table is populated:
 *      - v2Sessions has one entry with status="active"
 *      - v2Owners has the matching entry with fencingToken ≥ 1
 *      - v2Ports has the session's portKey entries
 *
 * Mirrors the proven session-ui.spec.ts click pattern — uses the same
 * locator / data attributes — so we don't trip on UI markup.
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

function writeEmptyConfig(dir: string): void {
  writeFileSync(
    join(dir, "agentdock.config.yaml"),
    `version: "1"\nresources:\n  sync: []\nhooks: {}\n`,
    "utf-8",
  );
}

test.describe("P9 v2 lifecycle — UI click → daemon v2 three-table", () => {
  test("create session populates v2Sessions/v2Owners/v2Ports", async ({
    window,
    dataDir,
  }) => {
    const isV2Mode = process.env.AGENTDOCK_V2 === "1";
    if (!isV2Mode) {
      test.skip(true, "P9 spec requires AGENTDOCK_V2=1 in the Electron env");
      return;
    }

    // 1. Prepare a real git project on disk.
    const projectPath = join(dataDir, "p9-v2-project");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);

    // 2. Open the project through the home → dir browser flow.
    const home = new HomePage(window);
    await expect(home.openProjectButton).toBeVisible();
    await home.openProject(projectPath);

    // 3. Wait for the sidebar to land in /app/$projectId.
    const sidebar = new SidebarPage(window);
    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });
    expect(await sidebar.cardCount()).toBe(0);

    // 4. Click "+" — under AGENTDOCK_V2=1, the IPC handler routes to
    //    v2 PortService which calls /session/create → /claim × N →
    //    /session/activate on the daemon.
    await sidebar.clickNewSession();

    // 5. Wait for the session card to materialize (optimistic insert).
    await expect
      .poll(async () => sidebar.cardCount(), { timeout: 30_000 })
      .toBe(1);

    // Wait an additional 10s for the lifecycle to finish (allocatePorts → activate)
    await new Promise((r) => setTimeout(r, 10_000));

    // 6. Read the v2 three-table from the daemon via the IPC bridge.
    //    First check whether AGENTDOCK_V2 actually reached main.
    const v2Enabled = await window.evaluate(async () => {
      return await window.api.bootstrap.v2Enabled();
    });
    const dbg = (await window.evaluate(async () => {
      return await window.api.daemon.debugState();
    })) as {
      v2Sessions: Record<string, { status: string; projectRoot: string; displayName?: string }>;
      v2Owners: Record<string, { fencingToken: number; clientId: string }>;
      v2Ports: Record<number, { sessionId: string; name: string }>;
    } | null;

    expect(dbg).not.toBeNull();
    expect(v2Enabled, "AGENTDOCK_V2=1 should have reached Electron main").toBe(true);

    // Print diagnostic so failure message is actionable.
    // eslint-disable-next-line no-console
    console.log("[P9 diag] v2Enabled:", v2Enabled);
    // eslint-disable-next-line no-console
    console.log("[P9 diag] v2Sessions:", Object.keys(dbg!.v2Sessions ?? {}));
    // eslint-disable-next-line no-console
    console.log("[P9 diag] v2Owners:", Object.keys(dbg!.v2Owners ?? {}));
    // eslint-disable-next-line no-console
    console.log("[P9 diag] v2Ports:", Object.keys(dbg!.v2Ports ?? {}));
    expect(dbg!.v2Sessions).toBeDefined();
    expect(dbg!.v2Owners).toBeDefined();
    expect(dbg!.v2Ports).toBeDefined();

    // Find the session matching our project.
    const sessionEntries = Object.entries(dbg!.v2Sessions).filter(
      ([, s]) => s.projectRoot === projectPath,
    );
    expect(
      sessionEntries.length,
      `expected ≥1 v2Sessions entry for projectRoot=${projectPath}; saw ${sessionEntries.length}`,
    ).toBeGreaterThanOrEqual(1);
    const [v2Sid, session] = sessionEntries[0]!;
    expect(session.status).toBe("active");

    // v2Owners has the fencing token.
    expect(dbg!.v2Owners[v2Sid]).toBeDefined();
    expect(dbg!.v2Owners[v2Sid]!.fencingToken).toBeGreaterThanOrEqual(1);

    // v2Ports has at least the default port keys.
    const sessionPorts = Object.values(dbg!.v2Ports).filter(
      (p) => p.sessionId === v2Sid,
    );
    expect(
      sessionPorts.length,
      `expected ≥1 v2Ports entry for sessionId=${v2Sid}; saw ${sessionPorts.length}`,
    ).toBeGreaterThanOrEqual(1);
    // Each port key in our PORT_KEYS_DEFAULT should appear at least once.
    const names = new Set(sessionPorts.map((p) => p.name));
    expect(names.has("FRONTEND_PORT")).toBe(true);

    // 7. The renderer card carries the daemon's v2 sessionId in its
    //    data-session-id. (Per AppSession <-> v2SessionId mapping.)
    const card = window.locator(`[data-testid="${TID.sessionCard}"]`).first();
    const sessionId = (await card.getAttribute("data-session-id")) ?? "";
    expect(sessionId).not.toBe("");
  });
});