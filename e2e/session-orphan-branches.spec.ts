/**
 * Orphan branch scan + delete E2E.
 *
 * Reproduces the 8ec663a fix's UI path end-to-end:
 *   1. Open project, create a session (yields `agentdock/<sessionId>` branch)
 *   2. Manually create a dangling `agentdock/abandoned` branch via git
 *   3. Call `worktree:orphans` — should return the dangling branch with
 *      `reason: "orphan-branch"`, NOT the live session's branch
 *   4. Call `worktree:deleteOrphans` with `{branches: [...]}` — should
 *      remove only the dangling branch
 *   5. Verify via `git branch --list` that the live branch survives
 *      and the dangling one is gone
 *
 * This is the path the master `POST /api/orphans/delete` body supports
 * (`{paths?, branches?, projectId?}`) but the Electron version
 * previously couldn't handle — the renderer would 4xx on any branch
 * delete from `OrphanCleanModal`.
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures/electron-fixture";
import { awaitSessionComplete, createSession, deleteOrphans, listOrphans } from "./helpers/ipc";
import { HomePage } from "./pages/home";
import { SidebarPage } from "./pages/sidebar";

function prepareGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -q -b main", { cwd: dir });
  execSync("git -c user.email=e2e@local -c user.name=E2E commit --allow-empty -q -m init", {
    cwd: dir,
  });
}

function writeEmptyConfig(dir: string): void {
  writeFileSync(
    join(dir, "agentdock.config.yaml"),
    `version: "1"\nresources:\n  sync: []\nhooks: {}\n`,
    "utf-8",
  );
}

function listAgentdockBranches(projectPath: string): string[] {
  // execFile (no shell) — Windows cmd mangles the `'agentdock/*'`
  // glob via its single-quote handling otherwise.
  const out = execFileSync("git", ["branch", "--list", "agentdock/*"], {
    cwd: projectPath,
    encoding: "utf-8",
  });
  return (
    out
      .split(/\r?\n/)
      // `git branch --list` prefixes each line with a status marker:
      //   "  branch"   = local
      //   "* branch"   = current branch (HEAD)
      //   "+ branch"   = checked out in a registered worktree
      // Strip whichever marker is present plus the trailing space.
      .map((l) => l.replace(/^[*+]?\s+/, "").trim())
      .filter((l) => l.length > 0)
  );
}

test.describe("orphan branch scan + delete", () => {
  test("flags dangling agentdock/* branches; deleteOrphans({branches}) removes only those", async ({
    window,
    dataDir,
  }) => {
    const projectPath = join(dataDir, "orphan-project");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);

    // 1. Open project via UI so `db:projects:create` fires through the
    //    real renderer flow. The worktree:orphans handler needs the
    //    `activeProjectPath` set + a known project row in the DB so
    //    its `knownBranches` set excludes live sessions.
    const home = new HomePage(window);
    await home.openProject(projectPath);
    const sidebar = new SidebarPage(window);
    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });

    // 2. Look up the projectId via the IPC so the orphans+delete
    //    handlers can scope correctly. The renderer just opened it; we
    //    grab it from `db:projects:list`.
    const projects = (await window.evaluate(() =>
      (
        window as unknown as {
          api: { db: { projects: { list: () => Promise<unknown[]> } } };
        }
      ).api.db.projects.list(),
    )) as Array<{ id: string; path: string; sessions: unknown[] }>;
    const project = projects.find((p) => p.path === projectPath);
    expect(project, `project ${projectPath} not found in DB`).toBeDefined();
    if (!project) throw new Error(`project ${projectPath} not found in DB`);

    // 3. Create a live session through the IPC helper — this gives us
    //    a real `agentdock/<sessionId>` branch that should NOT show
    //    up in the orphans scan.
    const { sessionId } = await createSession(window, {
      projectId: project.id,
      name: "live",
    });
    const { result } = await awaitSessionComplete(window, sessionId, 30_000);
    expect(result.success, JSON.stringify(result)).toBe(true);
    const liveBranch = `agentdock/${sessionId}`;

    // 4. Manually create a dangling branch — no worktree, no DB row.
    //    This is the bug 8ec663a fixed (sessions renamed-then-deleted
    //    left their original branch behind).
    const danglingBranch = "agentdock/abandoned-by-test";
    execFileSync("git", ["branch", danglingBranch, "main"], {
      cwd: projectPath,
    });
    const allBefore = listAgentdockBranches(projectPath);
    expect(allBefore).toContain(liveBranch);
    expect(allBefore).toContain(danglingBranch);

    // 5. worktree:orphans must list the dangling branch with
    //    reason="orphan-branch" and MUST NOT list the live one.
    //    Pass the projectId explicitly — the handler's "active project"
    //    fallback points at launch cwd, not at the user-chosen project,
    //    so multi-project setups need the explicit param to scope.
    const orphans = await listOrphans(window, project?.id);
    const orphanBranches = orphans.filter((o) => o.reason === "orphan-branch");
    expect(
      orphanBranches.map((o) => o.branch),
      `orphan-branch scan saw: ${JSON.stringify(orphans, null, 2)}`,
    ).toEqual([danglingBranch]);
    expect(
      orphans.find((o) => o.branch === liveBranch),
      "live session's branch was wrongly flagged as orphan",
    ).toBeUndefined();

    // 6. deleteOrphans with `{branches}` body — the body shape that
    //    the previous Electron version refused (it only took `paths`).
    const delResult = await deleteOrphans(window, {
      branches: [danglingBranch],
      projectId: project?.id,
    });
    expect(delResult.deleted).toContain(danglingBranch);
    expect(
      delResult.failed,
      `deleteOrphans had failures: ${JSON.stringify(delResult.failed)}`,
    ).toHaveLength(0);

    // 7. After delete: live branch survives, dangling gone.
    const allAfter = listAgentdockBranches(projectPath);
    expect(allAfter).toContain(liveBranch);
    expect(allAfter).not.toContain(danglingBranch);

    // 8. Another scan should now return empty for orphan-branches.
    const orphansAfter = await listOrphans(window, project?.id);
    expect(orphansAfter.filter((o) => o.reason === "orphan-branch")).toHaveLength(0);

    // 9. Safety: deleteOrphans must REFUSE non-agentdock branches
    //    even if a caller tries (the master fix added strict prefix
    //    validation via `validateBranchName` + the agentdock/ prefix).
    execFileSync("git", ["branch", "rogue/sneaky", "main"], { cwd: projectPath });
    const rogueDelete = await deleteOrphans(window, {
      branches: ["rogue/sneaky"],
      projectId: project?.id,
    });
    expect(rogueDelete.deleted, "rogue branch should NOT have been deleted").not.toContain(
      "rogue/sneaky",
    );
    expect(rogueDelete.failed.find((f) => f.branch === "rogue/sneaky")).toBeDefined();
    expect(
      listAgentdockBranches(projectPath).concat(
        execFileSync("git", ["branch", "--list", "rogue/*"], {
          cwd: projectPath,
          encoding: "utf-8",
        })
          .split(/\r?\n/)
          .map((l) => l.replace(/^[*+]?\s+/, "").trim())
          .filter(Boolean),
      ),
    ).toContain("rogue/sneaky");
  });
});
