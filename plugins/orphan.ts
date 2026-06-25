/**
 * Orphan detection, classification, and cleanup for git worktrees.
 *
 * Extracted from worktree.ts — these functions deal with detecting and
 * cleaning up "orphan" state: worktrees, branches, and directories that
 * exist on disk but are not properly tracked in the registry (DB).
 *
 * Three-way classifier (§11.3 #1):
 *   Registry (DB) ← → Git Worktree ← → Filesystem
 *   比较三方状态, 区分真实孤儿来源, 派发到正确的修复手段.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  getWorktreeBase,
  listWorktrees,
  killProcessesUnderPath,
  validateBranchName,
  rimrafOrFallback,
} from "./worktree.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// OrphanDir (legacy single-signal scanner)
// ---------------------------------------------------------------------------

export interface OrphanDir {
  sessionId: string;
  worktreePath: string;
  reason: "no-git-file" | "empty-dir" | "orphan-branch";
  /** Populated for `orphan-branch`; the agentdock/<sessionId> branch name. */
  branch?: string;
}

/**
 * Scan .agentdock/worktrees/ for directories that are NOT valid git worktrees
 * (i.e. missing .git file). These are orphaned residual directories.
 */
export function scanOrphanWorktrees(projectPath: string): OrphanDir[] {
  const baseDir = getWorktreeBase(projectPath);
  if (!existsSync(baseDir)) return [];

  const entries = readdirSync(baseDir, { withFileTypes: true });
  const result: OrphanDir[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionId = entry.name;
    const wtPath = path.join(baseDir, sessionId);
    const gitFile = path.join(wtPath, ".git");

    // Skip valid worktrees (has .git file)
    if (existsSync(gitFile)) continue;

    // Check if directory is empty
    let dirContents: string[] = [];
    try {
      dirContents = readdirSync(wtPath);
    } catch {
      continue;
    }
    const reason: OrphanDir["reason"] = dirContents.length === 0 ? "empty-dir" : "no-git-file";

    result.push({ sessionId, worktreePath: wtPath, reason });
  }

  return result;
}

/**
 * Remove an orphan directory. Kills any processes under the path first,
 * then deletes the directory recursively. Does NOT call git commands
 * since these are not registered git worktrees.
 *
 * Includes a retry loop (same pattern as removeWorktree) because processes
 * may take time to release their directory handles after being killed.
 *
 * Safety: refuses to remove the worktree base directory itself or any
 * path that doesn't look like a per-session subdirectory, preventing
 * accidental bulk deletion of all session worktrees.
 */
export async function removeOrphanDir(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) return;

  const resolved = path.resolve(dirPath);
  const basename = path.basename(resolved);
  if (!basename || basename === "worktrees" || basename === ".agentdock") {
    throw new Error(`Refusing to remove non-orphan path: ${dirPath}`);
  }

  const MAX_DIR_REMOVE_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_DIR_REMOVE_ATTEMPTS; attempt++) {
    if (!existsSync(dirPath)) return;

    await killProcessesUnderPath(dirPath);

    // Exponential backoff: 500ms, 1s, 2s, 3s, 5s — gives OS time to
    // release file handles after process termination. On Windows the
    // handle-release delay can be 1-3s depending on antivirus scan.
    const backoffMs = [500, 1000, 2000, 3000, 5000][attempt - 1] ?? 5000;
    await new Promise((resolve) => setTimeout(resolve, backoffMs));

    try {
      await rimrafOrFallback(dirPath);
      return; // success
    } catch (err) {
      if (attempt === MAX_DIR_REMOVE_ATTEMPTS) {
        throw err; // final attempt failed, propagate
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Orphan branch scanning
// ---------------------------------------------------------------------------

/**
 * List `agentdock/*` branches that no live session or on-disk worktree
 * references — these survive a session rename or a partial cleanup.
 * `knownBranches` is the union of DB `sessions.branch` and `agentdock/*`
 * branches that currently back a registered git worktree (callers build
 * it). Anything matching `refs/heads/agentdock/` outside that set counts.
 */
export function scanOrphanBranches(
  projectPath: string,
  knownBranches: Set<string>,
): OrphanDir[] {
  let raw: string;
  try {
    raw = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/agentdock/"],
      { cwd: projectPath, encoding: "utf-8", stdio: "pipe" },
    );
  } catch {
    return [];
  }

  const result: OrphanDir[] = [];
  for (const line of raw.split("\n")) {
    const branch = line.trim();
    if (!branch) continue;
    if (knownBranches.has(branch)) continue;
    const sessionId = branch.startsWith("agentdock/")
      ? branch.slice("agentdock/".length)
      : branch;
    result.push({ sessionId, worktreePath: "", reason: "orphan-branch", branch });
  }
  return result;
}

/**
 * Delete a single `agentdock/*` branch. Refuses anything outside the
 * agentdock prefix and validates the branch name first (block flag-style
 * argument injection via `validateBranchName`).
 */
export async function removeOrphanBranch(
  projectPath: string,
  branch: string,
): Promise<void> {
  validateBranchName(branch);
  if (!branch.startsWith("agentdock/")) {
    throw new Error(`Refusing to delete non-agentdock branch: ${branch}`);
  }
  try {
    await execFileAsync("git", ["branch", "-D", branch], {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 10_000,
    });
  } catch (err) {
    throw new Error(
      `Failed to delete branch '${branch}': ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }
}

// ============================================================================
// 三向孤儿分类 (Registry / Git / Filesystem)
// ============================================================================

/**
 * 扩展的孤儿分类 — 区分真实问题来源, 决定正确的修复手段.
 *
 * 来源对应表:
 *
 * | Registry | Git Worktree | Filesystem | kind                  | 修复手段                        |
 * |----------|--------------|------------|-----------------------|---------------------------------|
 * | ❌       | ✅           | ✅         | orphan-session        | git worktree remove + rm -rf    |
 * | ❌       | ✅           | ❌         | git-metadata-orphan   | git worktree prune + branch -D  |
 * | ❌       | ❌           | ✅         | filesystem-orphan     | kill procs + rm -rf             |
 * | ✅       | ❌           | ❌         | registry-stale        | 不自动删 (UI 提示)              |
 * | ✅       | ❌           | ✅         | registry-stale-git    | git worktree prune (→ C3)       |
 *
 * 与单一扫描器 (scanOrphanWorktrees / scanOrphanBranches) 的关键区别:
 *   - 旧 scanner 只看文件系统 + git refs 各自孤立的子集, 经常把"分支孤儿"
 *     (git 元数据残留) 错报成"目录孤儿", 导致 rm -rf 完全跑偏方向.
 *   - 新分类器同时拿到 Registry / Git Worktree / Filesystem 三个状态, 做
 *     真三向比对, 派发到正确的清理手段.
 */
export type OrphanKind =
  | "filesystem-orphan"      // 目录在 .agentdock/worktrees/ 但 git/registry 都不认
  | "git-metadata-orphan"    // git worktree + branch 还有, 但目录已删
  | "orphan-session"         // 目录+git 注册都在, registry 没有 (会话未注册)
  | "branch-orphan"          // 纯分支残留: branch 在但既无 worktree 也无 registry
  | "registry-stale"         // registry 有但 worktree 没了 (UI 处理, 不静默删)
  | "registry-stale-git";    // registry 有, git 注册没了, 目录还在 (git prune → C3)

export interface OrphanItem {
  sessionId: string;
  worktreePath: string;        // git-metadata-orphan / registry-stale 可为空字符串
  branch: string | null;       // agentdock/* 分支名 (如有)
  kind: OrphanKind;
  /** 原始 git worktree 登记 (含 head commit) — 仅 orphan-session / registry-stale-git 有 */
  gitWorktree?: { path: string; head: string };
}

export interface ClassifiedOrphans {
  filesystemOrphans: OrphanItem[];   // → killProcessesUnderPath + rm
  gitMetadataOrphans: OrphanItem[];  // → git worktree prune + git branch -D
  orphanSessions: OrphanItem[];      // → git worktree remove --force + rm
  branchOrphans: OrphanItem[];       // → git branch -D
  registryStale: OrphanItem[];       // → 不自动删, 仅上报
}

export interface CleanupResult {
  deleted: string[];
  failed: Array<{ path?: string; branch?: string; kind: OrphanKind; error: string }>;
}

/**
 * 三向分类: 比较 Registry (passed in) / Git Worktree / Filesystem, 输出
 * 已分类的孤儿列表.
 *
 * @param projectPath      git repo 根目录
 * @param knownSessionIds  registry 中已知的 session ID 集合 (DB sessions.sessionId)
 * @param knownBranches    registry + 当前注册 worktree 的 branch 集合
 *                         (调用方构建, 已在 worktree-shell.ts:102-124 实现)
 */
export function classifyOrphans(
  projectPath: string,
  knownSessionIds: Set<string>,
  knownBranches: Set<string>,
): ClassifiedOrphans {
  // 1. Filesystem 状态: 读 .agentdock/worktrees/ 目录
  const fsDirs = new Map<string, string>(); // sessionId -> absolutePath
  const baseDir = getWorktreeBase(projectPath);
  try {
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const wtPath = path.join(baseDir, entry.name);
      // readdirSync with withFileTypes already filters symlinks
      fsDirs.set(entry.name, wtPath);
    }
  } catch {
    // 目录不存在 → 项目没建过 session, 无 orphan
  }

  // 2. Git Worktree 状态: git worktree list --porcelain
  const gitWorktrees = new Map<string, { path: string; head: string }>(); // sessionId (or branch) -> entry
  try {
    for (const wt of listWorktrees(projectPath)) {
      if (!wt.branch.startsWith("agentdock/")) continue;
      const sessionId = wt.branch.slice("agentdock/".length);
      gitWorktrees.set(sessionId, { path: wt.path, head: wt.head });
    }
  } catch {
    // listWorktrees throws if not a git repo; nothing to compare
  }

  // 3. Git Branch 状态: for-each-ref refs/heads/agentdock/
  const gitBranches = new Set<string>();
  try {
    const raw = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/agentdock/"],
      { cwd: projectPath, encoding: "utf-8", stdio: "pipe" },
    );
    for (const line of raw.split("\n")) {
      const b = line.trim();
      if (b) gitBranches.add(b);
    }
  } catch {
    // no refs/heads/agentdock/ — OK
  }

  const result: ClassifiedOrphans = {
    filesystemOrphans: [],
    gitMetadataOrphans: [],
    orphanSessions: [],
    branchOrphans: [],
    registryStale: [],
  };

  // 4. 三向比对
  const allSessionIds = new Set<string>([
    ...fsDirs.keys(),
    ...gitWorktrees.keys(),
    ...knownSessionIds,
  ]);

  // Also include branch-only orphans whose sessionId isn't in any of the
  // three sources above (no DB record, no worktree dir, no git worktree
  // registration). These are pure branch remnants from deleted sessions.
  for (const branch of gitBranches) {
    if (!branch.startsWith("agentdock/")) continue;
    const sid = branch.slice("agentdock/".length);
    if (!allSessionIds.has(sid)) allSessionIds.add(sid);
  }

  for (const sessionId of allSessionIds) {
    const inFs = fsDirs.has(sessionId);
    const inGit = gitWorktrees.has(sessionId);
    const inReg = knownSessionIds.has(sessionId);
    const branch = `agentdock/${sessionId}`;
    const inBranch = gitBranches.has(branch);

    if (!inReg && !inGit && !inBranch && !inFs) continue; // 什么都没有

    if (inReg && !inGit && !inFs) {
      // ✅❌❌ — registry stale: 不自动删
      result.registryStale.push({
        sessionId,
        worktreePath: "",
        branch: null,
        kind: "registry-stale",
      });
      continue;
    }

    if (inReg && !inGit && inFs) {
      // ✅❌✅ — registry stale + git 登记丢失: prune → C3
      // 实际上目录还在, 由 git prune 后转 C3; 但不在这次清理范围
      result.registryStale.push({
        sessionId,
        worktreePath: fsDirs.get(sessionId)!,
        branch: null,
        kind: "registry-stale-git",
      });
      continue;
    }

    if (!inReg && inGit && inFs) {
      // ❌✅✅ — orphan session: 完整 worktree 但 registry 没记录
      result.orphanSessions.push({
        sessionId,
        worktreePath: gitWorktrees.get(sessionId)!.path,
        branch,
        kind: "orphan-session",
        gitWorktree: gitWorktrees.get(sessionId),
      });
      continue;
    }

    if (!inReg && inGit && !inFs) {
      // ❌✅❌ — git metadata orphan: 目录没了, git/branch 还在
      result.gitMetadataOrphans.push({
        sessionId,
        worktreePath: "",
        branch,
        kind: "git-metadata-orphan",
      });
      continue;
    }

    if (!inReg && !inGit && inFs) {
      // ❌❌✅ — filesystem orphan: 真物理孤儿.
      // Look up the actual branch (if any) — the branch may survive
      // even when git worktree registration is lost.
      const fsBranch = `agentdock/${sessionId}`;
      result.filesystemOrphans.push({
        sessionId,
        worktreePath: fsDirs.get(sessionId)!,
        branch: gitBranches.has(fsBranch) ? fsBranch : null,
        kind: "filesystem-orphan",
      });
      continue;
    }

    // ❌❌❌branch — 纯分支残留: branch 在但既无 worktree 也无 session
    if (!inReg && !inGit && !inFs && inBranch) {
      result.branchOrphans.push({
        sessionId,
        worktreePath: "",
        branch,
        kind: "branch-orphan",
      });
      continue;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Cleanup dispatcher
// ---------------------------------------------------------------------------

/**
 * 派发清理 — 顺序三阶段避免 git lock 竞争:
 *
 *   1. 删除所有孤儿目录 (并行)
 *   2. 全局一次 git worktree prune (清 git 元数据)
 *   3. 删除所有孤儿分支 (并行)
 *
 * registry-stale 不动 (UI 处理).
 */
export async function dispatchOrphanCleanup(
  projectPath: string,
  classified: ClassifiedOrphans,
): Promise<CleanupResult> {
  const deleted: string[] = [];
  const failed: Array<{ path?: string; branch?: string; kind: OrphanKind; error: string }> = [];

  // 统一四种孤儿 kind 到同一列表
  const items = [
    ...classified.filesystemOrphans,
    ...classified.orphanSessions,
    ...classified.gitMetadataOrphans,
    ...classified.branchOrphans,
  ];

  // 1. 删除目录 — 并行
  const dirResults = await Promise.all(
    items.map(async (item) => {
      if (item.worktreePath && existsSync(item.worktreePath)) {
        try {
          await removeOrphanDir(item.worktreePath);
        } catch (err) {
          return { ok: false as const, item, err };
        }
      }
      return { ok: true as const, item };
    }),
  );

  // 2. 全局一次 prune — 顺序执行, 避免 N 个 git 进程同时改 git 元数据锁
  try {
    await execFileAsync("git", ["worktree", "prune"], {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 10_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, "git worktree prune failed during orphan cleanup");
  }

  // 3. 删除分支 — 并行 (prune 已清完元数据, branch -D 不会再被 phantom worktree 阻塞)
  const allResults = await Promise.all(
    dirResults.map(async (r) => {
      if (!r.ok) return r;
      const { item } = r;
      if (item.branch) {
        try {
          await removeOrphanBranch(projectPath, item.branch);
        } catch (err) {
          return { ok: false as const, item, err };
        }
      }
      return { ok: true as const, item };
    }),
  );

  for (const r of allResults) {
    if (r.ok) {
      if (r.item.worktreePath) deleted.push(r.item.worktreePath);
      else if (r.item.branch) deleted.push(r.item.branch);
    } else {
      const errorMsg = r.err instanceof Error ? r.err.message : String(r.err);
      failed.push({
        path: r.item.worktreePath || undefined,
        branch: r.item.branch || undefined,
        kind: r.item.kind,
        error: errorMsg,
      });
    }
  }

  // registryStale 不动, 但 log 一下让 daemon 知道有 stale session
  for (const item of classified.registryStale) {
    log.info(
      { sessionId: item.sessionId, kind: item.kind },
      "registry-stale orphan (not auto-deleted, surfaced to UI)",
    );
  }

  return { deleted, failed };
}
