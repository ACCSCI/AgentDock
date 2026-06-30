// @ts-nocheck
/**
 * F6: renameWorktree must derive the new branch from sessionId, NOT
 * from the user-supplied newName (新架构 §4.1 — 派生代码只读 sessionId).
 *
 * Bug B — renameWorktree 路径注入:
 *   plugins/worktree.ts:362 derives branch as `agentdock/${newName}`.
 *   newName is user-controlled, and even though there's a `..` / `/` / `\`
 *   early reject, **the user can still smuggle in characters that pass
 *   `validateBranchName` (e.g. 中; rm / 中文; rm)** but make the new
 *   branch name diverge from the sessionId-derived worktree path.
 *   More importantly: the design says **branch = agentdock/<sessionId>**
 *   unconditionally — `newName` should only update `displayName` (DB),
 *   not the branch.
 *
 * This test asserts that the new branch is `agentdock/<sessionId>` after
 * rename, regardless of what newName was. We can no longer derive branch
 * from newName (which can be unicode, emoji, etc., §4.1).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorktree, renameWorktree } from "../worktree.js";

let projectDir: string;

function initGitRepo(dir: string): void {
  execSync("git init -q -b main", { cwd: dir });
  execSync("git -c user.email=test@test.com -c user.name=Test commit --allow-empty -q -m init", {
    cwd: dir,
  });
}

beforeEach(() => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), "ad-wt-rename-f6-"));
  initGitRepo(projectDir);
});

afterEach(() => {
  if (existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

describe("renameWorktree — F6 branch derives from sessionId, NOT newName", () => {
  it("WRN1: 中文 newName → branch is still agentdock/<sessionId>", () => {
    createWorktree(projectDir, "sesABC");
    // Even though `validateBranchName` allows `中文;rm` (no banned chars),
    // the contract is: branch is **always** `agentdock/<sessionId>`.
    const result = renameWorktree(projectDir, "sesABC", "中文;rm");
    expect(result.newBranch).toBe("agentdock/sesABC");
    // Verify git really has this branch (not the newName-derived one).
    const branches = execSync("git branch --list", {
      cwd: projectDir,
      encoding: "utf-8",
    });
    expect(branches).toContain("agentdock/sesABC");
    expect(branches).not.toContain("agentdock/中文;rm");
  });

  it("WRN2: emoji newName → branch is still agentdock/<sessionId>", () => {
    createWorktree(projectDir, "sesDEF");
    const result = renameWorktree(projectDir, "sesDEF", "🚀✨");
    expect(result.newBranch).toBe("agentdock/sesDEF");
    const branches = execSync("git branch --list", {
      cwd: projectDir,
      encoding: "utf-8",
    });
    expect(branches).toContain("agentdock/sesDEF");
  });

  it("WRN3: simple ASCII newName → still agentdock/<sessionId> (not newName)", () => {
    // Even with safe newName, the contract is sessionId-driven. This is
    // an intentional change from prior behavior — see 新架构 §4.1.
    createWorktree(projectDir, "sesGHI");
    const result = renameWorktree(projectDir, "sesGHI", "renamed-by-user");
    expect(result.newBranch).toBe("agentdock/sesGHI");
    // Old branch was the same since the worktree is fresh; verify no
    // `agentdock/renamed-by-user` exists.
    const branches = execSync("git branch --list", {
      cwd: projectDir,
      encoding: "utf-8",
    });
    expect(branches).toContain("agentdock/sesGHI");
    expect(branches).not.toContain("agentdock/renamed-by-user");
  });

  it("WRN4: rename that includes a currentBranch hint still uses sessionId", () => {
    createWorktree(projectDir, "sesJKL");
    // Pass a currentBranch — should be ignored for derivation (we still
    // take sessionId as the source of truth).
    const result = renameWorktree(
      projectDir,
      "sesJKL",
      "another display",
      "agentdock/sesJKL",
    );
    expect(result.newBranch).toBe("agentdock/sesJKL");
  });

  it("WRN5: 连续 rename 不会导致 branch 漂移", () => {
    createWorktree(projectDir, "sesMNO");
    renameWorktree(projectDir, "sesMNO", "first");
    const result = renameWorktree(
      projectDir,
      "sesMNO",
      "second",
      "agentdock/sesMNO",
    );
    expect(result.newBranch).toBe("agentdock/sesMNO");
    const branches = execSync("git branch --list", {
      cwd: projectDir,
      encoding: "utf-8",
    });
    expect(branches).toContain("agentdock/sesMNO");
    expect(branches).not.toContain("agentdock/first");
    expect(branches).not.toContain("agentdock/second");
  });

  it("WRN6: worktree 路径保持 agentdock/worktrees/<sessionId>", () => {
    createWorktree(projectDir, "sesPQR");
    renameWorktree(projectDir, "sesPQR", "中文名;rm -rf");
    const expectedPath = path.join(
      projectDir,
      ".agentdock",
      "worktrees",
      "sesPQR",
    );
    expect(existsSync(expectedPath)).toBe(true);
  });
});
