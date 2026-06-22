/**
 * Real-data-flow session lifecycle E2E.
 *
 * Walks the full chain end-to-end exactly the way a user would (via the
 * same `window.api.*` surface the renderer uses):
 *
 *   db:init → projects:create → projects:list (empty sessions)
 *     → sessions:create → await session:<id>:complete
 *     → assert filesystem (.agentdock/worktrees/<id> + .env)
 *     → assert DB row (ports, branch, worktreePath)
 *     → assert renderer-visible projects.list contains the session
 *     → sessions:rename (exercises git branch rename — 8ec663a fix)
 *     → assert DB row carries the renamed branch
 *     → sessions:delete → await complete via SSE-equivalent
 *     → assert filesystem + DB cleanup
 *     → projects:delete → assert no leftover state
 *
 * Runs the whole flow twice in the same spec to surface idempotency
 * bugs (cached daemon state, lingering WAL handles, repeated branch
 * collisions, etc.).
 *
 * Uses an isolated temp `agentdock.config.yaml` with no hooks so this
 * spec runs in <10s — the hook-execution path gets its own spec.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures/electron-fixture";
import {
  awaitSessionComplete,
  bootstrapHealth,
  createProject,
  createSession,
  deleteProject,
  deleteSession,
  initDb,
  listProjects,
  renameSession,
} from "./helpers/ipc";
import { dumpDb, dumpWorktreeTree } from "./helpers/dump";

function prepareGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  // The test runner needs git + a configured author for `commit --allow-empty`
  // — every CI image we target has them. If this throws the e2e is meant
  // to fail loudly (worktree creation requires a git repo).
  execSync("git init -q -b main", { cwd: dir });
  execSync('git -c user.email=e2e@local -c user.name=E2E commit --allow-empty -q -m init', {
    cwd: dir,
  });
}

function writeEmptyConfig(dir: string): void {
  // Force the loadConfig() path to pick this up (project root, NOT the
  // repo-root agentdock.config.yaml which has a `bun install` hook).
  writeFileSync(
    join(dir, "agentdock.config.yaml"),
    `version: "1"\nresources:\n  sync: []\nhooks: {}\n`,
    "utf-8",
  );
}

test.describe("session lifecycle (real data flow)", () => {
  test("create project → create + delete session twice; verify cleanup", async ({
    window,
    dataDir,
    mainLog,
    expectNoRendererErrors,
  }) => {
    // 1. Health check — confirms daemon + IPC layer are up.
    const health = await bootstrapHealth(window);
    expect(health.daemon).toBe("ok");
    expect(health.ipc).toBeGreaterThanOrEqual(30); // 29 original + sync:project

    // 2. Prepare a real git repo + empty config so this spec is hook-free.
    const projectPath = join(dataDir, "sample-project");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);

    // 3. Init DB against our temp project.
    await initDb(window, projectPath);

    // 4. Create the project row.
    const project = await createProject(window, {
      name: "e2e-lifecycle",
      path: projectPath,
    });
    expect(project.id).toMatch(/^[A-Za-z0-9_-]{4,}$/);

    // 5. Verify empty initial state.
    {
      const list = await listProjects(window);
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe(project.id);
      expect(list[0]!.sessions).toHaveLength(0);
    }

    // Two passes — second one catches idempotency / cache-staleness bugs.
    for (const pass of [1, 2]) {
      const sessionName = `feature-${pass}`;

      // 6. Kick off session creation. createSession() installs a
      //    page-side stream wrapper before invoking, so steps + complete
      //    are captured under window.__e2eSessionEvents[id].
      const { sessionId } = await createSession(window, {
        projectId: project.id,
        name: sessionName,
      });
      expect(sessionId).toMatch(/^[A-Za-z0-9_-]{4,}$/);

      // 7. Await the terminal completion event with generous timeout
      //    (no hooks = should finish in seconds, but git+IO has tails).
      const { steps, result } = await awaitSessionComplete(window, sessionId, 30_000);
      expect(result.success, `complete event: ${JSON.stringify(result)}`).toBe(true);

      // 8. Streamed step coverage — every canonical phase should have
      //    fired running → done. Errors at any step fail the assertion.
      const byStep = new Map<string, { running: boolean; done: boolean; error?: string }>();
      for (const s of steps) {
        const slot = byStep.get(s.step) ?? { running: false, done: false };
        if (s.status === "running") slot.running = true;
        if (s.status === "done") slot.done = true;
        if (s.status === "error") slot.error = s.error ?? "(no detail)";
        byStep.set(s.step, slot);
      }
      for (const required of [
        "beforeCreateSession",
        "createWorktree",
        "syncResources",
        "allocatePorts",
        "afterCreateSession",
      ]) {
        const slot = byStep.get(required);
        expect(slot, `missing step "${required}"`).toBeDefined();
        expect(slot!.error, `step "${required}" errored: ${slot!.error ?? ""}`).toBeUndefined();
        expect(slot!.running, `step "${required}" never reported running`).toBe(true);
        expect(slot!.done, `step "${required}" never reached done`).toBe(true);
      }

      // 9. Filesystem assertions — worktree on disk + .env populated.
      const worktreePath = join(projectPath, ".agentdock", "worktrees", sessionId);
      expect(existsSync(worktreePath), `worktree dir missing: ${worktreePath}`).toBe(true);
      // .git is a *file* (not dir) for git worktrees.
      expect(existsSync(join(worktreePath, ".git"))).toBe(true);
      const envPath = join(worktreePath, ".env");
      expect(existsSync(envPath), `.env missing: ${envPath}`).toBe(true);
      const envBody = readFileSync(envPath, "utf-8");
      expect(envBody, "FRONTEND_PORT not in .env").toMatch(/^FRONTEND_PORT=\d+/m);

      // 10. DB assertions — go straight to sqlite, bypass any caching.
      const db = dumpDb(projectPath);
      const dbRow = db.sessions.find((s) => s.id === sessionId);
      expect(dbRow, "session row missing").toBeDefined();
      expect(dbRow!.worktree_path).toBe(worktreePath);
      expect(dbRow!.branch).toBe(`agentdock/${sessionId}`);
      const persistedPorts = dbRow!.ports ? (JSON.parse(dbRow!.ports) as Record<string, number>) : null;
      expect(persistedPorts, "ports JSON missing in DB").not.toBeNull();
      expect(typeof persistedPorts!.FRONTEND_PORT).toBe("number");

      // 11. Renderer-visible projects.list contains this session.
      {
        const list = await listProjects(window);
        const sess = list[0]!.sessions.find((s) => s.id === sessionId);
        expect(sess, "renderer projects.list missing session").toBeDefined();
        expect(sess!.branch).toBe(`agentdock/${sessionId}`);
        expect(sess!.ports).toBeTruthy();
      }

      // 12. Rename → confirm git branch is renamed (8ec663a fix).
      const renamed = `renamed-${pass}`;
      const renameResult = await renameSession(window, sessionId, renamed);
      expect(renameResult.success).toBe(true);
      expect(renameResult.branch).toBe(`agentdock/${renamed}`);
      {
        const db2 = dumpDb(projectPath);
        const row2 = db2.sessions.find((s) => s.id === sessionId);
        expect(row2!.branch).toBe(`agentdock/${renamed}`);
        expect(row2!.name).toBe(renamed);
        // git itself should have the new branch. Use execFile (no shell)
        // so Windows cmd doesn't mangle the glob's quoting.
        const branches = execFileSync(
          "git",
          ["branch", "--list", "agentdock/*"],
          { cwd: projectPath, encoding: "utf-8" },
        );
        expect(branches).toContain(`agentdock/${renamed}`);
        expect(branches).not.toContain(`agentdock/${sessionId}`);
      }

      // 13. Delete — exercises SSE-equivalent streaming on session:delete
      //     (await fires when our handler sends `session:<id>:complete`).
      const deletePromise = (async () => {
        const tail = await awaitSessionComplete(window, sessionId, 30_000).catch((err) => {
          // If await fires before delete sends complete, we'll catch it
          // and bubble up — but the synchronous resolve from
          // `sessions:delete` below is the authoritative success signal.
          return { steps: [], result: { success: false, error: String(err) } };
        });
        return tail;
      })();
      const delResult = await deleteSession(window, sessionId);
      expect(delResult.success).toBe(true);
      // The complete event MAY have already fired (deleteSession resolved
      // after the handler sent it); if so, the await returns immediately.
      const deleteTail = await deletePromise;
      // Don't assert specific delete-stream steps here — the lifecycle's
      // `remove()` emits beforeDeleteSession/releasePorts/removeWorktree/
      // afterDeleteSession but they're optional from the renderer's POV.
      // What matters is no `error`-status step.
      const deleteErrors = deleteTail.steps.filter((s) => s.status === "error");
      expect(deleteErrors, JSON.stringify(deleteErrors)).toHaveLength(0);

      // 14. Cleanup assertions.
      expect(existsSync(worktreePath), `worktree dir leaked: ${worktreePath}`).toBe(false);
      {
        const db3 = dumpDb(projectPath);
        expect(db3.sessions.find((s) => s.id === sessionId), "DB row leaked").toBeUndefined();
      }
      {
        const list = await listProjects(window);
        expect(list[0]!.sessions.find((s) => s.id === sessionId)).toBeUndefined();
      }
      // The renamed branch should also be gone (8ec663a — the test that
      // makes sure a renamed session's branch doesn't dangle).
      const branchesAfter = execFileSync(
        "git",
        ["branch", "--list", "agentdock/*"],
        { cwd: projectPath, encoding: "utf-8" },
      );
      expect(branchesAfter).not.toContain(`agentdock/${renamed}`);
    }

    // 15. Delete the project itself; must clean up everything related.
    const delProj = await deleteProject(window, project.id);
    expect(delProj.deleted).toBe(0); // both sessions already gone
    {
      const list = await listProjects(window);
      expect(list).toHaveLength(0);
    }

    // 16. Surface diagnostic on failure of any subsequent step.
    if (mainLog.length === 0) {
      // No main-process output at all suggests Electron stderr piping
      // is broken — this would silently swallow daemon errors in CI.
      throw new Error("mainLog is empty — Electron stderr piping not capturing");
    }

    // 17. The dump helpers don't throw, so call them at the end and
    //     confirm they degrade gracefully when there's nothing to dump.
    //     `.agentdock/worktrees/` survives even after every session is
    //     gone (removeWorktree only deletes the per-session subdir),
    //     so just check the dump string lists no `agentdock/` entries.
    expect(dumpWorktreeTree(projectPath)).not.toMatch(/\bagentdock\//);
    expect(dumpDb(projectPath).sessions).toHaveLength(0);

    // Final: any console.error in the renderer means we missed a bug.
    expectNoRendererErrors();
  });
});
