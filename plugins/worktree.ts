import { exec, execFile, execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const WORKTREE_DIR = ".agentdock/worktrees";

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
}

export function getWorktreeBase(projectPath: string): string {
  return path.join(projectPath, WORKTREE_DIR);
}

export function getWorktreePath(projectPath: string, sessionId: string): string {
  return path.join(getWorktreeBase(projectPath), sessionId);
}

export function isGitRepo(dirPath: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: dirPath,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize a new git repository in `dirPath` using `-b main` as the
 * default branch (modern convention; avoids `master`). `-q` suppresses
 * the "Initialized empty Git repository..." banner. Throws on failure
 * (e.g. git binary missing, EACCES, read-only filesystem) — callers
 * should catch and surface via toast/error.
 *
 * Async (via execFileAsync) so the Electron main process event loop is
 * not blocked while the git binary runs — sync exec on the main process
 * can freeze the UI on slow disks or under antivirus scans.
 */
export async function initGitRepo(dirPath: string): Promise<void> {
  await execFileAsync("git", ["init", "-q", "-b", "main"], {
    cwd: dirPath,
    encoding: "utf-8",
  });
}

export function getCurrentBranch(projectPath: string): string {
  return execSync("git branch --show-current", {
    cwd: projectPath,
    encoding: "utf-8",
  }).trim();
}

export function validateSessionId(sessionId: string): void {
  if (sessionId.includes("..") || sessionId.includes("/") || sessionId.includes("\\")) {
    throw new Error("Invalid session ID");
  }
}

/**
 * Validate a git branch / ref name before passing it to git.
 *
 * Even though all git commands are now invoked via execFileSync (no shell),
 * a value beginning with "-" could still be interpreted by git as an option,
 * and git itself rejects many characters in refnames. We reject anything that
 * is not a conservative, safe subset and anything git's own rules forbid.
 *
 * Allowed: ASCII letters, digits, and  . _ - /  (plus the leading-dash guard).
 */
export function validateBranchName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Invalid branch name: empty");
  }
  // Reject leading dash (would be parsed as a git option).
  if (name.startsWith("-")) {
    throw new Error("Invalid branch name: must not start with '-'");
  }
  // Reject git-illegal characters and shell metacharacters.
  // Use Unicode property whitelist: letters (\p{L}), digits (\p{N}), and safe punctuation (._/-).
  if (!/^[\p{L}\p{N}._/-]+$/u.test(name)) {
    throw new Error(`Invalid branch name: ${name}`);
  }
  // Git-specific rules: no "..", no leading/trailing "/", no "//",
  // no trailing ".", no "@{", no ".lock" suffix.
  if (
    name.includes("..") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.includes("//") ||
    name.endsWith(".") ||
    name.endsWith(".lock")
  ) {
    throw new Error(`Invalid branch name: ${name}`);
  }
}

/**
 * Best-effort termination of any process whose executable lives under `dirPath`,
 * as well as processes whose command-line references the path (i.e. shell/child
 * processes that have the worktree as their CWD).
 *
 * Session worktrees may contain their own node_modules with long-lived binaries
 * (e.g. @biomejs/.../biome.exe started by background hooks). On Windows these
 * processes hold an open handle to their own .exe, which makes the file
 * impossible to unlink — fs.rm then fails with EPERM no matter how many times
 * it retries. We terminate those processes before deleting the directory.
 *
 * Additionally, shell processes (cmd.exe, powershell.exe, bash.exe) spawned by
 * the PTY host or by hook commands have their CWD set to the worktree directory,
 * so the OS holds a handle on the directory itself (causing EBUSY on rmdir).
 * Those processes are not caught by the ExecutablePath check because their
 * binary lives under C:\Windows or C:\Program Files. We also match by
 * CommandLine AND CurrentDirectory to cover cases where exec() sets cwd but
 * the command string itself doesn't contain the path.
 */
export async function killProcessesUnderPath(dirPath: string): Promise<void> {
  const normalized = path.resolve(dirPath);
  try {
    if (process.platform === "win32") {
      // Build the PowerShell script as a string, then encode to base64
      // to safely pass through cmd.exe without any interpolation risk.
      // The path is read from $env:AGENTDOCK_TARGET_DIR (set via env on
      // execAsync), since -EncodedCommand does not support trailing
      // arguments like `-dir` (review feedback on PR #35).
      // A malicious path cannot break out because the script only reads
      // the value via $env, never as part of the script text.
      const psScript =
        `$dir = $env:AGENTDOCK_TARGET_DIR; ` +
        `$e = $dir -replace '\\\\\\\\', '\\\\\\\\' -replace "'", "''"; ` +
        `$c = if ($e.EndsWith('\\\\')) { $e } else { $e + '\\\\' }; ` +
        `Get-CimInstance Win32_Process | Where-Object { ` +
        `$_.ExecutablePath -like "$e\\\\*" -or ` +
        `$_.CommandLine -like "*$e*" -or ` +
        `$_.CurrentDirectory -like "$c*" } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;

      // Encode to UTF-16LE base64 for PowerShell's -EncodedCommand
      const encoded = Buffer.from(psScript, "utf16le").toString("base64");
      await execAsync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`, {
        encoding: "utf-8",
        env: { ...process.env, AGENTDOCK_TARGET_DIR: normalized },
        timeout: 8000,
      }).catch(() => {});

      // Give processes a moment to release their directory handles.
      await new Promise((resolve) => setTimeout(resolve, 300));
    } else {
      // lsof lists processes with open files under the dir; kill their PIDs.
      const { stdout } = await execAsync(`lsof -t +D "${normalized}" 2>/dev/null || true`, {
        encoding: "utf-8",
        shell: "/bin/sh",
      });
      const pids = [...new Set(stdout.split("\n").map((l) => l.trim()).filter(Boolean))];
      for (const pid of pids) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // process may already be gone
        }
      }
    }
  } catch {
    // Best-effort: if we can't enumerate/kill, fall through to fs.rm which will retry.
  }
}

export async function isRegisteredWorktree(projectPath: string, worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 10_000,
    });
    const normalizedPath = worktreePath.replace(/\\/g, "/");
    for (const block of stdout.split("\n\n")) {
      const match = block.match(/^worktree (.+)$/m);
      if (match && match[1].replace(/\\/g, "/") === normalizedPath) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function createWorktree(
  projectPath: string,
  sessionId: string,
  baseBranch?: string,
): { worktreePath: string; branch: string } {
  validateSessionId(sessionId);

  const branch = `agentdock/${sessionId}`;
  const worktreePath = getWorktreePath(projectPath, sessionId);
  const base = baseBranch || getCurrentBranch(projectPath);

  // branch is derived from a validated sessionId, but validate explicitly;
  // base comes from the caller (HTTP body) and MUST be validated.
  validateBranchName(branch);
  validateBranchName(base);

  if (existsSync(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }

  const baseDir = getWorktreeBase(projectPath);
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }

  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch, base], {
    cwd: projectPath,
    encoding: "utf-8",
    stdio: "pipe",
  });

  return { worktreePath, branch };
}

export async function removeWorktree(
  projectPath: string,
  sessionId: string,
  options: { currentBranch?: string; force?: boolean } | boolean = {},
): Promise<{ removed: string }> {
  // Accept the legacy positional-boolean form so older callers
  // (`removeWorktree(p, id, true)`) keep working. Internally normalize.
  const opts =
    typeof options === "boolean" ? { force: options } : options;
  const force = opts.force ?? false;
  const branchToDelete =
    opts.currentBranch ?? `agentdock/${sessionId}`;

  validateSessionId(sessionId);
  validateBranchName(branchToDelete);

  const worktreePath = getWorktreePath(projectPath, sessionId);

  if (!existsSync(worktreePath)) {
    throw new Error(`Worktree not found: ${worktreePath}`);
  }

  // Non-force: block removal when worktree has uncommitted changes.
  if (!force) {
    try {
      const status = execSync("git status --porcelain", {
        cwd: worktreePath, encoding: "utf-8", stdio: "pipe",
      });
      if (status.trim().length > 0) {
        throw new Error("Worktree has uncommitted changes. Use force=true to override.");
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("uncommitted changes")) throw err;
    }
  }

  // Check worktree registration once — reused below and for prune.
  const isRegistered = await isRegisteredWorktree(projectPath, worktreePath).catch(() => false);

  // Non-force path: run git worktree remove + branch delete (safe but slow).
  // Force path: skip these entirely — on Windows they take 20+ seconds due
  // to antivirus scanning and file-handle contention.
  if (!force && isRegistered) {
    try { await execAsync(`git worktree remove "${worktreePath}"`, { cwd: projectPath, encoding: "utf-8", timeout: 15_000 }); } catch {}
    try { await execAsync(`git branch -D "${branchToDelete}"`, { cwd: projectPath, encoding: "utf-8", timeout: 10_000 }); } catch {}
  }

  // Always ensure directory is removed (handles git failure or non-worktree directories)
  if (existsSync(worktreePath)) {
    const MAX_DIR_REMOVE_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_DIR_REMOVE_ATTEMPTS; attempt++) {
      if (!existsSync(worktreePath)) break;

      await killProcessesUnderPath(worktreePath);

      try {
        await rm(worktreePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        break; // success
      } catch (err) {
        if (attempt < MAX_DIR_REMOVE_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        } else {
          throw err;
        }
      }
    }
  }

  // Clean up stale git worktree registration left behind by force removal
  if (isRegistered) {
    try { await execAsync("git worktree prune", { cwd: projectPath, encoding: "utf-8", timeout: 10_000 }); } catch {}
  }

  return { removed: worktreePath };
}

export function listWorktrees(projectPath: string): WorktreeInfo[] {
  try {
    const output = execSync("git worktree list --porcelain", {
      cwd: projectPath,
      encoding: "utf-8",
    });

    const worktrees: WorktreeInfo[] = [];
    const blocks = output.split("\n\n").filter((b: string) => b.trim());

    for (const block of blocks) {
      const lines = Object.fromEntries(
        block.split("\n").map((line: string) => {
          const idx = line.indexOf(" ");
          return [line.slice(0, idx), line.slice(idx + 1)];
        }),
      );

      const branch = (lines.branch || "").replace("refs/heads/", "");
      if (branch.startsWith("agentdock/")) {
        worktrees.push({
          path: lines.worktree || "",
          branch,
          head: lines.head || "",
        });
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}

export function renameWorktree(
  projectPath: string,
  sessionId: string,
  newName: string,
  currentBranch?: string,
): { newBranch: string; worktreePath: string } {
  validateSessionId(sessionId);

  if (newName.includes("..") || newName.includes("/") || newName.includes("\\")) {
    throw new Error("Invalid new name");
  }

  const worktreePath = getWorktreePath(projectPath, sessionId);

  if (!existsSync(worktreePath)) {
    throw new Error(`Worktree not found: ${worktreePath}`);
  }

  const oldBranch = currentBranch ?? `agentdock/${sessionId}`;
  // §4.1 — branch 派生自 sessionId (不可变), 不派生自 newName (自由文本).
  // 防 displayName → branch 注入 (§11.3 #7).
  const newBranch = `agentdock/${sessionId}`;

  // §4.1 — rename 只改 displayName, 不改 branch.
  // oldBranch 与 newBranch 必然相同 (都派生自 sessionId), 所以 branch
  // rename 是 no-op. 跳过 git 操作, 只更新 displayName.
  validateBranchName(oldBranch);
  if (oldBranch !== newBranch) {
    validateBranchName(newBranch);
    // Check if new branch name already exists (only when actually renaming)
    try {
      execFileSync("git", ["rev-parse", "--verify", newBranch], {
        cwd: projectPath,
        encoding: "utf-8",
        stdio: "pipe",
      });
      throw new Error(`Branch '${newBranch}' already exists`);
    } catch (err) {
      if (err instanceof Error && err.message.includes("already exists")) {
        throw err;
      }
      // Branch doesn't exist - good
    }
    // Rename the branch
    execFileSync("git", ["branch", "-m", oldBranch, newBranch], {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: "pipe",
    });
  }

  return { newBranch, worktreePath };
}

export interface DiskWorktree {
  sessionId: string;
  worktreePath: string;
  branch: string;
}

export function scanDiskWorktrees(projectPath: string): DiskWorktree[] {
  const baseDir = getWorktreeBase(projectPath);
  if (!existsSync(baseDir)) return [];

  const entries = readdirSync(baseDir, { withFileTypes: true });
  const result: DiskWorktree[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionId = entry.name;
    const wtPath = path.join(baseDir, sessionId);
    const branch = `agentdock/${sessionId}`;

    // Verify it's a valid worktree (has .git file)
    const gitFile = path.join(wtPath, ".git");
    if (existsSync(gitFile)) {
      result.push({ sessionId, worktreePath: wtPath, branch });
    }
  }

  return result;
}

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

  // Defense-in-depth: refuse to delete the worktree base or anything above it.
  // Callers (IPC handlers) should already validate, but this guard protects
  // against future callers that forget.
  const resolved = path.resolve(dirPath);
  const basename = path.basename(resolved);
  if (!basename || basename === "worktrees" || basename === ".agentdock") {
    throw new Error(`Refusing to remove non-orphan path: ${dirPath}`);
  }

  const MAX_DIR_REMOVE_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_DIR_REMOVE_ATTEMPTS; attempt++) {
    if (!existsSync(dirPath)) return;

    await killProcessesUnderPath(dirPath);

    try {
      await rm(dirPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return; // success
    } catch (err) {
      if (attempt < MAX_DIR_REMOVE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      } else {
        throw err; // final attempt failed, propagate
      }
    }
  }
}

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

import { log } from "./logger.js";

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
      // ❌❌✅ — filesystem orphan: 真物理孤儿
      result.filesystemOrphans.push({
        sessionId,
        worktreePath: fsDirs.get(sessionId)!,
        branch: null,
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

/**
 * 派发清理 — 按 kind 分桶并行执行, 每个失败独立报告.
 *
 * 并行策略:
 *   - filesystemOrphans / orphanSessions / branchOrphans: 互相独立, 全并行
 *   - gitMetadataOrphans: 先并行 rm + git branch -D, 最后统一一次 git worktree prune
 *     (避免 N 次串行 prune, git 内部有锁)
 *   - registryStale: 不动 (UI 处理)
 */
export async function dispatchOrphanCleanup(
  projectPath: string,
  classified: ClassifiedOrphans,
): Promise<CleanupResult> {
  const deleted: string[] = [];
  const failed: Array<{ path?: string; branch?: string; kind: OrphanKind; error: string }> = [];

  // ---- Filesystem orphans: killProcessesUnderPath + rm ----
  const fsTasks = classified.filesystemOrphans.map(async (item) => {
    try {
      await removeOrphanDir(item.worktreePath);
      return { ok: true as const, item };
    } catch (err) {
      return { ok: false as const, item, err };
    }
  });

  // ---- Orphan sessions: git worktree remove --force + fs.rm fallback ----
  const sessionTasks = classified.orphanSessions.map(async (item) => {
    try {
      // 先尝试 git 清理
      try {
        await execFileAsync("git", ["worktree", "remove", "--force", item.worktreePath], {
          cwd: projectPath,
          encoding: "utf-8",
          timeout: 15_000,
        });
      } catch {
        // git remove 失败 (Windows 上常见) — 兜底 fs.rm
      }
      // 不管 git 是否成功, 都强制 fs 删
      await removeOrphanDir(item.worktreePath);
      return { ok: true as const, item };
    } catch (err) {
      return { ok: false as const, item, err };
    }
  });

  // ---- Git metadata orphans: branch -D + 统一 prune ----
  const gitMetaTasks = classified.gitMetadataOrphans.map(async (item) => {
    if (!item.branch) return { ok: true as const, item };
    try {
      await removeOrphanBranch(projectPath, item.branch);
      return { ok: true as const, item };
    } catch (err) {
      return { ok: false as const, item, err };
    }
  });

  // ---- Branch orphans: git branch -D ----
  const branchTasks = classified.branchOrphans.map(async (item) => {
    if (!item.branch) return { ok: true as const, item };
    try {
      await removeOrphanBranch(projectPath, item.branch);
      return { ok: true as const, item };
    } catch (err) {
      return { ok: false as const, item, err };
    }
  });

  // 全部并行 (git 操作互不依赖)
  const allResults = await Promise.all([
    ...fsTasks,
    ...sessionTasks,
    ...gitMetaTasks,
    ...branchTasks,
  ]);

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

  // ---- 最后统一一次 git worktree prune (清残余 git 登记) ----
  // 单次调用, 不在每个 git-metadata-orphan 里反复调 (git 内部锁)
  if (classified.gitMetadataOrphans.length > 0 || classified.orphanSessions.length > 0) {
    try {
      await execFileAsync("git", ["worktree", "prune"], {
        cwd: projectPath,
        encoding: "utf-8",
        timeout: 10_000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // prune 失败不致命 — 但要显式上报
      log.warn({ err: msg }, "git worktree prune failed after orphan cleanup");
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
