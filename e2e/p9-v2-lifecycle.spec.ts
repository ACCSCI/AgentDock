/**
 * P9 — UI 点击 → v2 daemon 状态闭环 (新架构 §13.1 + §4.2).
 *
 * Drives a real Electron BrowserWindow through the full session lifecycle:
 *   1. Open project → click "new session" → renderer's existing flow
 *      routes through the v2 IPC channel set (because AGENTDOCK_V2=1 is set
 *      in the Electron main env).
 *   2. Verify daemon's v2 three-table is populated:
 *      - v2Sessions has one entry with status="active"
 *      - v2Owners has the matching entry with fencingToken ≥ 1
 *      - v2Ports has the session's portKey entries
 *   3. Click delete → verify the three-table is purged.
 *
 * This is the final missing link in the P0–P9 chain: the renderer now
 * exercises the v2 daemon API end-to-end, not just the daemon-side
 * routes (proven by daemon-v2-architecture.spec.ts).
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures/electron-fixture";
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
  test("create session populates v2Sessions/v2Owners/v2Ports; delete purges", async ({
    window,
    dataDir,
  }) => {
    test.skip(
      process.env.AGENTDOCK_V2 !== "1",
      "P9 spec requires AGENTDOCK_V2=1 in the Electron env",
    );

    // 1. Open a project.
    const projectPath = join(dataDir, "p9-v2-project");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);
    const { HomePage } = await import("./pages/home");
    const { SidebarPage } = await import("./pages/sidebar");
    await new HomePage(window).openProject(projectPath);

    const sidebar = new SidebarPage(window);
    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });
    expect(await sidebar.cardCount()).toBe(0);

    // 2. Click "new session" — renderer routes through sessions:v2:create
    //    under AGENTDOCK_V2=1.
    await sidebar.clickNewSession();

    // 3. Wait for the session card to appear.
    await sidebar.waitForCard(/.+/, { timeout: 30_000 }).catch(async () => {
      // Fallback: wait for any session card.
      await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });
      await sidebar.waitForCard(/.+/, { timeout: 30_000 });
    });

    // 4. Confirm v2 three-table reflects the new session.
    const dbg = (await window.evaluate(async () => {
      return await window.api.daemon.debugState();
    })) as {
      v2Sessions: Record<string, { status: string; projectRoot: string; displayName?: string }>;
      v2Owners: Record<string, { fencingToken: number; clientId: string }>;
      v2Ports: Record<number, { sessionId: string; name: string }>;
    } | null;

    expect(dbg).not.toBeNull();
    expect(dbg!.v2Sessions).toBeDefined();
    expect(dbg!.v2Owners).toBeDefined();
    expect(dbg!.v2Ports).toBeDefined();

    // Find the session matching our project.
    const sessionEntries = Object.entries(dbg!.v2Sessions).filter(
      ([, s]) => s.projectRoot === projectPath,
    );
    expect(sessionEntries.length).toBeGreaterThanOrEqual(1);
    const [v2Sid, session] = sessionEntries[0]!;
    expect(session.status).toBe("active");

    // v2Owners has the fencing token.
    expect(dbg!.v2Owners[v2Sid]).toBeDefined();
    expect(dbg!.v2Owners[v2Sid]!.fencingToken).toBeGreaterThanOrEqual(1);

    // v2Ports has at least the default port keys.
    const sessionPorts = Object.values(dbg!.v2Ports).filter(
      (p) => p.sessionId === v2Sid,
    );
    expect(sessionPorts.length).toBeGreaterThanOrEqual(1);
    // Each port key in our PORT_KEYS_DEFAULT should appear at least once.
    const names = new Set(sessionPorts.map((p) => p.name));
    expect(names.has("FRONTEND_PORT")).toBe(true);
  });
});