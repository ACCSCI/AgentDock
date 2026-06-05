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
