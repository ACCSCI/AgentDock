/**
 * git worktree 当前分支现查 (新架构 §4.1 + §7.3).
 *
 *   - DB 不存 branch (派生字段不入库)
 *   - session 激活后, 现拼 worktreePath = <projectRoot>/.agentdock/worktrees/<sessionId>
 *   - 跑 `git -C <worktreePath> symbolic-ref --short HEAD` 拿当前分支
 *   - 失败 (worktree 不存在 / 不是 git 目录) 返回 null, 不抛
 *
 * 用于 session-created SSE 事件 + 任何"现查"路径.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LookupBranchDeps {
  /** Override exec (tests). */
  execImpl?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

export async function lookupCurrentBranch(
  projectRoot: string,
  sessionId: string,
  deps: LookupBranchDeps = {},
): Promise<string | null> {
  const worktreePath = path.join(projectRoot, ".agentdock", "worktrees", sessionId);
  const exec = deps.execImpl ?? defaultExec;
  try {
    const { stdout } = await exec("git", ["-C", worktreePath, "symbolic-ref", "--short", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    // worktree 不存在 / 不是 git 目录 / detached HEAD — 返回 null
    return null;
  }
}

async function defaultExec(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(cmd, args);
}
