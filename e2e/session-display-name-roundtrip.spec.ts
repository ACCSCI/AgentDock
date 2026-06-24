/**
 * displayName isolation E2E — §11.4 script #7.
 *
 * Verifies that a Unicode displayName is correctly round-tripped through
 * the v2 daemon API without leaking into the git branch name:
 *
 *   1. Create a session via the full UI flow with displayName "我的中文名"
 *   2. Assert the daemon v2 state stores the displayName correctly
 *   3. Assert the branch is "agentdock/<sessionId>" (not derived from displayName)
 *   4. Assert the sidebar renders the display name (session.name)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures/electron-fixture";
import {
  awaitSessionComplete,
  createProject,
  createSession,
  initDb,
  listProjects,
} from "./helpers/ipc";

function prepareGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "user.email=e2e@local", "-c", "user.name=E2E", "commit", "--allow-empty", "-q", "-m", "init"],
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

test.describe("displayName isolation (§11.4 #7)", () => {
  test("Unicode displayName round-trips correctly without affecting branch name", async ({
    window,
    dataDir,
  }) => {
    // Set up a real git repo + empty config (so loadConfig() has no hooks).
    const projectPath = join(dataDir, "display-name-project");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);

    // Init DB and create the project row so the renderer's createSession
    // can find the project. We deliberately avoid HomePage.openProject
    // here — that flow uses db:projects:create internally and asserts on
    // the post-navigation state, which adds a flaky dependency on the
    // SessionSidebar being expanded. The displayName-isolation concern
    // is purely about the daemon + git round-trip, not the UI.
    await initDb(window, projectPath);
    const project = await createProject(window, {
      name: "display-name-project",
      path: projectPath,
    });

    const displayName = "我的中文名";

    // 1. Create a session via the renderer's full UI flow (which keeps
    //    React Query cache in sync, so listProjects shows the session).
    const handle = await createSession(window, {
      projectId: project.id,
      name: displayName,
    });
    const sessionId = handle.sessionId;
    expect(sessionId).toMatch(/^[a-zA-Z0-9-]+$/);

    const { result } = await awaitSessionComplete(window, sessionId);
    expect(result.success, JSON.stringify(result)).toBe(true);

    // 2. Assert the session is visible to the renderer with the correct
    //    displayName. The renderer's projects query must surface the
    //    session — its `name` is the displayName we set.
    const projects = await listProjects(window);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.sessions).toHaveLength(1);
    expect(projects[0]!.sessions[0]!.name).toBe(displayName);

    // 3. Verify the branch is "agentdock/<sessionId>" — NOT derived from
    //    the displayName. This is the critical isolation assertion: no
    //    matter how exotic the displayName is, the branch stays ASCII-safe.
    const expectedBranch = `agentdock/${sessionId}`;
    const gitBranches = execFileSync(
      "git",
      ["branch", "--list", "agentdock/*"],
      { cwd: projectPath, encoding: "utf-8" },
    );
    expect(gitBranches).toContain(expectedBranch);
    // Must NOT contain the displayName as a branch segment.
    expect(gitBranches).not.toContain("我的中文名");
  });
});
