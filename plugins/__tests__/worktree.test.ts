import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorktree,
  getWorktreePath,
  isRegisteredWorktree,
  listWorktrees,
  removeWorktree,
  renameWorktree,
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
      removeWorktree(projectDir, "nonexistent", true),
    ).rejects.toThrow("Worktree not found");
  });

  it("W2: 目录存在但不是 git worktree，回退 fs.rm 删除目录", async () => {
    const fakeId = "fake-session";
    const fakePath = getWorktreePath(projectDir, fakeId);
    mkdirSync(fakePath, { recursive: true });
    writeFileSync(path.join(fakePath, "dummy.txt"), "hello");

    expect(existsSync(fakePath)).toBe(true);

    const result = await removeWorktree(projectDir, fakeId, true);

    expect(result.removed).toBe(fakePath);
    expect(existsSync(fakePath)).toBe(false);
  });

  it("W3: 合法 worktree 正常删除（worktree + branch）", async () => {
    const result = createWorktree(projectDir, "s3");

    expect(await isRegisteredWorktree(projectDir, result.worktreePath)).toBe(true);

    const removed = await removeWorktree(projectDir, "s3", true);

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
    const result = await removeWorktree(projectDir, fakeId, true);
    expect(result.removed).toBe(fakePath);
    expect(existsSync(fakePath)).toBe(false);
  });

  it("W3b: force=false 时，非 worktree 目录仍回退 fs.rm", async () => {
    const fakeId = "no-worktree-force";
    const fakePath = getWorktreePath(projectDir, fakeId);
    mkdirSync(fakePath, { recursive: true });

    const result = await removeWorktree(projectDir, fakeId, false);
    expect(result.removed).toBe(fakePath);
    expect(existsSync(fakePath)).toBe(false);
  });

  it("W5: hook 在 worktree 中创建未追踪文件后删除 — 复现 'Directory not empty'", async () => {
    const result = createWorktree(projectDir, "s5");
    const fileInWorktree = path.join(result.worktreePath, "hook-created-file.txt");
    writeFileSync(fileInWorktree, "hook output data\n");

    const removed = await removeWorktree(projectDir, "s5", true);
    expect(removed.removed).toBe(result.worktreePath);
    expect(existsSync(result.worktreePath)).toBe(false);
  });

  it("W6: worktree 中有未追踪文件 + 子目录，removeWorktree 必须成功", async () => {
    const result = createWorktree(projectDir, "s6");
    const nestedDir = path.join(result.worktreePath, "node_modules", ".cache");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(path.join(nestedDir, "data.json"), "{}");
    writeFileSync(path.join(result.worktreePath, "debug.log"), "some log\n");

    const removed = await removeWorktree(projectDir, "s6", true);
    expect(removed.removed).toBe(result.worktreePath);
    expect(existsSync(result.worktreePath)).toBe(false);
  });

  it("W7: 模拟 git worktree remove 失败后 fs.rm 兜底（文件锁定场景）", async () => {
    const result = createWorktree(projectDir, "s7");
    writeFileSync(path.join(result.worktreePath, "locked-file.dat"), "data");

    const removed = await removeWorktree(projectDir, "s7", true);
    expect(removed.removed).toBe(result.worktreePath);
    expect(existsSync(result.worktreePath)).toBe(false);
  });

  it("W8: 删除后重新创建 — 验证 branch 也被清理", async () => {
    const result = createWorktree(projectDir, "s8");
    writeFileSync(path.join(result.worktreePath, "temp.txt"), "data");

    await removeWorktree(projectDir, "s8", true);
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

    const removed = await removeWorktree(projectDir, "s9", true);
    expect(removed.removed).toBe(result.worktreePath);
    expect(existsSync(result.worktreePath)).toBe(false);
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
