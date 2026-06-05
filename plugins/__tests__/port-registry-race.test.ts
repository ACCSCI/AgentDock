import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSessionLifecycle } from "../session-lifecycle.js";
import { getSessionPorts, loadRegistry } from "../port-registry.js";
import type { AgentDockConfig } from "../config.js";

let projectDir: string;

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
  };
}

beforeEach(() => {
  projectDir = path.join(os.tmpdir(), `ad-race-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(projectDir, { recursive: true });
  initGitRepo(projectDir);
});

afterEach(() => {
  if (existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ============================================================
// R1–R4: assignSessionPorts 并行竞态 (Lost Update)
// ============================================================
describe("assignSessionPorts 并行竞态 — Lost Update", () => {
  it("R1: 并行 create 2 个 session，registry 应包含两者 (原始 P4 失败用例)", async () => {
    const lifecycle = createSessionLifecycle();
    // 这是原始 P4 中失败的写法：并行 create
    const created = await Promise.all(
      ["r1-s1", "r1-s2"].map((id) =>
        lifecycle.create({
          projectId: "proj-race",
          projectPath: projectDir,
          sessionId: id,
          sessionName: id,
          config: defaultConfig(),
        })
      ),
    );

    // 两个 session 都应该有 worktree
    for (const c of created) {
      expect(existsSync(c.worktreePath)).toBe(true);
    }

    // ⚠️ 这个断言就是原始 P4 失败的地方
    // 并行 create 时 registry 有 read-modify-write 竞态，后写入者覆盖先写入者
    expect(await getSessionPorts(projectDir, "r1-s1")).not.toBeNull();
    expect(await getSessionPorts(projectDir, "r1-s2")).not.toBeNull();

    // registry 应该有 2 条记录
    const entries = loadRegistry(projectDir);
    expect(entries).toHaveLength(2);
  });

  it("R2: 并行 create 3 个 session，registry 应包含全部", async () => {
    const lifecycle = createSessionLifecycle();
    await Promise.all(
      ["r2-s1", "r2-s2", "r2-s3"].map((id) =>
        lifecycle.create({
          projectId: "proj-race",
          projectPath: projectDir,
          sessionId: id,
          sessionName: id,
          config: defaultConfig(),
        }),
      ),
    );

    // ⚠️ 并行 create 竞态：3 个并发的 read-modify-write 只能保留最后 1 个
    expect(await getSessionPorts(projectDir, "r2-s1")).not.toBeNull();
    expect(await getSessionPorts(projectDir, "r2-s2")).not.toBeNull();
    expect(await getSessionPorts(projectDir, "r2-s3")).not.toBeNull();

    const entries = loadRegistry(projectDir);
    expect(entries).toHaveLength(3);
  });

  it("R3: 并行 create 5 个 session，registry 应包含全部", async () => {
    const lifecycle = createSessionLifecycle();
    const ids = Array.from({ length: 5 }, (_, i) => `r3-s${i + 1}`);
    await Promise.all(
      ids.map((id) =>
        lifecycle.create({
          projectId: "proj-race",
          projectPath: projectDir,
          sessionId: id,
          sessionName: id,
          config: defaultConfig(),
        }),
      ),
    );

    // ⚠️ 并行 create 竞态：5 个并发只保留最后 1 个
    for (const id of ids) {
      expect(await getSessionPorts(projectDir, id)).not.toBeNull();
    }
    expect(loadRegistry(projectDir)).toHaveLength(5);
  });

  it("R4: 并行 create 后并行 delete，端口应全部释放可重分配", async () => {
    const lifecycle = createSessionLifecycle();
    const created = await Promise.all(
      ["r4-s1", "r4-s2", "r4-s3"].map((id) =>
        lifecycle.create({
          projectId: "proj-race",
          projectPath: projectDir,
          sessionId: id,
          sessionName: id,
          config: defaultConfig(),
        }),
      ),
    );

    await Promise.all(
      created.map((c) =>
        lifecycle.remove({
          sessionId: c.sessionId,
          projectPath: projectDir,
          worktreePath: c.worktreePath,
          config: defaultConfig(),
        }),
      ),
    );

    // 所有端口应释放，可重新分配
    const recreated = await Promise.all(
      ["r4-s1", "r4-s2", "r4-s3"].map((id) =>
        lifecycle.create({
          projectId: "proj-race",
          projectPath: projectDir,
          sessionId: id,
          sessionName: `${id}-re`,
          config: defaultConfig(),
        }),
      ),
    );
    for (const r of recreated) {
      expect(r.ports.FRONTEND_PORT).toBeGreaterThan(0);
      expect(existsSync(r.worktreePath)).toBe(true);
    }
  });
});

// ============================================================
// R5–R6: releaseSessionPorts 并行竞态 (Over-Release)
// ============================================================
describe("releaseSessionPorts 并行竞态 — Over-Release", () => {
  it("R5: 并行 delete 2 个 session，registry 应为空", async () => {
    const lifecycle = createSessionLifecycle();
    // 串行 create 避免 create 竞态，单独测试 delete 竞态
    const c1 = await lifecycle.create({
      projectId: "proj-race",
      projectPath: projectDir,
      sessionId: "r5-s1",
      sessionName: "r5-s1",
      config: defaultConfig(),
    });
    const c2 = await lifecycle.create({
      projectId: "proj-race",
      projectPath: projectDir,
      sessionId: "r5-s2",
      sessionName: "r5-s2",
      config: defaultConfig(),
    });
    expect(loadRegistry(projectDir)).toHaveLength(2);

    // 并行 delete — 各自读到 [{s1}, {s2}]，各自 splice 不同 index
    // 理论上可正确删除，但后写入者覆盖前写入者的 saveRegistry 结果
    await Promise.all([
      lifecycle.remove({
        sessionId: "r5-s1",
        projectPath: projectDir,
        worktreePath: c1.worktreePath,
        config: defaultConfig(),
      }),
      lifecycle.remove({
        sessionId: "r5-s2",
        projectPath: projectDir,
        worktreePath: c2.worktreePath,
        config: defaultConfig(),
      }),
    ]);

    // ⚠️ 竞态可能导致 registry 残留旧数据
    expect(await getSessionPorts(projectDir, "r5-s1")).toBeNull();
    expect(await getSessionPorts(projectDir, "r5-s2")).toBeNull();
    expect(loadRegistry(projectDir)).toHaveLength(0);
  });

  it("R6: 并行 delete 3 个 session 后端口可全部重新分配", async () => {
    const lifecycle = createSessionLifecycle();
    const c1 = await lifecycle.create({
      projectId: "proj-race",
      projectPath: projectDir,
      sessionId: "r6-s1",
      sessionName: "r6-s1",
      config: defaultConfig(),
    });
    const c2 = await lifecycle.create({
      projectId: "proj-race",
      projectPath: projectDir,
      sessionId: "r6-s2",
      sessionName: "r6-s2",
      config: defaultConfig(),
    });
    const c3 = await lifecycle.create({
      projectId: "proj-race",
      projectPath: projectDir,
      sessionId: "r6-s3",
      sessionName: "r6-s3",
      config: defaultConfig(),
    });

    await Promise.all([
      lifecycle.remove({ sessionId: "r6-s1", projectPath: projectDir, worktreePath: c1.worktreePath, config: defaultConfig() }),
      lifecycle.remove({ sessionId: "r6-s2", projectPath: projectDir, worktreePath: c2.worktreePath, config: defaultConfig() }),
      lifecycle.remove({ sessionId: "r6-s3", projectPath: projectDir, worktreePath: c3.worktreePath, config: defaultConfig() }),
    ]);

    // ⚠️ 如果并行 delete 竞态导致 registry 残留，重新分配时会跳过已 "释放" 的端口
    // 或者找不到可用端口
    const r1 = await lifecycle.create({
      projectId: "proj-race",
      projectPath: projectDir,
      sessionId: "r6-s1",
      sessionName: "r6-s1-re",
      config: defaultConfig(),
    });
    expect(r1.ports.FRONTEND_PORT).toBeGreaterThan(0);
  });
});

// ============================================================
// R7–R8: 并行 create + delete 混合竞态
// ============================================================
describe("并行 create + delete 混合竞态", () => {
  it("R7: 并行 create 与 delete 交织，最终 registry 一致", async () => {
    const lifecycle = createSessionLifecycle();
    // 先串行建一个
    const c1 = await lifecycle.create({
      projectId: "proj-race",
      projectPath: projectDir,
      sessionId: "r7-s0",
      sessionName: "r7-s0",
      config: defaultConfig(),
    });

    // 并行：删 s0 + 建 s1, s2
    await Promise.all([
      lifecycle.remove({
        sessionId: "r7-s0",
        projectPath: projectDir,
        worktreePath: c1.worktreePath,
        config: defaultConfig(),
      }),
      lifecycle.create({
        projectId: "proj-race",
        projectPath: projectDir,
        sessionId: "r7-s1",
        sessionName: "r7-s1",
        config: defaultConfig(),
      }),
      lifecycle.create({
        projectId: "proj-race",
        projectPath: projectDir,
        sessionId: "r7-s2",
        sessionName: "r7-s2",
        config: defaultConfig(),
      }),
    ]);

    // ⚠️ 并行 create+delete 混合竞态：registry 结果不确定
    // 可能丢失 s1/s2 的记录，或残留 s0 的记录
    const entries = loadRegistry(projectDir);
    expect(entries).toHaveLength(2);
    expect(await getSessionPorts(projectDir, "r7-s0")).toBeNull();
    expect(await getSessionPorts(projectDir, "r7-s1")).not.toBeNull();
    expect(await getSessionPorts(projectDir, "r7-s2")).not.toBeNull();
  });
});

// ============================================================
// R9: 端口分配不应冲突（即使 registry 竞态丢失）
// ============================================================
describe("端口分配稳定性", () => {
  it("R9: 并行 create 不应分配相同端口（即使 registry 丢失）", async () => {
    const lifecycle = createSessionLifecycle();
    const created = await Promise.all(
      ["r9-s1", "r9-s2", "r9-s3"].map((id) =>
        lifecycle.create({
          projectId: "proj-race",
          projectPath: projectDir,
          sessionId: id,
          sessionName: id,
          config: defaultConfig(),
        }),
      ),
    );

    // 即使 registry 有竞态，每个 session 的 .env 应有不同的端口值
    const envPaths = created.map((c) => path.join(c.worktreePath, ".env"));
    for (const p of envPaths) {
      expect(existsSync(p)).toBe(true);
    }

    // 各 session 实际分配的端口不应重复（TCP bind 检查保证了这一点）
    const allPorts = created.map((c) => c.ports.FRONTEND_PORT);
    const unique = new Set(allPorts);
    // ⚠️ 如果 allocatePorts 的 TCP bind 检查也不隔离，这里可能失败
    expect(unique.size).toBe(created.length);
  });
});
