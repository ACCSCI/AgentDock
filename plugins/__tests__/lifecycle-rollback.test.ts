import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createSessionLifecycle, type PortService, type StepEvent } from "../session-lifecycle.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const isWin = process.platform === "win32";
function exitCmd(code: number) { return isWin ? `cmd /c exit ${code}` : `exit ${code}`; }
function echoCmd(msg: string) { return `echo ${msg}`; }

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `lifecycle-rollback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function mockPortService(opts?: {
  allocateShouldFail?: boolean;
  releaseShouldFail?: boolean;
}): { service: PortService; released: string[] } {
  let portCounter = 40000;
  const released: string[] = [];

  return {
    released,
    service: {
      async allocateSession({ sessionId }) {
        if (opts?.allocateShouldFail) throw new Error("allocate failed");
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
        if (opts?.releaseShouldFail) throw new Error("release failed");
        released.push(sessionId);
      },
    },
  };
}

const emptyConfig = {
  hooks: {},
  resources: { sync: [] },
} as any;

describe("Session lifecycle rollback", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    initGitRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("BUG-1 fix: syncResources failure releases ports", async () => {
    const { service: portService, released } = mockPortService();

    // Create a config that will cause syncResources to fail (bad resource path)
    const badConfig = {
      hooks: {},
      resources: {
        sync: [{ source: "/nonexistent/path", target: "dest" }],
      },
    } as any;

    const lifecycle = createSessionLifecycle({ portService });

    await expect(
      lifecycle.create({
        projectId: "p1",
        projectPath: dir,
        sessionId: "sess-rollback-1",
        sessionName: "Test",
        config: badConfig,
      }),
    ).rejects.toThrow();

    // Port should have been released during rollback
    expect(released).toContain("sess-rollback-1");
  });

  it("afterCreateSession hook failure (sync) releases ports and removes worktree", async () => {
    const { service: portService, released } = mockPortService();

    const config = {
      hooks: {
        afterCreateSession: [
          { run: exitCmd(1), required: true, timeout: 30000, cwd: "worktree" },
        ],
      },
      resources: { sync: [] },
    } as any;

    const lifecycle = createSessionLifecycle({ portService });

    await expect(
      lifecycle.create({
        projectId: "p1",
        projectPath: dir,
        sessionId: "sess-hook-fail",
        sessionName: "Test",
        config,
      }),
    ).rejects.toThrow("afterCreateSession hook failed");

    expect(released).toContain("sess-hook-fail");
  });

  it("afterCreateSession async hook failure does NOT rollback", async () => {
    const { service: portService } = mockPortService();

    const config = {
      hooks: {
        afterCreateSession: [
          { run: exitCmd(1), async: true, required: false, timeout: 30000, cwd: "worktree" },
        ],
      },
      resources: { sync: [] },
    } as any;

    const lifecycle = createSessionLifecycle({ portService });

    const result = await lifecycle.create({
      projectId: "p1",
      projectPath: dir,
      sessionId: "sess-async-fail",
      sessionName: "Test",
      config,
    });

    // Session should be created successfully (no rollback for async hooks)
    expect(result.sessionId).toBe("sess-async-fail");
    expect(result.worktreePath).toBeTruthy();
    expect(existsSync(result.worktreePath)).toBe(true);

    // Background hook should complete
    const hookReport = await result.backgroundHookPromise;
    // Individual hook result should indicate failure
    expect(hookReport.results[0].success).toBe(false);
  });

  it("portService.allocateSession failure removes worktree", async () => {
    const { service: portService } = mockPortService({ allocateShouldFail: true });

    const lifecycle = createSessionLifecycle({ portService });

    await expect(
      lifecycle.create({
        projectId: "p1",
        projectPath: dir,
        sessionId: "sess-alloc-fail",
        sessionName: "Test",
        config: emptyConfig,
      }),
    ).rejects.toThrow("allocate failed");

    // Worktree should be cleaned up
    const worktreePath = path.join(dir, ".agentdock", "worktrees", "sess-alloc-fail");
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("portService.releaseSession failure in rollback is caught", async () => {
    const { service: portService } = mockPortService({ releaseShouldFail: true });

    const config = {
      hooks: {
        afterCreateSession: [
          { run: exitCmd(1), required: true, timeout: 30000, cwd: "worktree" },
        ],
      },
      resources: { sync: [] },
    } as any;

    const lifecycle = createSessionLifecycle({ portService });

    // Should still throw the original error, not the release error
    await expect(
      lifecycle.create({
        projectId: "p1",
        projectPath: dir,
        sessionId: "sess-release-fail",
        sessionName: "Test",
        config,
      }),
    ).rejects.toThrow("afterCreateSession hook failed");
  });

  it("beforeCreateSession hook failure: no resources created", async () => {
    const { service: portService, released } = mockPortService();

    const config = {
      hooks: {
        beforeCreateSession: [
          { run: exitCmd(1), required: true, timeout: 30000, cwd: "worktree" },
        ],
      },
      resources: { sync: [] },
    } as any;

    const lifecycle = createSessionLifecycle({ portService });

    await expect(
      lifecycle.create({
        projectId: "p1",
        projectPath: dir,
        sessionId: "sess-before-fail",
        sessionName: "Test",
        config,
      }),
    ).rejects.toThrow("beforeCreateSession hook failed");

    // No worktree should exist
    const worktreePath = path.join(dir, ".agentdock", "worktrees", "sess-before-fail");
    expect(existsSync(worktreePath)).toBe(false);

    // No ports should have been allocated (hook fails before port allocation)
    expect(released).toHaveLength(0);
  });

  it("remove with non-existent worktree still releases ports", async () => {
    const { service: portService, released } = mockPortService();

    const lifecycle = createSessionLifecycle({ portService });

    const result = await lifecycle.remove({
      sessionId: "sess-ghost",
      projectPath: dir,
      worktreePath: "/nonexistent/path",
      config: emptyConfig,
    });

    expect(result.success).toBe(true);
    expect(released).toContain("sess-ghost");
  });

  it("onStep callback receives running and done events", async () => {
    const { service: portService } = mockPortService();
    const steps: StepEvent[] = [];

    const lifecycle = createSessionLifecycle({ portService });

    await lifecycle.create({
      projectId: "p1",
      projectPath: dir,
      sessionId: "sess-steps",
      sessionName: "Test",
      config: emptyConfig,
      onStep: (e) => steps.push({ ...e }),
    });

    const stepNames = steps.map((s) => s.step);
    expect(stepNames).toContain("beforeCreateSession");
    expect(stepNames).toContain("createWorktree");
    expect(stepNames).toContain("syncResources");
    expect(stepNames).toContain("allocatePorts");
    expect(stepNames).toContain("afterCreateSession");

    // Each step should have both "running" and "done" events
    const uniqueSteps = [...new Set(stepNames)];
    for (const name of uniqueSteps) {
      const events = steps.filter((s) => s.step === name);
      const statuses = events.map((e) => e.status);
      expect(statuses).toContain("running");
      expect(statuses).toContain("done");
    }
  });

  it("BUG-1 fix: outer catch releases ports even when portService.releaseSession is called", async () => {
    const { service: portService, released } = mockPortService();

    // Config with bad resource sync to trigger outer catch
    const badConfig = {
      hooks: {},
      resources: {
        sync: [{ source: "/nonexistent/path", target: "dest" }],
      },
    } as any;

    const lifecycle = createSessionLifecycle({ portService });

    await expect(
      lifecycle.create({
        projectId: "p1",
        projectPath: dir,
        sessionId: "sess-outer-catch",
        sessionName: "Test",
        config: badConfig,
      }),
    ).rejects.toThrow();

    // The outer catch should call releaseSession
    expect(released).toContain("sess-outer-catch");
  });
});
