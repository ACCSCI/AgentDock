// @ts-nocheck
/**
 * v2 rollback test — post-fix-iterations.md item #1.
 *
 * Verifies the full rollback chain when syncResources fails during
 * session creation:
 *   1. Ports allocated by v2PortService.allocateSession() are released
 *   2. Worktree created by createWorktree() is deleted
 *   3. completeDeletion() is called to purge the three-table row
 *
 * This covers the gap identified in §4.2: "syncResources failure must
 * release ports + clean up the half-built worktree + call completeDeletion".
 */
import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
} from "vitest";
import {
  createSessionLifecycle,
  type PortService,
} from "../session-lifecycle.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `v2-rollback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initGitRepo(dir: string) {
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name test", { cwd: dir, stdio: "ignore" });
  writeFileSync(path.join(dir, "README.md"), "# test");
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
}

function mockV2PortService(opts?: {
  allocateShouldFail?: boolean;
  releaseShouldFail?: boolean;
  completeDeletionShouldThrow?: boolean;
}): {
  service: PortService;
  released: string[];
  deleted: string[];
} {
  let portCounter = 40000;
  const released: string[] = [];
  const deleted: string[] = [];

  return {
    released,
    deleted,
    service: {
      async allocateSession({ sessionId }) {
        if (opts?.allocateShouldFail) {
          throw new Error("allocateSession failed");
        }
        const base = portCounter;
        portCounter += 5;
        return {
          FRONTEND_PORT: base,
          BACKEND_PORT: base + 1,
          WS_PORT: base + 2,
          DEBUG_PORT: base + 3,
          PREVIEW_PORT: base + 4,
        };
      },
      async releaseSession(sessionId) {
        if (opts?.releaseShouldFail) {
          throw new Error("releaseSession failed");
        }
        released.push(sessionId);
      },
      async completeDeletion(sessionId) {
        deleted.push(sessionId);
        if (opts?.completeDeletionShouldThrow) {
          throw new Error("completeDeletion failed");
        }
      },
    },
  };
}

// Config that triggers syncResources failure (missing source, skipIfMissing=false)
const BAD_SYNC_CONFIG = {
  hooks: {},
  resources: {
    sync: [{ source: "/__nonexistent_path__", target: "dest", skipIfMissing: false }],
  },
} as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("v2 rollback — syncResources failure", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    initGitRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("syncResources failure → ports released + worktree deleted + completeDeletion called", async () => {
    const { service, released, deleted } = mockV2PortService();
    const lifecycle = createSessionLifecycle({ portService: service });

    await expect(
      lifecycle.create({
        projectId: "p1",
        projectPath: dir,
        sessionId: "sess-v2-rollback",
        sessionName: "v2-rollback-test",
        config: BAD_SYNC_CONFIG,
      }),
    ).rejects.toThrow();

    // 1. Ports should have been released
    expect(released).toContain("sess-v2-rollback");

    // 2. Worktree should have been cleaned up
    const worktreePath = path.join(
      dir,
      ".agentdock",
      "worktrees",
      "sess-v2-rollback",
    );
    expect(existsSync(worktreePath)).toBe(false);

    // 3. completeDeletion should have been called (v2-specific rollback)
    expect(deleted).toContain("sess-v2-rollback");
  });

  it("syncResources failure + completeDeletion throws → ports still released (error caught internally)", async () => {
    const { service, released, deleted } = mockV2PortService({
      completeDeletionShouldThrow: true,
    });
    const lifecycle = createSessionLifecycle({ portService: service });

    await expect(
      lifecycle.create({
        projectId: "p1",
        projectPath: dir,
        sessionId: "sess-v2-partial-fail",
        sessionName: "v2-partial-fail-test",
        config: BAD_SYNC_CONFIG,
      }),
    ).rejects.toThrow();

    // releaseSession is called BEFORE completeDeletion in the rollback chain
    expect(released).toContain("sess-v2-partial-fail");

    // completeDeletion was attempted (and failed, but that's caught internally)
    expect(deleted).toContain("sess-v2-partial-fail");
  });

  it("allocateSession failure → worktree deleted + completeDeletion called", async () => {
    const { service, released, deleted } = mockV2PortService({
      allocateShouldFail: true,
    });
    const lifecycle = createSessionLifecycle({ portService: service });

    await expect(
      lifecycle.create({
        projectId: "p1",
        projectPath: dir,
        sessionId: "sess-alloc-fail-v2",
        sessionName: "alloc-fail-v2-test",
        config: { hooks: {}, resources: { sync: [] } } as any,
      }),
    ).rejects.toThrow("allocateSession failed");

    // releaseSession is always called in the catch block (idempotent)
    expect(released).toContain("sess-alloc-fail-v2");

    // Worktree should be cleaned up
    const worktreePath = path.join(
      dir,
      ".agentdock",
      "worktrees",
      "sess-alloc-fail-v2",
    );
    expect(existsSync(worktreePath)).toBe(false);

    // completeDeletion should have been called
    expect(deleted).toContain("sess-alloc-fail-v2");
  });
});
