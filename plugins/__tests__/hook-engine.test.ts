import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
// @ts-nocheck
import { beforeEach, describe, expect, it } from "vitest";
import type { HookDefinition } from "../config.js";
import { type HookContext, createHookEngine, createHookRegistry } from "../hook-engine.js";

const isWin = process.platform === "win32";

// Cross-platform command helpers
function echoCmd(msg: string): string {
  return `echo ${msg}`;
}
function exitCmd(code: number): string {
  if (isWin) return `cmd /c exit ${code}`;
  return `exit ${code}`;
}
function stderrCmd(msg: string): string {
  if (isWin) return `echo ${msg} 1>&2`;
  return `echo ${msg} >&2`;
}
function sleepCmd(seconds: number): string {
  if (isWin) return `ping 127.0.0.1 -n ${seconds + 1} -w 1000 >nul`;
  return `sleep ${seconds}`;
}

// --- Helpers ---
function makeHook(overrides: Partial<HookDefinition> & { run: string }): HookDefinition {
  return {
    required: false,
    timeout: 30000,
    cwd: "worktree",
    ...overrides,
    async: overrides.async ?? false,
  };
}

function makeContext(overrides: Partial<HookContext> = {}): HookContext {
  const tmpDir = path.join(
    os.tmpdir(),
    `hook-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  return {
    event: "afterCreateSession",
    sessionId: "test-session",
    projectId: "test-project",
    projectPath: tmpDir,
    worktreePath: tmpDir,
    payload: {},
    ...overrides,
  };
}

// ============================================================
// C1–C9: HookRegistry
// ============================================================
describe("HookRegistry", () => {
  let registry: ReturnType<typeof createHookRegistry>;

  beforeEach(() => {
    registry = createHookRegistry();
  });

  it("C1: register 注册单个 hook", () => {
    registry.register("afterCreateSession", makeHook({ run: "echo hello" }));
    expect(registry.getHooks("afterCreateSession")).toHaveLength(1);
  });

  it("C2: register 同一事件追加多个 hooks", () => {
    registry.register("afterCreateSession", makeHook({ run: "echo 1" }));
    registry.register("afterCreateSession", makeHook({ run: "echo 2" }));
    registry.register("afterCreateSession", makeHook({ run: "echo 3" }));
    expect(registry.getHooks("afterCreateSession")).toHaveLength(3);
  });

  it("C3: register 不同事件互不影响", () => {
    registry.register("beforeCreateSession", makeHook({ run: "echo before" }));
    registry.register("afterCreateSession", makeHook({ run: "echo after" }));
    expect(registry.getHooks("beforeCreateSession")).toHaveLength(1);
    expect(registry.getHooks("afterCreateSession")).toHaveLength(1);
  });

  it("C4: getHooks 未注册事件返回空数组", () => {
    expect(registry.getHooks("beforeDeleteSession")).toEqual([]);
  });

  it("C5: loadFromConfig 加载完整配置", () => {
    registry.loadFromConfig({
      beforeCreateSession: [makeHook({ run: "a" }), makeHook({ run: "b" })],
      afterCreateSession: [makeHook({ run: "c" }), makeHook({ run: "d" })],
      beforeDeleteSession: [makeHook({ run: "e" }), makeHook({ run: "f" })],
      afterDeleteSession: [makeHook({ run: "g" }), makeHook({ run: "h" })],
    });
    expect(registry.getHooks("beforeCreateSession")).toHaveLength(2);
    expect(registry.getHooks("afterCreateSession")).toHaveLength(2);
    expect(registry.getHooks("beforeDeleteSession")).toHaveLength(2);
    expect(registry.getHooks("afterDeleteSession")).toHaveLength(2);
  });

  it("C6: loadFromConfig 覆盖已有注册", () => {
    registry.register("afterCreateSession", makeHook({ run: "old" }));
    registry.loadFromConfig({
      beforeCreateSession: [],
      afterCreateSession: [makeHook({ run: "new1" }), makeHook({ run: "new2" })],
      beforeDeleteSession: [],
      afterDeleteSession: [],
    });
    expect(registry.getHooks("afterCreateSession")).toHaveLength(2);
    expect(registry.getHooks("afterCreateSession")[0].run).toBe("new1");
  });

  it("C7: clear 清除指定事件", () => {
    registry.register("beforeCreateSession", makeHook({ run: "a" }));
    registry.register("afterCreateSession", makeHook({ run: "b" }));
    registry.register("beforeDeleteSession", makeHook({ run: "c" }));
    registry.clear("afterCreateSession");
    expect(registry.getHooks("afterCreateSession")).toEqual([]);
    expect(registry.getHooks("beforeCreateSession")).toHaveLength(1);
    expect(registry.getHooks("beforeDeleteSession")).toHaveLength(1);
  });

  it("C8: clear 无参数清除全部", () => {
    registry.register("beforeCreateSession", makeHook({ run: "a" }));
    registry.register("afterCreateSession", makeHook({ run: "b" }));
    registry.clear();
    expect(registry.getHooks("beforeCreateSession")).toEqual([]);
    expect(registry.getHooks("afterCreateSession")).toEqual([]);
  });

  it("C9: register 保留 HookDefinition 完整字段", () => {
    registry.register(
      "afterCreateSession",
      makeHook({
        run: "echo test",
        required: true,
        timeout: 5000,
        cwd: "project",
      }),
    );
    const hooks = registry.getHooks("afterCreateSession");
    expect(hooks[0]).toMatchObject({
      run: "echo test",
      required: true,
      timeout: 5000,
      cwd: "project",
    });
  });
});

// ============================================================
// C10–C20: HookEngine.executeOne
// ============================================================
describe("HookEngine.executeOne", () => {
  let registry: ReturnType<typeof createHookRegistry>;
  let engine: ReturnType<typeof createHookEngine>;

  beforeEach(() => {
    registry = createHookRegistry();
    engine = createHookEngine(registry);
  });

  it("C10: 执行成功命令 exit 0", async () => {
    const hook = makeHook({ run: echoCmd("hello") });
    const ctx = makeContext();
    const result = await engine.executeOne(hook, ctx);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.timedOut).toBe(false);
  });

  it("C11: 执行失败命令 exit 1", async () => {
    const hook = makeHook({ run: exitCmd(1) });
    const ctx = makeContext();
    const result = await engine.executeOne(hook, ctx);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("C12: 执行失败命令返回非零 exit code", async () => {
    const hook = makeHook({ run: exitCmd(2) });
    const ctx = makeContext();
    const result = await engine.executeOne(hook, ctx);
    expect(result.success).toBe(false);
    // On Windows, exec doesn't propagate the exact exit code via error.status
    // so we just verify it's non-zero
    expect(result.exitCode).not.toBe(0);
  });

  it("C13: stdout 捕获", async () => {
    const hook = makeHook({ run: echoCmd("test-output") });
    const ctx = makeContext();
    const result = await engine.executeOne(hook, ctx);
    expect(result.stdout).toContain("test-output");
  });

  it("C14: stderr 捕获", async () => {
    const hook = makeHook({ run: stderrCmd("err-msg") });
    const ctx = makeContext();
    const result = await engine.executeOne(hook, ctx);
    expect(result.stderr).toContain("err-msg");
  });

  it("C15: duration 记录耗时", async () => {
    const hook = makeHook({ run: echoCmd("ok") });
    const ctx = makeContext();
    const result = await engine.executeOne(hook, ctx);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(typeof result.duration).toBe("number");
  });

  it("C16: cwd=worktree 时在 worktreePath 执行", async () => {
    const ctx = makeContext();
    const hook = makeHook({ run: echoCmd("in-worktree"), cwd: "worktree" });
    const result = await engine.executeOne(hook, ctx);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain("in-worktree");
  });

  it("C17: cwd=project 时在 projectPath 执行", async () => {
    const ctx = makeContext();
    const hook = makeHook({ run: echoCmd("in-project"), cwd: "project" });
    const result = await engine.executeOne(hook, ctx);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain("in-project");
  });

  it("C18: 超时触发", async () => {
    const hook = makeHook({ run: sleepCmd(10), timeout: 200 });
    const ctx = makeContext();
    const result = await engine.executeOne(hook, ctx);
    expect(result.timedOut).toBe(true);
    expect(result.success).toBe(false);
  });

  it("C19: 超时时间精确性", async () => {
    const hook = makeHook({ run: sleepCmd(10), timeout: 300 });
    const ctx = makeContext();
    const start = Date.now();
    const result = await engine.executeOne(hook, ctx);
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    // Should be roughly around 300ms, allow generous tolerance
    expect(elapsed).toBeLessThan(2000);
  });

  it("C20: 命令不存在时捕获错误", async () => {
    const hook = makeHook({ run: "nonexistent_command_xyz_12345" });
    const ctx = makeContext();
    const result = await engine.executeOne(hook, ctx);
    expect(result.success).toBe(false);
  });
  it("C21: worktree .env overrides inherited parent env", async () => {
    const ctx = makeContext();
    writeFileSync(
      path.join(ctx.worktreePath, ".env"),
      "FRONTEND_PORT=20091\nAPI_URL=http://local\n",
    );
    const originalFrontendPort = process.env.FRONTEND_PORT;
    const originalApiUrl = process.env.API_URL;
    process.env.FRONTEND_PORT = "5175";
    process.env.API_URL = "http://parent";
    try {
      const hook = makeHook({
        run: isWin
          ? "echo %FRONTEND_PORT% %API_URL%"
          : 'printf \'%s %s\' "$FRONTEND_PORT" "$API_URL"',
      });
      const result = await engine.executeOne(hook, ctx);
      expect(result.success).toBe(true);
      expect(result.stdout).toContain("20091");
      expect(result.stdout).toContain("http://local");
    } finally {
      if (originalFrontendPort === undefined) process.env.FRONTEND_PORT = undefined;
      else process.env.FRONTEND_PORT = originalFrontendPort;
      if (originalApiUrl === undefined) process.env.API_URL = undefined;
      else process.env.API_URL = originalApiUrl;
    }
  });

  it("C22: fallback port keys are stripped when worktree .env does not define them", async () => {
    const ctx = makeContext();
    writeFileSync(path.join(ctx.worktreePath, ".env"), "API_URL=http://local\n");
    const originalFrontendPort = process.env.FRONTEND_PORT;
    process.env.FRONTEND_PORT = "5175";
    try {
      const hook = makeHook({
        run: isWin
          ? "if defined FRONTEND_PORT (echo defined) else echo missing"
          : 'if [ -n "$FRONTEND_PORT" ]; then echo defined; else echo missing; fi',
      });
      const result = await engine.executeOne(hook, ctx);
      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe("missing");
    } finally {
      if (originalFrontendPort === undefined) process.env.FRONTEND_PORT = undefined;
      else process.env.FRONTEND_PORT = originalFrontendPort;
    }
  });

  it("C23: runtime AGENTDOCK vars override worktree .env", async () => {
    const ctx = makeContext({ sessionId: "runtime-session" });
    writeFileSync(path.join(ctx.worktreePath, ".env"), "AGENTDOCK_SESSION_ID=file-session\n");
    const hook = makeHook({
      run: isWin ? "echo %AGENTDOCK_SESSION_ID%" : "printf '%s' \"$AGENTDOCK_SESSION_ID\"",
    });
    const result = await engine.executeOne(hook, ctx);
    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe("runtime-session");
  });
});

// ============================================================
// C21–C31: HookEngine.execute
// ============================================================
describe("HookEngine.execute", () => {
  let registry: ReturnType<typeof createHookRegistry>;
  let engine: ReturnType<typeof createHookEngine>;

  beforeEach(() => {
    registry = createHookRegistry();
    engine = createHookEngine(registry);
  });

  it("C21: 无注册 hooks 时返回成功", async () => {
    const ctx = makeContext();
    const report = await engine.execute("afterCreateSession", ctx);
    expect(report.success).toBe(true);
    expect(report.results).toEqual([]);
  });

  it("C22: 单个 optional hook 成功", async () => {
    registry.register("afterCreateSession", makeHook({ run: echoCmd("ok"), required: false }));
    const ctx = makeContext();
    const report = await engine.execute("afterCreateSession", ctx);
    expect(report.success).toBe(true);
    expect(report.results).toHaveLength(1);
    expect(report.results[0].success).toBe(true);
  });

  it("C23: 单个 required hook 成功", async () => {
    registry.register("afterCreateSession", makeHook({ run: echoCmd("ok"), required: true }));
    const ctx = makeContext();
    const report = await engine.execute("afterCreateSession", ctx);
    expect(report.success).toBe(true);
    expect(report.results).toHaveLength(1);
  });

  it("C24: optional hook 失败不中断 pipeline", async () => {
    registry.register("afterCreateSession", makeHook({ run: exitCmd(1), required: false }));
    registry.register("afterCreateSession", makeHook({ run: echoCmd("ok"), required: false }));
    const ctx = makeContext();
    const report = await engine.execute("afterCreateSession", ctx);
    expect(report.results).toHaveLength(2);
    expect(report.results[0].success).toBe(false);
    expect(report.results[1].success).toBe(true);
    expect(report.success).toBe(true);
  });

  it("C25: required hook 失败中断 pipeline", async () => {
    registry.register("afterCreateSession", makeHook({ run: exitCmd(1), required: true }));
    registry.register(
      "afterCreateSession",
      makeHook({ run: echoCmd("should-not-run"), required: false }),
    );
    const ctx = makeContext();
    const report = await engine.execute("afterCreateSession", ctx);
    expect(report.results).toHaveLength(1);
    expect(report.results[0].success).toBe(false);
    expect(report.success).toBe(false);
  });

  it("C26: 多个 optional hooks 全部失败仍 success=true", async () => {
    registry.register("afterCreateSession", makeHook({ run: exitCmd(1), required: false }));
    registry.register("afterCreateSession", makeHook({ run: exitCmd(1), required: false }));
    registry.register("afterCreateSession", makeHook({ run: exitCmd(1), required: false }));
    const ctx = makeContext();
    const report = await engine.execute("afterCreateSession", ctx);
    expect(report.results).toHaveLength(3);
    expect(report.success).toBe(true);
  });

  it("C27: required hook 在 optional 之后失败", async () => {
    registry.register("afterCreateSession", makeHook({ run: echoCmd("ok"), required: false }));
    registry.register("afterCreateSession", makeHook({ run: exitCmd(1), required: false }));
    registry.register("afterCreateSession", makeHook({ run: exitCmd(1), required: true }));
    const ctx = makeContext();
    const report = await engine.execute("afterCreateSession", ctx);
    expect(report.results).toHaveLength(3);
    expect(report.results[0].success).toBe(true);
    expect(report.results[1].success).toBe(false);
    expect(report.results[2].success).toBe(false);
    expect(report.success).toBe(false);
  });

  it("C28: execute 执行顺序与注册顺序一致", async () => {
    const tmpFile = path.join(os.tmpdir(), `hook-order-${Date.now()}.txt`);
    registry.register(
      "afterCreateSession",
      makeHook({
        run: `${echoCmd("hook1")} >> "${tmpFile}"`,
        required: false,
      }),
    );
    registry.register(
      "afterCreateSession",
      makeHook({
        run: `${echoCmd("hook2")} >> "${tmpFile}"`,
        required: false,
      }),
    );
    registry.register(
      "afterCreateSession",
      makeHook({
        run: `${echoCmd("hook3")} >> "${tmpFile}"`,
        required: false,
      }),
    );

    const ctx = makeContext();
    await engine.execute("afterCreateSession", ctx);

    const content = readFileSync(tmpFile, "utf-8");
    const lines = content.trim().split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("hook1");
    expect(lines[1]).toContain("hook2");
    expect(lines[2]).toContain("hook3");

    try {
      rmSync(tmpFile);
    } catch {}
  });

  it("C29: HookContext 环境变量可被命令访问", async () => {
    const hook = makeHook({
      run: isWin ? "echo %AGENTDOCK_SESSION_ID%" : "echo $AGENTDOCK_SESSION_ID",
    });
    const ctx = makeContext({ sessionId: "my-session-123" });
    const result = await engine.executeOne(hook, ctx);
    expect(result.stdout).toContain("my-session-123");
  });

  it("C30: HookReport.duration >= sum(results.duration)", async () => {
    registry.register("afterCreateSession", makeHook({ run: echoCmd("a") }));
    registry.register("afterCreateSession", makeHook({ run: echoCmd("b") }));
    const ctx = makeContext();
    const report = await engine.execute("afterCreateSession", ctx);
    const sumResults = report.results.reduce((s, r) => s + r.duration, 0);
    expect(report.duration).toBeGreaterThanOrEqual(sumResults - 5);
  });

  it("C31: required hook 超时中断 pipeline", async () => {
    registry.register(
      "afterCreateSession",
      makeHook({
        run: sleepCmd(10),
        required: true,
        timeout: 200,
      }),
    );
    registry.register(
      "afterCreateSession",
      makeHook({
        run: echoCmd("should-not-run"),
        required: false,
      }),
    );
    const ctx = makeContext();
    const report = await engine.execute("afterCreateSession", ctx);
    expect(report.results).toHaveLength(1);
    expect(report.results[0].timedOut).toBe(true);
    expect(report.success).toBe(false);
  });
});

// ============================================================
// C32–C33: 跨平台兼容
// ============================================================
describe("跨平台兼容", () => {
  let registry: ReturnType<typeof createHookRegistry>;
  let engine: ReturnType<typeof createHookEngine>;

  beforeEach(() => {
    registry = createHookRegistry();
    engine = createHookEngine(registry);
  });

  it("C32: 平台自动选择 shell 执行 echo", async () => {
    const hook = makeHook({ run: echoCmd("hello") });
    const ctx = makeContext();
    const result = await engine.executeOne(hook, ctx);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain("hello");
  });

  it("C33: 多行命令执行", async () => {
    const hook = makeHook({ run: `${echoCmd("line1")} && ${echoCmd("line2")}` });
    const ctx = makeContext();
    const result = await engine.executeOne(hook, ctx);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain("line1");
    expect(result.stdout).toContain("line2");
  });
});
