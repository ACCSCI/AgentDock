import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDockConfig } from "../config.js";
import type { HookReport } from "../hook-engine.js";
import { type PortService, createSessionLifecycle } from "../session-lifecycle.js";
import { getWorktreePath } from "../worktree.js";

const isWin = process.platform === "win32";
function assertDefined<T>(value: T | null | undefined): asserts value is T {
  expect(value).toBeDefined();
  if (value == null) throw new Error("Expected value to be defined");
}
function requireDefined<T>(value: T): NonNullable<T> {
  assertDefined(value);
  return value as NonNullable<T>;
}
function echoCmd(msg: string) {
  return `echo ${msg}`;
}
function exitCmd(code: number) {
  return isWin ? `cmd /c exit ${code}` : `exit ${code}`;
}
function sleepCmd(seconds: number) {
  return isWin ? `ping 127.0.0.1 -n ${seconds + 1} -w 1000 >nul` : `sleep ${seconds}`;
}

let projectDir: string;

// Mock port service for tests
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
      // no-op
    },
  };
}

function initGitRepo(dir: string) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: dir, stdio: "pipe" });
}

function defaultConfig(): AgentDockConfig {
  return {
    version: "1",
    resources: { sync: [] },
    hooks: {},
    env: { ports: ["FRONTEND_PORT", "BACKEND_PORT", "WS_PORT", "DEBUG_PORT", "PREVIEW_PORT"] },
  };
}

beforeEach(() => {
  projectDir = path.join(
    os.tmpdir(),
    `ad-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(projectDir, { recursive: true });
  initGitRepo(projectDir);
  portCounter = 0;
});

afterEach(() => {
  if (existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ============================================================
// D1–D11: create — 正常流程
// ============================================================
describe("create — 正常流程", () => {
  it("D1: 创建 session 返回完整结果", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess01",
      sessionName: "Test Session",
      config: defaultConfig(),
    });
    expect(result.sessionId).toBe("sess01");
    expect(result.worktreePath).toContain("sess01");
    expect(result.branch).toBe("agentdock/sess01");
    expect(result.ports).toBeDefined();
    expect(result.syncReport).toBeDefined();
    expect(result.hookReports).toBeDefined();
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("D2: worktree 在磁盘上被创建", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess02",
      sessionName: "Test",
      config: defaultConfig(),
    });
    expect(existsSync(result.worktreePath)).toBe(true);
    // Verify it's a git worktree
    expect(existsSync(path.join(result.worktreePath, ".git"))).toBe(true);
  });

  it("D3: branch 命名规则", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "abc123",
      sessionName: "Test",
      config: defaultConfig(),
    });
    expect(result.branch).toBe("agentdock/abc123");
  });

  it("D4: worktreePath 命名规则", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess04",
      sessionName: "Test",
      config: defaultConfig(),
    });
    expect(result.worktreePath).toBe(getWorktreePath(projectDir, "sess04"));
  });

  it("D5: 端口被分配且写入 .env", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess05",
      sessionName: "Test",
      config: defaultConfig(),
    });
    const { ports } = result;
    expect(ports.FRONTEND_PORT).toBeGreaterThan(0);
    expect(ports.BACKEND_PORT).toBeGreaterThan(0);
    expect(ports.WS_PORT).toBeGreaterThan(0);
    expect(ports.DEBUG_PORT).toBeGreaterThan(0);
    expect(ports.PREVIEW_PORT).toBeGreaterThan(0);
    // .env should contain port values
    const envPath = path.join(result.worktreePath, ".env");
    expect(existsSync(envPath)).toBe(true);
    const envContent = readFileSync(envPath, "utf-8");
    expect(envContent).toContain(`FRONTEND_PORT=${ports.FRONTEND_PORT}`);
  });

  it("D6: 资源同步 .env 到 worktree", async () => {
    writeFileSync(path.join(projectDir, ".env"), "A=1\nB=2\n");
    const config = defaultConfig();
    config.resources.sync = [{ source: ".env", strategy: "overwrite", skipIfMissing: true }];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess06",
      sessionName: "Test",
      config,
    });
    const envContent = readFileSync(path.join(result.worktreePath, ".env"), "utf-8");
    expect(envContent).toContain("A=1");
    expect(envContent).toContain("B=2");
  });

  it("D7: 资源同步跳过不存在的文件", async () => {
    const config = defaultConfig();
    config.resources.sync = [{ source: "dev.db", strategy: "overwrite", skipIfMissing: true }];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess07",
      sessionName: "Test",
      config,
    });
    expect(result.syncReport.results).toHaveLength(1);
    expect(result.syncReport.results[0].action).toBe("missing-skipped");
  });

  it("D8: afterCreateSession hook 执行成功", async () => {
    const config = defaultConfig();
    config.hooks.afterCreateSession = [
      { run: echoCmd("done"), required: false, timeout: 30000, cwd: "worktree", async: false },
    ];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess08",
      sessionName: "Test",
      config,
    });
    const afterReport = result.hookReports.find((r) => r.event === "afterCreateSession");
    expect(afterReport).toBeDefined();
    expect(afterReport?.results).toHaveLength(1);
    expect(afterReport?.results[0].success).toBe(true);
    expect(afterReport?.results[0].stdout).toContain("done");
  });

  it("D9: beforeCreateSession hook 执行成功", async () => {
    const config = defaultConfig();
    config.hooks.beforeCreateSession = [
      { run: echoCmd("ready"), required: false, timeout: 30000, cwd: "project", async: false },
    ];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess09",
      sessionName: "Test",
      config,
    });
    const beforeReport = result.hookReports.find((r) => r.event === "beforeCreateSession");
    expect(beforeReport).toBeDefined();
    expect(beforeReport?.results[0].success).toBe(true);
  });

  it("D10: 无 config 时 pipeline 正常完成", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess10",
      sessionName: "Test",
      config: defaultConfig(),
    });
    expect(result.syncReport.results).toEqual([]);
    // Hook reports always present (even with empty results) — pipeline always runs
    for (const report of result.hookReports) {
      expect(report.results).toEqual([]);
      expect(report.success).toBe(true);
    }
  });

  it("D11: duration 记录正数", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess11",
      sessionName: "Test",
      config: defaultConfig(),
    });
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================
// D12–D16: create — 失败与 rollback
// ============================================================
describe("create — 失败与 rollback", () => {
  it("D12: beforeCreateSession required hook 失败中断 create", async () => {
    const config = defaultConfig();
    config.hooks.beforeCreateSession = [
      { run: exitCmd(1), required: true, timeout: 30000, cwd: "worktree", async: false },
    ];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    await expect(
      lifecycle.create({
        projectId: "proj1",
        projectPath: projectDir,
        sessionId: "sess12",
        sessionName: "Test",
        config,
      }),
    ).rejects.toThrow("beforeCreateSession hook failed");
    // Worktree should NOT exist
    expect(existsSync(getWorktreePath(projectDir, "sess12"))).toBe(false);
  });

  it("D13: afterCreateSession required hook 失败触发 rollback", async () => {
    const config = defaultConfig();
    config.hooks.afterCreateSession = [
      { run: exitCmd(1), required: true, timeout: 30000, cwd: "worktree", async: false },
    ];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    await expect(
      lifecycle.create({
        projectId: "proj1",
        projectPath: projectDir,
        sessionId: "sess13",
        sessionName: "Test",
        config,
      }),
    ).rejects.toThrow("afterCreateSession hook failed");
    // Worktree should be cleaned up
    expect(existsSync(getWorktreePath(projectDir, "sess13"))).toBe(false);
  });

  it("D14: afterCreateSession optional hook 失败不 rollback", async () => {
    const config = defaultConfig();
    config.hooks.afterCreateSession = [
      { run: exitCmd(1), required: false, timeout: 30000, cwd: "worktree", async: false },
    ];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess14",
      sessionName: "Test",
      config,
    });
    expect(existsSync(result.worktreePath)).toBe(true);
    expect(result.ports.FRONTEND_PORT).toBeGreaterThan(0);
    const afterReport = result.hookReports.find((r) => r.event === "afterCreateSession");
    expect(afterReport?.results[0].success).toBe(false);
  });

  it("D15: 资源同步 skipIfMissing=false 失败触发 rollback", async () => {
    const config = defaultConfig();
    config.resources.sync = [{ source: "dev.db", strategy: "overwrite", skipIfMissing: false }];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    await expect(
      lifecycle.create({
        projectId: "proj1",
        projectPath: projectDir,
        sessionId: "sess15",
        sessionName: "Test",
        config,
      }),
    ).rejects.toThrow();
    // Worktree should be cleaned up
    expect(existsSync(getWorktreePath(projectDir, "sess15"))).toBe(false);
  });

  it("D16: rollback 释放端口后可重新分配", async () => {
    const config = defaultConfig();
    config.resources.sync = [{ source: "dev.db", strategy: "overwrite", skipIfMissing: false }];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    // First attempt fails
    await expect(
      lifecycle.create({
        projectId: "proj1",
        projectPath: projectDir,
        sessionId: "sess16",
        sessionName: "Test",
        config,
      }),
    ).rejects.toThrow();

    // Second attempt with skipIfMissing=true succeeds
    config.resources.sync = [{ source: "dev.db", strategy: "overwrite", skipIfMissing: true }];
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess16",
      sessionName: "Test",
      config,
    });
    expect(result.ports.FRONTEND_PORT).toBeGreaterThan(0);
    expect(existsSync(result.worktreePath)).toBe(true);
  });
});

// ============================================================
// D17–D18: create — 执行顺序验证
// ============================================================
describe("create — 执行顺序验证", () => {
  it("D17: pipeline 执行顺序：beforeHook → worktree → sync → ports → afterHook", async () => {
    const tmpFile = path.join(os.tmpdir(), `order-${Date.now()}.txt`);
    const config = defaultConfig();

    // Write .env to project for sync
    writeFileSync(path.join(projectDir, ".env"), "TEST_KEY=hello\n");
    config.resources.sync = [{ source: ".env", strategy: "overwrite", skipIfMissing: true }];

    // beforeCreateSession: write marker to tmpFile
    config.hooks.beforeCreateSession = [
      {
        run: `${echoCmd("before")} >> "${tmpFile}"`,
        required: false,
        timeout: 30000,
        cwd: "project",
        async: false,
      },
    ];

    // afterCreateSession: read .env from worktree and write marker
    config.hooks.afterCreateSession = [
      {
        run: `${echoCmd("after")} >> "${tmpFile}"`,
        required: false,
        timeout: 30000,
        cwd: "worktree",
        async: false,
      },
    ];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess17",
      sessionName: "Test",
      config,
    });

    // .env should be synced to worktree
    const envContent = readFileSync(path.join(result.worktreePath, ".env"), "utf-8");
    expect(envContent).toContain("TEST_KEY=hello");

    // Both hooks should have written markers
    const markers = readFileSync(tmpFile, "utf-8");
    expect(markers).toContain("before");
    expect(markers).toContain("after");

    try {
      rmSync(tmpFile);
    } catch {}
  });

  it("D18: afterCreateSession hook 中 worktree 已有端口 .env", async () => {
    const config = defaultConfig();
    const envReadFile = path.join(os.tmpdir(), `env-read-${Date.now()}.txt`);

    config.hooks.afterCreateSession = [
      {
        // Read .env and dump it to a temp file
        run: isWin ? `type .env >> "${envReadFile}"` : `cat .env >> "${envReadFile}"`,
        required: false,
        timeout: 30000,
        cwd: "worktree",
        async: false,
      },
    ];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess18",
      sessionName: "Test",
      config,
    });

    const envContent = readFileSync(envReadFile, "utf-8");
    expect(envContent).toContain(`FRONTEND_PORT=${result.ports.FRONTEND_PORT}`);

    try {
      rmSync(envReadFile);
    } catch {}
  });
});

// ============================================================
// D19–D24: remove — 正常流程
// ============================================================
describe("remove — 正常流程", () => {
  it("D19: 删除 session 清理 worktree", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const created = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess19",
      sessionName: "Test",
      config: defaultConfig(),
    });
    expect(existsSync(created.worktreePath)).toBe(true);

    await lifecycle.remove({
      sessionId: "sess19",
      projectPath: projectDir,
      worktreePath: created.worktreePath,
      config: defaultConfig(),
    });
    expect(existsSync(created.worktreePath)).toBe(false);
  });

  it("D20: 删除 session 释放端口后可重新创建", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const created = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess20",
      sessionName: "Test",
      config: defaultConfig(),
    });

    await lifecycle.remove({
      sessionId: "sess20",
      projectPath: projectDir,
      worktreePath: created.worktreePath,
      config: defaultConfig(),
    });

    // Recreate with same sessionId — should succeed (ports released, worktree removed)
    const recreated = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess20",
      sessionName: "Test 2",
      config: defaultConfig(),
    });
    expect(recreated.ports.FRONTEND_PORT).toBeGreaterThan(0);
    expect(existsSync(recreated.worktreePath)).toBe(true);
  });

  it("D21: beforeDeleteSession hook 执行", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const created = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess21",
      sessionName: "Test",
      config: defaultConfig(),
    });

    const config = defaultConfig();
    config.hooks.beforeDeleteSession = [
      { run: echoCmd("deleting"), required: false, timeout: 30000, cwd: "project", async: false },
    ];

    const result = await lifecycle.remove({
      sessionId: "sess21",
      projectPath: projectDir,
      worktreePath: created.worktreePath,
      config,
    });
    const beforeReport = result.hookReports.find((r) => r.event === "beforeDeleteSession");
    expect(beforeReport).toBeDefined();
    expect(beforeReport?.results[0].stdout).toContain("deleting");
  });

  it("D22: afterDeleteSession hook 执行", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const created = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess22",
      sessionName: "Test",
      config: defaultConfig(),
    });

    const config = defaultConfig();
    config.hooks.afterDeleteSession = [
      { run: echoCmd("deleted"), required: false, timeout: 30000, cwd: "project", async: false },
    ];

    const result = await lifecycle.remove({
      sessionId: "sess22",
      projectPath: projectDir,
      worktreePath: created.worktreePath,
      config,
    });
    const afterReport = result.hookReports.find((r) => r.event === "afterDeleteSession");
    expect(afterReport).toBeDefined();
    expect(afterReport?.results[0].stdout).toContain("deleted");
  });

  it("D23: 无 config 时 remove 正常完成", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const created = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess23",
      sessionName: "Test",
      config: defaultConfig(),
    });

    const result = await lifecycle.remove({
      sessionId: "sess23",
      projectPath: projectDir,
      worktreePath: created.worktreePath,
      config: defaultConfig(),
    });
    expect(result.success).toBe(true);
    expect(existsSync(created.worktreePath)).toBe(false);
  });

  it("D24: remove 返回 success=true", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const created = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess24",
      sessionName: "Test",
      config: defaultConfig(),
    });

    const result = await lifecycle.remove({
      sessionId: "sess24",
      projectPath: projectDir,
      worktreePath: created.worktreePath,
      config: defaultConfig(),
    });
    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("sess24");
  });
});

// ============================================================
// D25–D27: remove — hook 失败
// ============================================================
describe("remove — hook 失败", () => {
  it("D25: beforeDeleteSession required hook 失败中断删除", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const created = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess25",
      sessionName: "Test",
      config: defaultConfig(),
    });

    const config = defaultConfig();
    config.hooks.beforeDeleteSession = [
      { run: exitCmd(1), required: true, timeout: 30000, cwd: "worktree", async: false },
    ];

    const onBeforeCoreDelete = vi.fn();
    await expect(
      lifecycle.remove({
        sessionId: "sess25",
        projectPath: projectDir,
        worktreePath: created.worktreePath,
        config,
        onBeforeCoreDelete,
      }),
    ).rejects.toThrow("beforeDeleteSession hook failed");
    expect(onBeforeCoreDelete).not.toHaveBeenCalled();
    // Worktree should still exist (deletion was interrupted)
    expect(existsSync(created.worktreePath)).toBe(true);
  });

  it("runs destructive cleanup only after beforeDeleteSession succeeds", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const created = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess25-order",
      sessionName: "Test",
      config: defaultConfig(),
    });
    const onBeforeCoreDelete = vi.fn();

    await lifecycle.remove({
      sessionId: "sess25-order",
      projectPath: projectDir,
      worktreePath: created.worktreePath,
      config: defaultConfig(),
      onBeforeCoreDelete,
    });

    expect(onBeforeCoreDelete).toHaveBeenCalledOnce();
  });

  it("D26: afterDeleteSession hook 失败不影响结果", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const created = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess26",
      sessionName: "Test",
      config: defaultConfig(),
    });

    const config = defaultConfig();
    config.hooks.afterDeleteSession = [
      { run: exitCmd(1), required: true, timeout: 30000, cwd: "worktree", async: false },
    ];

    // afterDeleteSession failure should NOT prevent deletion
    // The worktree is already removed before afterDelete hooks run
    const result = await lifecycle.remove({
      sessionId: "sess26",
      projectPath: projectDir,
      worktreePath: created.worktreePath,
      config,
    });
    expect(result.success).toBe(true);
    expect(existsSync(created.worktreePath)).toBe(false);
  });

  it("D27: beforeDeleteSession optional hook 失败继续删除", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const created = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess27",
      sessionName: "Test",
      config: defaultConfig(),
    });

    const config = defaultConfig();
    config.hooks.beforeDeleteSession = [
      { run: exitCmd(1), required: false, timeout: 30000, cwd: "worktree", async: false },
    ];

    const result = await lifecycle.remove({
      sessionId: "sess27",
      projectPath: projectDir,
      worktreePath: created.worktreePath,
      config,
    });
    expect(result.success).toBe(true);
    expect(existsSync(created.worktreePath)).toBe(false);
  });
});

// ============================================================
// D28–D35: create — async afterCreateSession (background hooks)
// ============================================================
describe("create — async afterCreateSession", () => {
  it("D28: async hook 时 create() 立即返回，不等待 hook 完成", async () => {
    const config = defaultConfig();
    config.hooks.afterCreateSession = [
      {
        run: sleepCmd(3), // 3 seconds
        required: false,
        timeout: 10000,
        cwd: "worktree",
        async: true,
      },
    ];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const start = Date.now();
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess28",
      sessionName: "Test",
      config,
    });
    const elapsed = Date.now() - start;

    // Should return quickly (< 2s), not wait for 3s sleep
    expect(elapsed).toBeLessThan(2000);
    expect(result.sessionId).toBe("sess28");
    expect(result.worktreePath).toContain("sess28");
    expect(result.ports).toBeDefined();
    assertDefined(result.backgroundHookPromise);

    // Wait for background hook to complete
    assertDefined(result.backgroundHookPromise);
    const bgReport = await requireDefined(result.backgroundHookPromise);
    expect(bgReport.success).toBe(true);
  });

  it("D29: backgroundHookPromise 在 hook 完成后 resolve", async () => {
    const config = defaultConfig();
    config.hooks.afterCreateSession = [
      {
        run: echoCmd("bg-done"),
        required: false,
        timeout: 10000,
        cwd: "worktree",
        async: true,
      },
    ];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess29",
      sessionName: "Test",
      config,
    });

    const bgReport = await requireDefined(result.backgroundHookPromise);
    expect(bgReport.success).toBe(true);
    expect(bgReport.results).toHaveLength(1);
    expect(bgReport.results[0].stdout).toContain("bg-done");
  });

  it("D30: onBackgroundHookComplete 在成功时被调用", async () => {
    const config = defaultConfig();
    config.hooks.afterCreateSession = [
      {
        run: echoCmd("completed"),
        required: false,
        timeout: 10000,
        cwd: "worktree",
        async: true,
      },
    ];

    let completedReport: HookReport | null = null;
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess30",
      sessionName: "Test",
      config,
      onBackgroundHookComplete: (report) => {
        completedReport = report;
      },
    });

    assertDefined(result.backgroundHookPromise);
    await result.backgroundHookPromise;
    // Give a tick for the callback to fire
    await new Promise((r) => setTimeout(r, 50));

    const callbackReport = requireDefined(completedReport as HookReport | null);
    expect(callbackReport.success).toBe(true);
  });

  it("D31: onBackgroundHookComplete 在失败时被调用", async () => {
    const config = defaultConfig();
    config.hooks.afterCreateSession = [
      {
        run: exitCmd(1),
        required: false,
        timeout: 10000,
        cwd: "worktree",
        async: true,
      },
    ];

    let completedReport: HookReport | null = null;
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess31",
      sessionName: "Test",
      config,
      onBackgroundHookComplete: (report) => {
        completedReport = report;
      },
    });

    assertDefined(result.backgroundHookPromise);
    const bgReport = await result.backgroundHookPromise;
    // Individual hook result fails (exit code 1), but report.success is true
    // because the hook is not required
    expect(bgReport.results[0].success).toBe(false);

    await new Promise((r) => setTimeout(r, 50));
    const callbackReport = requireDefined(completedReport as HookReport | null);
    expect(callbackReport.results[0].success).toBe(false);
  });

  it("D32: async hook 失败不回滚 session", async () => {
    const config = defaultConfig();
    config.hooks.afterCreateSession = [
      {
        run: exitCmd(1),
        required: false,
        timeout: 10000,
        cwd: "worktree",
        async: true,
      },
    ];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess32",
      sessionName: "Test",
      config,
    });

    await result.backgroundHookPromise;
    await new Promise((r) => setTimeout(r, 50));

    // Individual hook failed but worktree and ports should still exist (no rollback)
    expect(existsSync(result.worktreePath)).toBe(true);
    expect(result.ports.FRONTEND_PORT).toBeGreaterThan(0);
  });

  it("D33: beforeCreateSession 仍同步阻塞", async () => {
    const config = defaultConfig();
    config.hooks.beforeCreateSession = [
      {
        run: exitCmd(1),
        required: true,
        timeout: 10000,
        cwd: "worktree",
        async: false,
      },
    ];
    config.hooks.afterCreateSession = [
      {
        run: echoCmd("should not run"),
        required: false,
        timeout: 10000,
        cwd: "worktree",
        async: true,
      },
    ];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    await expect(
      lifecycle.create({
        projectId: "proj1",
        projectPath: projectDir,
        sessionId: "sess33",
        sessionName: "Test",
        config,
      }),
    ).rejects.toThrow("beforeCreateSession hook failed");
    expect(existsSync(getWorktreePath(projectDir, "sess33"))).toBe(false);
  });

  it("D34: 无 afterCreateSession hook 时 backgroundHookPromise 立即 resolve", async () => {
    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess34",
      sessionName: "Test",
      config: defaultConfig(),
    });

    expect(result.backgroundHookPromise).toBeUndefined();
  });

  it("D35: async=false 时仍同步等待（向后兼容）", async () => {
    const config = defaultConfig();
    config.hooks.afterCreateSession = [
      {
        run: echoCmd("sync-done"),
        required: false,
        timeout: 10000,
        cwd: "worktree",
        async: false,
      },
    ];

    const lifecycle = createSessionLifecycle({ portService: mockPortService() });
    const result = await lifecycle.create({
      projectId: "proj1",
      projectPath: projectDir,
      sessionId: "sess35",
      sessionName: "Test",
      config,
    });

    const afterReport = result.hookReports.find((r) => r.event === "afterCreateSession");
    expect(afterReport).toBeDefined();
    expect(afterReport?.results[0].stdout).toContain("sync-done");
    // Synchronous hooks have already finished, so no background task remains.
    expect(result.backgroundHookPromise).toBeUndefined();
  });

  // --- S: backgroundHookStatus crash recovery ---

  it(
    "S1: async hook 运行中中断后，onWorktreeReady 已被调用但 backgroundHookPromise 未完成",
    { timeout: 15000 },
    async () => {
      const config = defaultConfig();
      config.hooks.afterCreateSession = [
        {
          run: sleepCmd(3), // 3秒模拟长时间 hook
          required: false,
          timeout: 30000,
          cwd: "worktree",
          async: true,
        },
      ];

      let worktreeReadyCalled = false;
      let worktreeReadyPath = "";
      let worktreeReadyBranch = "";

      const lifecycle = createSessionLifecycle({ portService: mockPortService() });
      const result = await lifecycle.create({
        projectId: "proj1",
        projectPath: projectDir,
        sessionId: "sess-crash",
        sessionName: "CrashTest",
        config,
        onWorktreeReady: (wtPath, branch) => {
          worktreeReadyCalled = true;
          worktreeReadyPath = wtPath;
          worktreeReadyBranch = branch;
        },
      });

      // onWorktreeReady 应该在 createWorktree 之后立即被调用
      expect(worktreeReadyCalled).toBe(true);
      expect(worktreeReadyBranch).toBe("agentdock/sess-crash");

      // worktree 应该存在于磁盘
      expect(existsSync(worktreeReadyPath)).toBe(true);

      // backgroundHookPromise 不应该完成（hook 还在 sleep）
      let promiseResolved = false;
      assertDefined(result.backgroundHookPromise);
      result.backgroundHookPromise.then(() => {
        promiseResolved = true;
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(promiseResolved).toBe(false);

      // 模拟"服务器被杀"：不等待 backgroundHookPromise
      // 在真实场景中，此时 DB 中 backgroundHookStatus = "running"

      // 等待 background hook 完成以便 afterEach 清理目录
      await result.backgroundHookPromise;
    },
  );
});
