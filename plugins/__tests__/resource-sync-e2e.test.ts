// @ts-nocheck
/**
 * E2E tests for resource sync — verifies directory sync through the
 * session-lifecycle orchestrator (full pipeline: worktree → sync → ports).
 *
 * These tests create a real git project + agentdock.config.yaml with directory
 * sync resources, then exercise lifecycle.create() to verify directories are
 * correctly synced to the worktree.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSessionLifecycle, type PortService } from "../session-lifecycle.js";

// --- Mock PortService ---
let nextPort = 30000;
const mockPortService: PortService = {
  async allocateSession() {
    return {
      FRONTEND_PORT: nextPort++,
      BACKEND_PORT: nextPort++,
      WS_PORT: nextPort++,
      DEBUG_PORT: nextPort++,
      PREVIEW_PORT: nextPort++,
    };
  },
  async releaseSession() {
    // no-op
  },
};

// --- Test fixture ---
interface Fixture {
  projectDir: string;
  worktreeBase: string;
}

function createFixture(): Fixture {
  const id = `sync-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const projectDir = path.join(os.tmpdir(), id);
  mkdirSync(projectDir, { recursive: true });
  const worktreeBase = path.join(projectDir, ".agentdock", "worktrees");
  mkdirSync(worktreeBase, { recursive: true });
  return { projectDir, worktreeBase };
}

function initGitRepo(dir: string) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: dir, stdio: "pipe" });
}

function createSourceDir(projectDir: string): void {
  const uploadsDir = path.join(projectDir, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  writeFileSync(path.join(uploadsDir, "a.txt"), "file-a");
  writeFileSync(path.join(uploadsDir, "b.txt"), "file-b");
  // Nested subdirectory
  const nestedDir = path.join(uploadsDir, "sub");
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(path.join(nestedDir, "nested.txt"), "nested-content");
}

function createConfig(projectDir: string): void {
  const config = `version: "1"
resources:
  sync:
    - source: "uploads/"
      strategy: "overwrite"
    - source: "uploads/"
      strategy: "skip"
      skipIfMissing: true
hooks: {}
`;
  writeFileSync(path.join(projectDir, "agentdock.config.yaml"), config, "utf-8");
}

function cleanup(fixture: Fixture) {
  // Remove worktree paths that were created
  const wtBase = path.join(fixture.projectDir, ".agentdock", "worktrees");
  if (existsSync(wtBase)) {
    for (const entry of readdirSync(wtBase)) {
      const wtPath = path.join(wtBase, entry);
      try { rmSync(wtPath, { recursive: true, force: true }); } catch {}
    }
  }
  // Remove branches created by test
  try {
    execSync("git branch -D agentdock/e2e-test-session 2>/dev/null || true", {
      cwd: fixture.projectDir,
      stdio: "pipe",
    });
  } catch {}
  // Remove project dir
  rmSync(fixture.projectDir, { recursive: true, force: true });
}

// Remove git worktree via git command
function gitWorktreeRemove(projectDir: string, worktreePath: string) {
  try {
    execSync(`git worktree remove --force "${worktreePath}" 2>/dev/null || true`, {
      cwd: projectDir,
      stdio: "pipe",
    });
  } catch {}
  // Also try branch deletion
  try {
    execSync("git branch -D agentdock/e2e-test-session 2>/dev/null || true", {
      cwd: projectDir,
      stdio: "pipe",
    });
  } catch {}
}

// ============================================================
// E2E Tests
// ============================================================
describe("E2E: 资源同步 — 目录同步全流程", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    cleanup(fixture);
  });

  it("E2E-1: overwrite 策略同步目录及其嵌套子目录到 worktree", async () => {
    const { projectDir } = fixture;
    initGitRepo(projectDir);
    createSourceDir(projectDir);

    // Create config with only overwrite
    const config = `version: "1"
resources:
  sync:
    - source: "uploads/"
      strategy: "overwrite"
hooks: {}
`;
    writeFileSync(path.join(projectDir, "agentdock.config.yaml"), config, "utf-8");

    const { loadConfig } = await import("../config.js");
    const cfg = loadConfig(projectDir);

    const lifecycle = createSessionLifecycle({ portService: mockPortService });

    const result = await lifecycle.create({
      projectId: "e2e-test",
      projectPath: projectDir,
      sessionId: "e2e-test-session",
      sessionName: "E2E Test",
      config: cfg,
    });

    // Verify sync report
    expect(result.syncReport.success).toBe(true);
    expect(result.syncReport.results).toHaveLength(1);
    expect(result.syncReport.results[0].action).toBe("copied");

    // Verify directory content synced
    const wtUploads = path.join(result.worktreePath, "uploads");
    expect(existsSync(wtUploads)).toBe(true);
    expect(readFileSync(path.join(wtUploads, "a.txt"), "utf-8")).toBe("file-a");
    expect(readFileSync(path.join(wtUploads, "b.txt"), "utf-8")).toBe("file-b");

    // Verify nested subdirectory synced
    expect(existsSync(path.join(wtUploads, "sub"))).toBe(true);
    expect(readFileSync(path.join(wtUploads, "sub", "nested.txt"), "utf-8")).toBe("nested-content");

    // Cleanup git worktree (lifecycle.remove also works but needs daemon)
    gitWorktreeRemove(projectDir, result.worktreePath);
  });

  it("E2E-2: skip 策略在目标不存在时复制目录", async () => {
    const { projectDir } = fixture;
    initGitRepo(projectDir);
    createSourceDir(projectDir);

    const config = `version: "1"
resources:
  sync:
    - source: "uploads/"
      strategy: "skip"
hooks: {}
`;
    writeFileSync(path.join(projectDir, "agentdock.config.yaml"), config, "utf-8");

    const { loadConfig } = await import("../config.js");
    const cfg = loadConfig(projectDir);

    const lifecycle = createSessionLifecycle({ portService: mockPortService });

    const result = await lifecycle.create({
      projectId: "e2e-test",
      projectPath: projectDir,
      sessionId: "e2e-test-session",
      sessionName: "E2E Skip Dir",
      config: cfg,
    });

    expect(result.syncReport.success).toBe(true);
    expect(result.syncReport.results[0].action).toBe("copied");

    const wtUploads = path.join(result.worktreePath, "uploads");
    expect(readFileSync(path.join(wtUploads, "a.txt"), "utf-8")).toBe("file-a");

    gitWorktreeRemove(projectDir, result.worktreePath);
  });

  it("E2E-3: merge 策略合并目录到 worktree（不删除目标已有文件）", async () => {
    const { projectDir } = fixture;
    initGitRepo(projectDir);
    createSourceDir(projectDir);

    const config = `version: "1"
resources:
  sync:
    - source: "uploads/"
      strategy: "merge"
hooks: {}
`;
    writeFileSync(path.join(projectDir, "agentdock.config.yaml"), config, "utf-8");

    const { loadConfig } = await import("../config.js");
    const cfg = loadConfig(projectDir);

    const lifecycle = createSessionLifecycle({ portService: mockPortService });

    const result = await lifecycle.create({
      projectId: "e2e-test",
      projectPath: projectDir,
      sessionId: "e2e-test-session",
      sessionName: "E2E Merge Dir",
      config: cfg,
    });

    expect(result.syncReport.success).toBe(true);
    expect(result.syncReport.results[0].action).toBe("copied");

    const wtUploads = path.join(result.worktreePath, "uploads");
    expect(readFileSync(path.join(wtUploads, "a.txt"), "utf-8")).toBe("file-a");
    expect(readFileSync(path.join(wtUploads, "sub", "nested.txt"), "utf-8")).toBe("nested-content");

    gitWorktreeRemove(projectDir, result.worktreePath);
  });

  it("E2E-4: 多策略混合同步全部成功", async () => {
    const { projectDir } = fixture;
    initGitRepo(projectDir);
    createSourceDir(projectDir);

    // Also create a standalone file
    writeFileSync(path.join(projectDir, ".env"), "NODE_ENV=development\n");

    const config = `version: "1"
resources:
  sync:
    - source: "uploads/"
      strategy: "overwrite"
    - source: ".env"
      strategy: "merge"
hooks: {}
`;
    writeFileSync(path.join(projectDir, "agentdock.config.yaml"), config, "utf-8");

    const { loadConfig } = await import("../config.js");
    const cfg = loadConfig(projectDir);

    const lifecycle = createSessionLifecycle({ portService: mockPortService });

    const result = await lifecycle.create({
      projectId: "e2e-test",
      projectPath: projectDir,
      sessionId: "e2e-test-session",
      sessionName: "E2E Mixed",
      config: cfg,
    });

    expect(result.syncReport.success).toBe(true);
    expect(result.syncReport.results).toHaveLength(2);
    expect(result.syncReport.results.every((r) => r.success)).toBe(true);

    // Verify directory
    const wtUploads = path.join(result.worktreePath, "uploads");
    expect(readFileSync(path.join(wtUploads, "a.txt"), "utf-8")).toBe("file-a");

    // Verify file
    expect(readFileSync(path.join(result.worktreePath, ".env"), "utf-8")).toContain("NODE_ENV=development");

    gitWorktreeRemove(projectDir, result.worktreePath);
  });

  it("E2E-5: 空资源列表不报错", async () => {
    const { projectDir } = fixture;
    initGitRepo(projectDir);

    const config = `version: "1"
resources:
  sync: []
hooks: {}
`;
    writeFileSync(path.join(projectDir, "agentdock.config.yaml"), config, "utf-8");

    const { loadConfig } = await import("../config.js");
    const cfg = loadConfig(projectDir);

    const lifecycle = createSessionLifecycle({ portService: mockPortService });

    const result = await lifecycle.create({
      projectId: "e2e-test",
      projectPath: projectDir,
      sessionId: "e2e-test-session",
      sessionName: "E2E Empty",
      config: cfg,
    });

    expect(result.syncReport.success).toBe(true);
    expect(result.syncReport.results).toEqual([]);

    gitWorktreeRemove(projectDir, result.worktreePath);
  });
});
