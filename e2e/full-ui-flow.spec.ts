/**
 * E2E Test: Full user flow — open project, create session, delete session
 *
 * Verifies the complete backend flow using direct IPC calls.
 * The React Query cache (used by TabBar/SessionSidebar) is not tested here
 * because the test fixture cannot force cache invalidation across renderer mounts.
 */
import { test, expect } from "./fixtures/electron-fixture";

const PROJECT_PATH = "F:\\ProgramPlayground\\JavaScript\\Copilot-Switch";

test.describe("Full user flow (IPC)", () => {
  test("open project → create session → delete session", async ({ window }) => {
    // ── 1. Open project via direct IPC ──
    const { projectId, sessionCount: beforeCount } = await window.evaluate(async (p: string) => {
      const all = await (window as any).api.db.projects.list();
      const existing = all.find((x: any) => x.path === p);
      if (existing) {
        await (window as any).api.db.init(p);
        return { projectId: existing.id, sessionCount: existing.sessions.length };
      }
      const name = p.split(/[\\/]/).pop();
      const created = await (window as any).api.db.projects.create(name, p);
      await (window as any).api.db.init(p);
      return { projectId: created.id, sessionCount: 0 };
    }, PROJECT_PATH);
    console.log(`✓ Project opened: ${projectId}, sessions: ${beforeCount}`);

    // ── 2. Create session ──
    const { sessionId } = await window.evaluate(async (pid: string) => {
      const result = await (window as any).api.sessions.create({
        projectId: pid,
        name: "E2E Test Session",
      });
      return result;
    }, projectId);
    console.log(`✓ Session created: ${sessionId}`);

    // Wait for lifecycle to complete
    await window.waitForTimeout(5000);

    // ── 3. Verify session exists in backend ──
    const sessionData = await window.evaluate(async (args: { sid: string; pid: string }) => {
      const all = await (window as any).api.db.projects.list();
      const project = all.find((x: any) => x.id === args.pid);
      const s = project?.sessions?.find((x: any) => x.id === args.sid);
      return s ? { id: s.id, name: s.name, status: s.status, steps: s.steps } : null;
    }, { sid: sessionId, pid: projectId });
    console.log(`✓ Backend session: ${JSON.stringify(sessionData)}`);
    expect(sessionData).toBeTruthy();
    expect(sessionData.id).toBe(sessionId);

    // ── 4. Delete session ──
    const deleteResult = await window.evaluate(async (sid: string) => {
      const result = await (window as any).api.sessions.delete(sid);
      return result;
    }, sessionId);
    console.log(`✓ Delete result: ${JSON.stringify(deleteResult)}`);

    // Wait for delete lifecycle to complete
    await window.waitForTimeout(3000);

    // ── 5. Verify session is gone ──
    const afterDelete = await window.evaluate(async (args: { pid: string }) => {
      const all = await (window as any).api.db.projects.list();
      const project = all.find((x: any) => x.id === args.pid);
      return {
        sessionCount: project?.sessions?.length ?? 0,
        sessions: project?.sessions?.map((s: any) => s.id) ?? [],
      };
    }, { pid: projectId });
    console.log(`✓ After delete: ${JSON.stringify(afterDelete)}`);
    // Session count may be beforeCount+1 if async hooks haven't finished deleting yet.
    // In that case wait for the async hook to complete.
    if (afterDelete.sessionCount > beforeCount) {
      console.log(`Waiting for async delete hooks to complete...`);
      await window.waitForTimeout(5000);
      const recheck = await window.evaluate(async (args: { pid: string }) => {
        const all = await (window as any).api.db.projects.list();
        const project = all.find((x: any) => x.id === args.pid);
        return {
          sessionCount: project?.sessions?.length ?? 0,
          sessions: project?.sessions?.map((s: any) => s.id) ?? [],
        };
      }, { pid: projectId });
      console.log(`✓ After wait: ${JSON.stringify(recheck)}`);
      expect(recheck.sessionCount).toBe(beforeCount);
    } else {
      expect(afterDelete.sessionCount).toBe(beforeCount);
    }
  });
});
