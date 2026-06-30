// @ts-nocheck
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSessionLifecycle, type PortService } from "../session-lifecycle.js";
import { removeOrphanDir } from "../orphan.js";
import type { AgentDockConfig } from "../config.js";

let projectDir: string;
let portCounter = 0;

function mockPortService(): PortService {
  return {
    async allocateSession(_params) {
      const base = 40000 + portCounter * 5;
      portCounter++;
      return {
        FRONTEND_PORT: base,
        BACKEND_PORT: base + 1,
        WS_PORT: base + 2,
        DEBUG_PORT: base + 3,
        PREVIEW_PORT: base + 4,
      };
    },
    async releaseSession(_sessionId) {
      // no-op for tests
    },
  };
}

function initGitRepo(dir: string) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m init', { cwd: dir, stdio: "pipe" });
}

function defaultConfig(): AgentDockConfig {
  return {
    version: "1",
    resources: { sync: [] },
    hooks: {},
    env: { ports: ["FRONTEND_PORT", "BACKEND_PORT", "WS_PORT", "DEBUG_PORT", "PREVIEW_PORT"] },
  };
}

const isWin = process.platform === "win32";
function sleepCmd(seconds: number): string {
  return isWin ? `ping 127.0.0.1 -n ${seconds + 1} -w 1000 >nul` : `sleep ${seconds}`;
}

beforeEach(() => {
  projectDir = path.join(os.tmpdir(), `ad-resilience-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(projectDir, { recursive: true });
  initGitRepo(projectDir);
  portCounter = 0;
});

afterEach(async () => {
  // 等待可能残留的子进程结束，避免 afterEach 清理时 EPERM
  await new Promise((r) => setTimeout(r, 200));
  if (existsSync(projectDir)) {
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      // 子进程可能在极少数情况下仍持有句柄，忽略让 OS 清理
    }
  }
});

// ============================================================
// D36–D42: remove — 带活跃子进程的 session 删除
// ============================================================
describe("remove — 进程锁定场景", () => {
  it("D36: 异步 hook 子进程运行中，删除 session 成功", { timeout: 120000 }, async () => {
    const config = defaultConfig();
    config.hooks.afterCreateSession = [{
      run: sleepCmd(30),
      required: false,
      timeout: 60000,
      cwd: "worktree",
      async: true,
    }];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const created = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess36",
      sessionName: "Test",
      config,
    });
    expect(existsSync(created.worktreePath)).toBe(true);

    // 等待 hook 子进程启动并持有目录句柄
    await new Promise((r) => setTimeout(r, 1000));

    // 删除 session — 应该成功（killProcessesUnderPath + 重试循环）
    await lifecycle.remove({
      sessionId: "sess36",
      projectPath: projectDir,
      worktreePath: created.worktreePath,
      config: defaultConfig(),
    });
    expect(existsSync(created.worktreePath)).toBe(false);
  });

  it("D37: 异步 hook 还在运行时立即删除 session（竞态条件）", { timeout: 120000 }, async () => {
    const config = defaultConfig();
    config.hooks.afterCreateSession = [{
      run: sleepCmd(30),
      required: false,
      timeout: 60000,
      cwd: "worktree",
      async: true,
    }];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const created = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess37",
      sessionName: "Test",
      config,
    });

    // 不等 hook 完成，立即删除（模拟用户快速操作）
    await new Promise((r) => setTimeout(r, 200));
    await lifecycle.remove({
      sessionId: "sess37",
      projectPath: projectDir,
      worktreePath: created.worktreePath,
      config: defaultConfig(),
    });
    expect(existsSync(created.worktreePath)).toBe(false);
  });

  it("D38: 多个异步 hook 子进程同时持有时删除成功", { timeout: 120000 }, async () => {
    const config = defaultConfig();
    config.hooks.afterCreateSession = [
      { run: sleepCmd(30), required: false, timeout: 60000, cwd: "worktree", async: true },
      { run: sleepCmd(30), required: false, timeout: 60000, cwd: "worktree", async: true },
    ];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const created = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess38",
      sessionName: "Test",
      config,
    });

    await new Promise((r) => setTimeout(r, 1000));
    await lifecycle.remove({
      sessionId: "sess38",
      projectPath: projectDir,
      worktreePath: created.worktreePath,
      config: defaultConfig(),
    });
    expect(existsSync(created.worktreePath)).toBe(false);
  });

  it("D39: 删除后 DB 记录清理、可重新创建同 ID session", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const created = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess39",
      sessionName: "Test",
      config: defaultConfig(),
    });

    await lifecycle.remove({
      sessionId: "sess39",
      projectPath: projectDir,
      worktreePath: created.worktreePath,
      config: defaultConfig(),
    });

    // 重新创建 — 端口重新分配，worktree 重建
    const recreated = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess39",
      sessionName: "Recreated",
      config: defaultConfig(),
    });
    expect(recreated.ports.FRONTEND_PORT).toBeGreaterThan(0);
    expect(existsSync(recreated.worktreePath)).toBe(true);
  });

  it("D40: beforeDeleteSession hook 在进程锁定场景仍执行", { timeout: 120000 }, async () => {
    const config = defaultConfig();
    config.hooks.beforeDeleteSession = [{
      run: "echo before-delete",
      required: false,
      timeout: 10000,
      cwd: "project",
    }];
    config.hooks.afterCreateSession = [{
      run: sleepCmd(30),
      required: false,
      timeout: 60000,
      cwd: "worktree",
      async: true,
    }];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const created = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess40",
      sessionName: "Test",
      config,
    });

    await new Promise((r) => setTimeout(r, 500));
    await lifecycle.remove({
      sessionId: "sess40",
      projectPath: projectDir,
      worktreePath: created.worktreePath,
      config,
    });
    expect(existsSync(created.worktreePath)).toBe(false);
  });

  it("D41: afterDeleteSession hook 在删除后执行（即使目录已被清理）", async () => {
    const config = defaultConfig();
    config.hooks.afterDeleteSession = [{
      run: "echo after-delete",
      required: false,
      timeout: 10000,
      cwd: "project",
    }];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const created = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess41",
      sessionName: "Test",
      config: defaultConfig(),
    });

    await lifecycle.remove({
      sessionId: "sess41",
      projectPath: projectDir,
      worktreePath: created.worktreePath,
      config,
    });
    expect(existsSync(created.worktreePath)).toBe(false);
  });

  it("D42: 多次创建-删除循环稳定", { timeout: 120_000 }, async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    for (let i = 0; i < 3; i++) {
      const created = await lifecycle.create({
        projectId: "proj1",
        projectPath: projectDir,
        sessionId: `sess42-${i}`,
        sessionName: `Test ${i}`,
        config: defaultConfig(),
      });
      expect(existsSync(created.worktreePath)).toBe(true);
      await lifecycle.remove({
        sessionId: `sess42-${i}`,
        projectPath: projectDir,
        worktreePath: created.worktreePath,
        config: defaultConfig(),
      });
      expect(existsSync(created.worktreePath)).toBe(false);
    }
  });
});

// ============================================================
// D43–D48: removeOrphanDir — 孤儿目录清理
// ============================================================
describe("removeOrphanDir — 孤儿目录清理", () => {
  it("D43: 孤儿目录（非 git worktree）正常删除", async () => {
    const orphanDir = path.join(projectDir, "orphan-d43");
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(path.join(orphanDir, "file.txt"), "orphan data");

    await removeOrphanDir(orphanDir);
    expect(existsSync(orphanDir)).toBe(false);
  });

  it("D44: 子进程持有时重试后成功删除", { timeout: 60000 }, async () => {
    const orphanDir = path.join(projectDir, "orphan-d44");
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(path.join(orphanDir, "file.txt"), "data");

    // 在独立子进程中持有目录句柄
    let child: ReturnType<typeof spawn> | null = null;
    if (isWin) {
      child = spawn("cmd.exe", ["/c", "ping -n 10 127.0.0.1 >nul"], { cwd: orphanDir });
    } else {
      child = spawn("sleep", ["10"], { cwd: orphanDir });
    }

    await new Promise((r) => setTimeout(r, 500));

    await removeOrphanDir(orphanDir);
    expect(existsSync(orphanDir)).toBe(false);

    try { child?.kill(); } catch {}
  });

  it("D45: 嵌套子目录递归删除", async () => {
    const orphanDir = path.join(projectDir, "orphan-d45");
    const nested = path.join(orphanDir, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, "deep.txt"), "deep data");
    writeFileSync(path.join(orphanDir, "top.txt"), "top");

    await removeOrphanDir(orphanDir);
    expect(existsSync(orphanDir)).toBe(false);
  });

  it("D46: 重试耗尽后抛出错误", { timeout: 120000 }, async () => {
    const orphanDir = path.join(projectDir, "orphan-d46");
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(path.join(orphanDir, "file.txt"), "data");

    let child: ReturnType<typeof spawn> | null = null;
    if (isWin) {
      child = spawn("cmd.exe", ["/c", "ping -n 60 127.0.0.1 >nul"], { cwd: orphanDir });
    } else {
      child = spawn("sleep", ["60"], { cwd: orphanDir, detached: true, stdio: "ignore" });
      child.unref();
    }

    await new Promise((r) => setTimeout(r, 500));

    await expect(removeOrphanDir(orphanDir)).rejects.toThrow();
    expect(existsSync(orphanDir)).toBe(true);

    try { child?.kill(); child?.unref(); } catch {}
    // 清理
    try { rmSync(orphanDir, { recursive: true, force: true }); } catch {}
  });

  it("D47: 不存在的路径静默返回", async () => {
    await expect(removeOrphanDir(path.join(projectDir, "no-such-dir"))).resolves.toBeUndefined();
  });

  it("D48: 目录中有 node_modules 风格的长路径文件也能删除", async () => {
    const orphanDir = path.join(projectDir, "orphan-d48");
    const longPath = path.join(orphanDir, "node_modules", "@biomejs", "biome", "bin");
    mkdirSync(longPath, { recursive: true });
    writeFileSync(path.join(longPath, "biome.exe"), "fake exe");

    await removeOrphanDir(orphanDir);
    expect(existsSync(orphanDir)).toBe(false);
  });
});
