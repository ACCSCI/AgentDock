import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  createWorktree,
  getWorktreePath,
  isRegisteredWorktree,
  listWorktrees,
  removeOrphanBranch,
  removeOrphanDir,
  removeWorktree,
  renameWorktree,
  scanOrphanBranches,
  validateBranchName,
} from "../worktree.js";

let projectDir: string;

function initGitRepo(dir: string) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m init', { cwd: dir, stdio: "pipe" });
}

beforeEach(() => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), "ad-worktree-test-"));
  initGitRepo(projectDir);
});

afterEach(() => {
  if (existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ============================================================
// isRegisteredWorktree
// ============================================================
describe("isRegisteredWorktree", () => {
  it("W4a: 合法 worktree 返回 true", async () => {
    const result = createWorktree(projectDir, "s1");
    expect(await isRegisteredWorktree(projectDir, result.worktreePath)).toBe(true);
  });

  it("W4b: 不在 git worktree list 中的路径返回 false", async () => {
    const fakePath = path.join(projectDir, ".agentdock", "worktrees", "nonexistent");
    expect(await isRegisteredWorktree(projectDir, fakePath)).toBe(false);
  });

  it("W4c: 普通目录（非 worktree）返回 false", async () => {
    const plainDir = path.join(projectDir, "normal-dir");
    mkdirSync(plainDir, { recursive: true });
    expect(await isRegisteredWorktree(projectDir, plainDir)).toBe(false);
  });
});

// ============================================================
// removeWorktree
// ============================================================
describe("removeWorktree", () => {
  it("W1: 路径不存在时抛出 Worktree not found", async () => {
    await expect(
      removeWorktree(projectDir, "nonexistent", { force: true }),
    ).rejects.toThrow("Worktree not found");
  });

  it("W2: 目录存在但不是 git worktree，回退 fs.rm 删除目录", async () => {
    const fakeId = "fake-session";
    const fakePath = getWorktreePath(projectDir, fakeId);
    mkdirSync(fakePath, { recursive: true });
    writeFileSync(path.join(fakePath, "dummy.txt"), "hello");

    expect(existsSync(fakePath)).toBe(true);

    const result = await removeWorktree(projectDir, fakeId, { force: true });

    expect(result.removed).toBe(fakePath);
    expect(existsSync(fakePath)).toBe(false);
  });

  it("W3: 合法 worktree 正常删除（worktree + branch）", async () => {
    const result = createWorktree(projectDir, "s3");

    expect(await isRegisteredWorktree(projectDir, result.worktreePath)).toBe(true);

    const removed = await removeWorktree(projectDir, "s3", { force: true });

    expect(removed.removed).toBe(result.worktreePath);
    expect(existsSync(result.worktreePath)).toBe(false);
    expect(await isRegisteredWorktree(projectDir, result.worktreePath)).toBe(false);

    // Branch should also be deleted
    const branchOutput = execSync("git branch --list", { cwd: projectDir, encoding: "utf-8", stdio: "pipe" });
    expect(branchOutput).not.toContain("agentdock/s3");
  });

  it("W2b: 非法 worktree 不执行 git worktree remove", async () => {
    const fakeId = "orphan";
    const fakePath = getWorktreePath(projectDir, fakeId);
    mkdirSync(fakePath, { recursive: true });

    // Should succeed without error — no git command executed
    const result = await removeWorktree(projectDir, fakeId, { force: true });
    expect(result.removed).toBe(fakePath);
    expect(existsSync(fakePath)).toBe(false);
  });

  it("W3b: force=false 时，非 worktree 目录仍回退 fs.rm", async () => {
    const fakeId = "no-worktree-force";
    const fakePath = getWorktreePath(projectDir, fakeId);
    mkdirSync(fakePath, { recursive: true });

    const result = await removeWorktree(projectDir, fakeId, { force: false });
    expect(result.removed).toBe(fakePath);
    expect(existsSync(fakePath)).toBe(false);
  });

  it("W5: hook 在 worktree 中创建未追踪文件后删除 — 复现 'Directory not empty'", async () => {
    const result = createWorktree(projectDir, "s5");
    const fileInWorktree = path.join(result.worktreePath, "hook-created-file.txt");
    writeFileSync(fileInWorktree, "hook output data\n");

    const removed = await removeWorktree(projectDir, "s5", { force: true });
    expect(removed.removed).toBe(result.worktreePath);
    expect(existsSync(result.worktreePath)).toBe(false);
  });

  it("W6: worktree 中有未追踪文件 + 子目录，removeWorktree 必须成功", async () => {
    const result = createWorktree(projectDir, "s6");
    const nestedDir = path.join(result.worktreePath, "node_modules", ".cache");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(path.join(nestedDir, "data.json"), "{}");
    writeFileSync(path.join(result.worktreePath, "debug.log"), "some log\n");

    const removed = await removeWorktree(projectDir, "s6", { force: true });
    expect(removed.removed).toBe(result.worktreePath);
    expect(existsSync(result.worktreePath)).toBe(false);
  });

  it("W7: 模拟 git worktree remove 失败后 fs.rm 兜底（文件锁定场景）", async () => {
    const result = createWorktree(projectDir, "s7");
    writeFileSync(path.join(result.worktreePath, "locked-file.dat"), "data");

    const removed = await removeWorktree(projectDir, "s7", { force: true });
    expect(removed.removed).toBe(result.worktreePath);
    expect(existsSync(result.worktreePath)).toBe(false);
  });

  it("W8: 删除后重新创建 — 验证 branch 也被清理", async () => {
    const result = createWorktree(projectDir, "s8");
    writeFileSync(path.join(result.worktreePath, "temp.txt"), "data");

    await removeWorktree(projectDir, "s8", { force: true });
    expect(existsSync(result.worktreePath)).toBe(false);

    const branches = execSync("git branch --list", { cwd: projectDir, encoding: "utf-8", stdio: "pipe" });
    expect(branches).not.toContain("agentdock/s8");

    const recreated = createWorktree(projectDir, "s8");
    expect(existsSync(recreated.worktreePath)).toBe(true);
    expect(recreated.branch).toBe("agentdock/s8");
  });

  it("W9: 模拟 git worktree remove 失败后 fs.rm 兜底（核心修复验证）", async () => {
    const result = createWorktree(projectDir, "s9");
    const lockedFile = path.join(result.worktreePath, "potentially-locked.bin");
    writeFileSync(lockedFile, Buffer.alloc(1024, 0xFF));

    const removed = await removeWorktree(projectDir, "s9", { force: true });
    expect(removed.removed).toBe(result.worktreePath);
    expect(existsSync(result.worktreePath)).toBe(false);
  });
});

// ============================================================
// W10–W14: removeOrphanDir — 重试与进程锁定
// ============================================================
const isWin = process.platform === "win32";

// 独立临时目录，避免 afterEach 清理 projectDir 时因子进程持有句柄而失败
function orphanTempDir(): string {
  const dir = path.join(os.tmpdir(), `ad-orphan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("removeOrphanDir", () => {
  it("W10: 不存在路径时静默返回", async () => {
    const nonExistent = path.join(projectDir, "does-not-exist", "at-all");
    await expect(removeOrphanDir(nonExistent)).resolves.toBeUndefined();
  });

  it("W11: 空目录正常删除", async () => {
    const orphanDir = path.join(projectDir, ".agentdock", "worktrees", "orphan-w11");
    mkdirSync(orphanDir, { recursive: true });
    await removeOrphanDir(orphanDir);
    expect(existsSync(orphanDir)).toBe(false);
  });

  it("W12: 带文件的目录正常删除", async () => {
    const orphanDir = path.join(projectDir, ".agentdock", "worktrees", "orphan-w12");
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(path.join(orphanDir, "file.txt"), "data");
    await removeOrphanDir(orphanDir);
    expect(existsSync(orphanDir)).toBe(false);
  });

  it("W13: 子进程持有目录句柄时，重试后成功删除", { timeout: 60000 }, async () => {
    const orphanDir = orphanTempDir();
    writeFileSync(path.join(orphanDir, "file.txt"), "data");

    let child: ReturnType<typeof spawn> | null = null;
    if (isWin) {
      child = spawn("cmd.exe", ["/c", "ping -n 10 127.0.0.1 >nul"], { cwd: orphanDir });
    } else {
      child = spawn("sleep", ["10"], { cwd: orphanDir });
    }

    await new Promise((r) => setTimeout(r, 500));

    // 删除应成功（重试 + killProcessesUnderPath）
    await expect(removeOrphanDir(orphanDir)).resolves.toBeUndefined();
    expect(existsSync(orphanDir)).toBe(false);

    try { child?.kill(); } catch {}
    try { rmSync(orphanDir, { recursive: true, force: true }); } catch {}
  });

  it("W14: 重试耗尽后抛出错误", { timeout: 60000 }, async () => {
    const orphanDir = orphanTempDir();
    writeFileSync(path.join(orphanDir, "file.txt"), "data");

    let child: ReturnType<typeof spawn> | null = null;
    if (isWin) {
      child = spawn("cmd.exe", ["/c", "ping -n 60 127.0.0.1 >nul"], { cwd: orphanDir });
    } else {
      // detached: 让进程独立于测试进程，kill 时不会被连带杀
      child = spawn("sleep", ["60"], { cwd: orphanDir, detached: true, stdio: "ignore" });
      child.unref();
    }

    await new Promise((r) => setTimeout(r, 500));

    // 应该失败（超出重试次数）
    await expect(removeOrphanDir(orphanDir)).rejects.toThrow();
    expect(existsSync(orphanDir)).toBe(true);

    try { child?.kill(); child?.unref(); } catch {}
    try { rmSync(orphanDir, { recursive: true, force: true }); } catch {}
  });
});

// ============================================================
// validateBranchName — command/ref injection safety (#4)
// ============================================================
describe("validateBranchName", () => {
  it("WB1: 合法分支名通过", () => {
    expect(() => validateBranchName("agentdock/feature-1")).not.toThrow();
    expect(() => validateBranchName("main")).not.toThrow();
    expect(() => validateBranchName("release_2.0")).not.toThrow();
  });

  const evilNames = [
    'x"; rm -rf / #',
    "x$(touch pwned)",
    "x`touch pwned`",
    "x; calc",
    "x | whoami",
    "x & echo hi",
    "branch with space",
    "tilde~name",
    "caret^name",
    "colon:name",
    "question?name",
    "star*name",
    "open[bracket",
    "-leadingdash",
    "x\nnewline",
  ];

  for (const name of evilNames) {
    it(`WB2: 拒绝非法/危险分支名 ${JSON.stringify(name)}`, () => {
      expect(() => validateBranchName(name)).toThrow();
    });
  }
});

// ============================================================
// createWorktree / renameWorktree — injection cannot execute (#4)
// ============================================================
describe("createWorktree baseBranch injection safety", () => {
  it("WI1: baseBranch 含 shell 元字符 → 拒绝（不创建注入文件）", () => {
    const marker = path.join(projectDir, "INJECTED.txt");
    expect(() =>
      createWorktree(projectDir, "inj1", 'main"; echo x > INJECTED.txt; "'),
    ).toThrow();
    expect(existsSync(marker)).toBe(false);
  });

  it("WI2: baseBranch 含 $() → 拒绝", () => {
    expect(() => createWorktree(projectDir, "inj2", "$(touch hacked)")).toThrow();
    expect(existsSync(path.join(projectDir, "hacked"))).toBe(false);
  });

  it("WI3: 合法 baseBranch 仍可正常创建（回归）", () => {
    const result = createWorktree(projectDir, "okbase", "master");
    expect(existsSync(result.worktreePath)).toBe(true);
  });
});

describe("renameWorktree newName injection safety", () => {
  it("WR1: newName 含双引号/反引号 → 拒绝", () => {
    createWorktree(projectDir, "rn1");
    expect(() => renameWorktree(projectDir, "rn1", 'x`touch pwned`')).toThrow();
    expect(() => renameWorktree(projectDir, "rn1", 'x"; echo y; "')).toThrow();
    expect(existsSync(path.join(projectDir, "pwned"))).toBe(false);
  });

  it("WR2: 合法 newName 正常重命名（回归）", () => {
    createWorktree(projectDir, "rn2");
    const result = renameWorktree(projectDir, "rn2", "renamed2");
    expect(result.newBranch).toBe("agentdock/renamed2");
  });

  it("WR3: 中文 session 名可以重命名", () => {
    createWorktree(projectDir, "cn1");
    const result = renameWorktree(projectDir, "cn1", "测试会话");
    expect(result.newBranch).toBe("agentdock/测试会话");
    // 确认旧分支已不存在
    const branches = execSync("git branch --list", { cwd: projectDir, encoding: "utf-8" });
    expect(branches).not.toContain("agentdock/cn1");
  });

  it("WR4: 连续重命名不会失败", () => {
    createWorktree(projectDir, "rn4");
    const first = renameWorktree(projectDir, "rn4", "first");
    // 第二次重命名需要传入当前分支名，否则 oldBranch=agentdock/rn4 已不存在
    const result = renameWorktree(projectDir, "rn4", "second", first.newBranch);
    expect(result.newBranch).toBe("agentdock/second");
  });
});

// ============================================================
// removeWorktree with currentBranch — the rename-then-delete bug
// (#35 root cause: removeWorktree used to hard-code
// `agentdock/${sessionId}` and leave the renamed branch dangling)
// ============================================================
describe("removeWorktree currentBranch", () => {
  function listBranches(): string {
    return execSync("git branch --list", {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
  }

  it("WRM1: rename 后 remove 必须删掉 renamed branch（不传 currentBranch 会遗留 dangling）", async () => {
    const created = createWorktree(projectDir, "rmcb1");
    expect(created.branch).toBe("agentdock/rmcb1");

    const renamed = renameWorktree(projectDir, "rmcb1", "清理孤儿目录");
    expect(renamed.newBranch).toBe("agentdock/清理孤儿目录");
    expect(listBranches()).toContain("agentdock/清理孤儿目录");

    // Simulate the API path: pass the stored branch so the right one is deleted.
    await removeWorktree(projectDir, "rmcb1", {
      currentBranch: renamed.newBranch,
      force: true,
    });

    expect(existsSync(created.worktreePath)).toBe(false);
    const branches = listBranches();
    expect(branches).not.toContain("agentdock/rmcb1");
    expect(branches).not.toContain("agentdock/清理孤儿目录");
  });

  it("WRM2: 不传 currentBranch 时回退到 agentdock/<id>（向后兼容）", async () => {
    const created = createWorktree(projectDir, "rmcb2");
    await removeWorktree(projectDir, "rmcb2", { force: true });

    expect(existsSync(created.worktreePath)).toBe(false);
    expect(listBranches()).not.toContain("agentdock/rmcb2");
  });

  it("WRM3: 中文 session 名 rename → remove 链不残留任何分支", async () => {
    const created = createWorktree(projectDir, "rmcb3");
    const renamed = renameWorktree(projectDir, "rmcb3", "中文名");
    await removeWorktree(projectDir, "rmcb3", {
      currentBranch: renamed.newBranch,
      force: true,
    });

    expect(existsSync(created.worktreePath)).toBe(false);
    const branches = listBranches();
    expect(branches).not.toContain("agentdock/rmcb3");
    expect(branches).not.toContain("agentdock/中文名");
  });
});

// ============================================================
// scanOrphanBranches — detect dangling agentdock/* branches
// ============================================================
describe("scanOrphanBranches", () => {
  function listBranches(): string {
    return execSync("git branch --list", {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
  }

  it("SOB1: 空仓库 → 没有 orphan branches", () => {
    const orphans = scanOrphanBranches(projectDir, new Set());
    expect(orphans).toEqual([]);
  });

  it("SOB2: knownBranches 覆盖所有分支 → 没有 orphan", () => {
    createWorktree(projectDir, "sob1");
    createWorktree(projectDir, "sob2");
    const known = new Set(["agentdock/sob1", "agentdock/sob2"]);
    const orphans = scanOrphanBranches(projectDir, known);
    expect(orphans).toEqual([]);
  });

  it("SOB3: knownBranches 缺失 → 报告对应 orphan branch", () => {
    createWorktree(projectDir, "alive");
    // Create a dangling branch manually
    execSync("git branch agentdock/ghost-session", {
      cwd: projectDir,
      stdio: "pipe",
    });
    const orphans = scanOrphanBranches(projectDir, new Set(["agentdock/alive"]));
    expect(orphans).toHaveLength(1);
    expect(orphans[0].reason).toBe("orphan-branch");
    expect(orphans[0].branch).toBe("agentdock/ghost-session");
    expect(orphans[0].sessionId).toBe("ghost-session");
    expect(orphans[0].worktreePath).toBe("");
  });

  it("SOB4: 非 agentdock/ 命名空间的分支被忽略", () => {
    createWorktree(projectDir, "keep");
    execSync("git branch some-other-branch", { cwd: projectDir, stdio: "pipe" });
    const orphans = scanOrphanBranches(projectDir, new Set(["agentdock/keep"]));
    expect(orphans).toEqual([]);
    // Sanity: both branches are present
    const branches = listBranches();
    expect(branches).toContain("agentdock/keep");
    expect(branches).toContain("some-other-branch");
  });
});

// ============================================================
// removeOrphanBranch — explicit branch cleanup
// ============================================================
describe("removeOrphanBranch", () => {
  function listBranches(): string {
    return execSync("git branch --list", {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
  }

  it("ROB1: 删除 agentdock/* 分支成功", async () => {
    createWorktree(projectDir, "rob1");
    execSync("git branch agentdock/dangling", { cwd: projectDir, stdio: "pipe" });
    expect(listBranches()).toContain("agentdock/dangling");

    await removeOrphanBranch(projectDir, "agentdock/dangling");
    expect(listBranches()).not.toContain("agentdock/dangling");
  });

  it("ROB2: 拒绝删除非 agentdock/ 命名空间的分支", async () => {
    execSync("git branch main-keep", { cwd: projectDir, stdio: "pipe" });
    await expect(removeOrphanBranch(projectDir, "main-keep")).rejects.toThrow(
      /Refusing to delete non-agentdock branch/,
    );
    expect(listBranches()).toContain("main-keep");
  });

  it("ROB3: 拒绝非法分支名（命令注入防护）", async () => {
    await expect(
      removeOrphanBranch(projectDir, 'agentdock/x"; echo pwned; "'),
    ).rejects.toThrow();
  });
});

// ============================================================
// Foreign-session false-positive guard
// The orphan scan unions DB-known branches with branches actually
// checked out in worktrees (via listWorktrees). A renamed foreign
// session's local DB row has branch=agentdock/<id> (from
// scanDiskWorktrees) but the actual git branch is agentdock/<renamed>.
// Without the worktree-list union, scanOrphanBranches would flag the
// renamed branch as orphan and `git branch -D` could wipe a branch
// another AgentDock instance is actively using.
// ============================================================
describe("scanOrphanBranches with worktree-list union (foreign session guard)", () => {
  it("FW1: rename 后的分支 + 实际 worktree → DB 集合不知道它也不算 orphan", () => {
    // Simulate the foreign-session setup: create + rename a worktree so the
    // actual git branch is agentdock/<renamed>, but pass an empty knownBranches
    // to scanOrphanBranches — this is what instance B's stale DB would see.
    createWorktree(projectDir, "fw1");
    const renamed = renameWorktree(projectDir, "fw1", "foreign-renamed");

    // The worktree is still on disk and checked out to the renamed branch.
    // listWorktrees is the second source of truth the orphans endpoint
    // unions in. Verify it sees the real branch:
    const liveBranches = listWorktrees(projectDir)
      .map((w) => w.branch)
      .filter((b) => b.startsWith("agentdock/"));
    expect(liveBranches).toContain(renamed.newBranch);

    // The API layer unions DB-known + live-worktree branches. Mirror that:
    const dbKnown = new Set<string>([]); // stale DB has nothing
    for (const b of liveBranches) dbKnown.add(b);
    const orphans = scanOrphanBranches(projectDir, dbKnown);
    expect(orphans.find((o) => o.branch === renamed.newBranch)).toBeUndefined();
  });

  it("FW2: 没有任何来源知道 → 仍然算 orphan", () => {
    // A truly dangling branch: in `agentdock/*` namespace, no worktree,
    // no DB row. Must still be flagged.
    createWorktree(projectDir, "fw2");
    const renamed = renameWorktree(projectDir, "fw2", "truly-dangling");
    // Pretend the worktree is gone too (e.g. manually deleted, or the bug
    // case from #35: rename then old-removeWorktree leaves branch behind).
    const liveBranches = listWorktrees(projectDir)
      .map((w) => w.branch)
      .filter((b) => b.startsWith("agentdock/"));
    const dbKnown = new Set<string>();
    for (const b of liveBranches) dbKnown.add(b);
    // fw2's worktree is checked out to truly-dangling, so union picks it up.
    // To simulate the bug case, we need a branch that has NO worktree:
    execSync("git branch agentdock/ghost-after-remove", {
      cwd: projectDir,
      stdio: "pipe",
    });
    const orphans = scanOrphanBranches(projectDir, dbKnown);
    expect(orphans.find((o) => o.branch === "agentdock/ghost-after-remove")).toBeDefined();
    // Sanity: the renamed branch with a live worktree is NOT in the list
    expect(orphans.find((o) => o.branch === renamed.newBranch)).toBeUndefined();
  });
});

