import { execSync } from "node:child_process";
/**
 * Real hook execution E2E.
 *
 * Verifies the `afterCreateSession` hook engine actually runs (not just
 * marks status). Uses a fast inline shell command (`echo` to a marker
 * file) so the spec doesn't depend on `bun install` or any network.
 *
 *   - `async: false` (sync): hook completes before sessions:create
 *     resolves. Marker file should exist immediately on success.
 *   - `async: true`: sessions:create resolves before hook finishes.
 *     `backgroundHookStatus` transitions running → completed; the
 *     marker file appears shortly after.
 *
 * If the hook fails (e.g. `exit 1`), the failure mode is checked by
 * a separate sub-test: `backgroundHookStatus` becomes "failed",
 * `backgroundHookErrors` carries exitCode/stderr details, and a
 * subsequent `sessions:retryHooks` re-runs the (now-fixed) hook.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures/electron-fixture";
import { dumpDb } from "./helpers/dump";
import {
  awaitSessionComplete,
  createProject,
  createSession,
  deleteSession,
  listProjects,
} from "./helpers/ipc";

function prepareGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -q -b main", { cwd: dir });
  execSync("git -c user.email=e2e@local -c user.name=E2E commit --allow-empty -q -m init", {
    cwd: dir,
  });
}

function writeHookConfig(
  dir: string,
  hook: {
    run: string;
    async?: boolean;
    required?: boolean;
    timeout?: number;
    cwd?: "worktree" | "project";
  },
): void {
  // Quote `run` literally so YAML doesn't try to parse special chars.
  // Avoid embedding JS source via `node -e` AND avoid quoted absolute
  // paths — Windows cmd's nested-quote handling around `cmd /c "node
  // "C:\path with spaces\x.js""` mangles the inner quotes, the script
  // never runs, and the engine reports success on an empty no-op.
  // Solution: pair every hook with `cwd: "project"` and a relative
  // script name (no spaces). YAML then just emits `node hook.js`.
  const lines = [
    'version: "1"',
    "resources:",
    "  sync: []",
    "hooks:",
    "  afterCreateSession:",
    `    - run: ${JSON.stringify(hook.run)}`,
    `      required: ${hook.required ?? false}`,
    `      timeout: ${hook.timeout ?? 30000}`,
    `      async: ${hook.async ?? false}`,
    `      cwd: ${hook.cwd ?? "project"}`,
    "",
  ];
  writeFileSync(join(dir, "agentdock.config.yaml"), lines.join("\n"), "utf-8");
}

/**
 * Write a one-off hook script into the project root and return the
 * `run` command that invokes it via a *relative* path (with no
 * special chars). Pair with `cwd: "project"` so the relative path
 * resolves against the project root.
 *
 * The roundabout `node -e` route can't work cross-platform: cmd's
 * nested-quote parsing eats the inner double-quotes and the script
 * becomes empty.
 */
function writeHookScript(projectDir: string, name: string, body: string): string {
  writeFileSync(join(projectDir, name), body, "utf-8");
  return `node ${name}`;
}

test.describe("afterCreateSession hook (real execution)", () => {
  test("sync hook writes marker file before create completes", async ({ window, dataDir }) => {
    const projectPath = join(dataDir, "hook-sync");
    prepareGitRepo(projectPath);
    // Hook runs with `cwd: project` (set by writeHookConfig) so
    // `marker.txt` lands at `<projectPath>/marker.txt`.
    const run = writeHookScript(
      projectPath,
      "hook-sync.js",
      `require("node:fs").writeFileSync("marker.txt", "sync-ran");`,
    );
    writeHookConfig(projectPath, { run, async: false });

    const project = await createProject(window, { name: "hook-sync", path: projectPath });
    const { sessionId } = await createSession(window, {
      projectId: project.id,
      name: "s",
    });
    const { result } = await awaitSessionComplete(window, sessionId, 30_000);
    expect(result.success, JSON.stringify(result)).toBe(true);

    const markerPath = join(projectPath, "marker.txt");
    expect(existsSync(markerPath), `sync hook never wrote ${markerPath}`).toBe(true);

    // backgroundHookStatus reflects the LAST observed afterCreateSession
    // step. For sync hooks the IPC handler still flips it to "completed"
    // on the `done` step event (it doesn't try to differentiate sync vs
    // async — the renderer treats either equivalently).
    const dump = dumpDb(dataDir);
    const row = dump.sessions.find((s) => s.id === sessionId);
    expect(
      row,
      `sessionId=${sessionId} missing; saw=${JSON.stringify(dump.sessions.map((s) => ({ id: s.id, projectId: s.project_id, status: s.background_hook_status })))}; projects=${JSON.stringify(dump.projects.map((p) => p.id))}`,
    ).toBeDefined();
    // Sync hook succeeded → status reached "completed", no errors.
    expect(row?.background_hook_status).toBe("completed");
    expect(row?.background_hook_errors).toBeNull();

    // Cleanup.
    await deleteSession(window, sessionId);
  });

  test("async hook completes in background, transitions running → completed", async ({
    window,
    dataDir,
  }) => {
    const projectPath = join(dataDir, "hook-async");
    prepareGitRepo(projectPath);
    // Sleep ~200ms so we can observe "running" before "completed".
    const run = writeHookScript(
      projectPath,
      "hook-async.js",
      `setTimeout(() => require("node:fs").writeFileSync("marker.txt", "async-ran"), 200);`,
    );
    writeHookConfig(projectPath, { run, async: true });

    const project = await createProject(window, { name: "hook-async", path: projectPath });
    const { sessionId } = await createSession(window, {
      projectId: project.id,
      name: "s",
    });
    // sessions:create resolves once the lifecycle's main path finishes;
    // the async afterCreateSession hook is still running.
    const { result } = await awaitSessionComplete(window, sessionId, 30_000);
    expect(result.success).toBe(true);

    // backgroundHookStatus should transition to "completed" within a
    // few seconds. Poll the DB directly (the renderer also polls this
    // via `useBackgroundHookStatus` every 2 s).
    await expect
      .poll(
        () => {
          const dump = dumpDb(dataDir);
          const row = dump.sessions.find((s) => s.id === sessionId);
          if (!row) {
            return `<no row; saw=${JSON.stringify(dump.sessions.map((s) => s.id))}>`;
          }
          return row.background_hook_status ?? "<null>";
        },
        { timeout: 10_000, message: "async hook never reached 'completed' state" },
      )
      .toBe("completed");

    const markerPath = join(projectPath, "marker.txt");
    expect(existsSync(markerPath), `async hook never wrote ${markerPath}`).toBe(true);

    await deleteSession(window, sessionId);
  });

  test("failing hook → status=failed + retryHooks re-runs successfully", async ({
    window,
    dataDir,
  }) => {
    const projectPath = join(dataDir, "hook-fail");
    prepareGitRepo(projectPath);
    // Hook exits non-zero — should land as backgroundHookStatus="failed"
    // with backgroundHookErrors carrying exitCode/stderr.
    // Use async:true because sync required-hook failures would tear
    // the worktree down (testing retry needs the session to survive).
    const failRun = writeHookScript(
      projectPath,
      "hook-fail.js",
      // Write a "ran" marker into the project dir before exiting so we
      // can prove the hook actually executed even when the engine
      // misreports the exit code.
      `require("node:fs").appendFileSync(${JSON.stringify(join(projectPath, "ran.log"))}, "ran-fail\\n");\nprocess.stderr.write("boom");\nprocess.exit(7);`,
    );
    writeHookConfig(projectPath, { run: failRun, async: true });

    const project = await createProject(window, { name: "hook-fail", path: projectPath });
    const { sessionId } = await createSession(window, {
      projectId: project.id,
      name: "s",
    });
    const { result } = await awaitSessionComplete(window, sessionId, 30_000);
    expect(result.success).toBe(true); // Lifecycle succeeds; async hook fails in bg.

    // Wait for the background failure to land in DB. Column names from
    // raw SQLite are snake_case (not Drizzle's camelCase view).
    await expect
      .poll(
        () => dumpDb(dataDir).sessions.find((s) => s.id === sessionId)?.background_hook_status,
        { timeout: 10_000, message: "hook never reached 'failed' state" },
      )
      .toBe("failed");

    const failedRow = dumpDb(dataDir).sessions.find((s) => s.id === sessionId);
    expect(failedRow?.background_hook_errors).toBeTruthy();
    const errors = JSON.parse(failedRow?.background_hook_errors!) as Array<{
      exitCode: number | null;
      stderr?: string;
    }>;
    expect(errors).toHaveLength(1);
    expect(errors[0].exitCode).toBe(7);
    expect(errors[0].stderr ?? "").toContain("boom");

    // Now fix the config and retry — hook should succeed and status
    // transitions failed → running → completed.
    const retryRun = writeHookScript(
      projectPath,
      "hook-retry.js",
      `require("node:fs").writeFileSync("marker.txt", "retry-ok");`,
    );
    writeHookConfig(projectPath, { run: retryRun, async: true });
    await window.evaluate(
      (id: string) =>
        (
          window as unknown as {
            api: { sessions: { retryHooks: (id: string) => Promise<unknown> } };
          }
        ).api.sessions.retryHooks(id),
      sessionId,
    );

    await expect
      .poll(
        () => dumpDb(dataDir).sessions.find((s) => s.id === sessionId)?.background_hook_status,
        { timeout: 10_000, message: "retried hook never reached 'completed'" },
      )
      .toBe("completed");

    const markerPath = join(projectPath, "marker.txt");
    expect(existsSync(markerPath), "retry hook never wrote marker").toBe(true);

    // backgroundHookErrors should be cleared after a successful retry.
    const afterRetry = dumpDb(dataDir).sessions.find((s) => s.id === sessionId);
    expect(afterRetry?.background_hook_errors).toBeNull();

    await deleteSession(window, sessionId);

    // Sanity: confirm renderer-visible projects.list shows zero sessions.
    const projects = await listProjects(window);
    const p = projects.find((x) => x.id === project.id);
    expect(p?.sessions ?? []).toHaveLength(0);
  });
});
