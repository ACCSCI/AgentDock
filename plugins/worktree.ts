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
      // 1. Use handle64 (Sysinternals) if available — finds exact PIDs with
      //    open handles in the target dir. Preferred because it's precise.
      try {
        const { stdout } = await execFileAsync("handle64", ["-accepteula", "-nobanner", "-p", normalized], {
          encoding: "utf-8",
          timeout: 5000,
        });
        const pids = new Set<string>();
        for (const line of stdout.split("\n")) {
          const m = line.match(/pid:\s*(\d+)/i);
          if (m) pids.add(m[1]);
        }
        for (const pid of pids) {
          await execFileAsync("taskkill", ["/F", "/PID", pid], {
            encoding: "utf-8",
            timeout: 5000,
          }).catch(() => {});
        }
      } catch {
        // handle64 not available — fall through to broader approach
      }

      // 2. Broader sweep: find any process whose command-line references
      //    the target dir (from hook child processes).
      try {
        const escapedPath = normalized.replace(/\\/g, "\\\\");
        const { stdout } = await execFileAsync("wmic", [
          "process", "where",
          `CommandLine like '%${escapedPath}%'`,
          "get", "ProcessId", "/format:list",
        ], { encoding: "utf-8", timeout: 5000 });
        for (const line of stdout.split("\n")) {
          const m = line.match(/ProcessId=(\d+)/);
          if (m) {
            await execFileAsync("taskkill", ["/F", "/PID", m[1]], {
              encoding: "utf-8", timeout: 5000,
            }).catch(() => {});
          }
        }
      } catch {
        // wmic not available (Win11 24H2 removed it) — fall through
      }

      // 4. Wait for OS to fully release file handles after process termination.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } else {
      // Unix: lsof to find PIDs with open files under the dir, then SIGKILL.
      const { stdout } = await execFileAsync("sh", ["-c", `lsof -t +D "${normalized}" 2>/dev/null || true`], {
        encoding: "utf-8",
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
    // Best-effort: if we can't enumerate/kill, fall through to rm/rimraf which will retry.
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

let _rimraf: ((p: string) => Promise<void>) | null = null;
const _rmFallback = (p: string) => rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
async function rimrafOrFallback(dirPath: string): Promise<void> {
  if (!_rimraf) {
    try {
      const mod = await import("rimraf") as any;
      const candidate = mod.rimraf ?? mod.default ?? null;
      _rimraf = (typeof candidate === "function" && candidate.length <= 2)
        ? candidate
        : _rmFallback;
    } catch {
      _rimraf = _rmFallback;
    }
  }
  await _rimraf(dirPath);
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

  // ── Force path ──────────────────────────────────────────────────
  // Discard uncommitted changes so `git worktree remove` can run
  // quickly without reverting each file one-by-one (the main
  // Windows performance bottleneck). After checkout, kill any
  // processes that still hold file handles, then attempt the
  // safe git removal. If that still fails (locked files, untracked
  // node_modules, etc.), fall back to rimraf + prune.
  //
  // SAFETY: only run `git checkout .` when the path is a real,
  // registered worktree with its own `.git` pointer file. Otherwise
  // git would walk up the directory tree, find the main repo at
  // `projectPath`, and silently discard uncommitted changes there.
  if (force && isRegistered && existsSync(path.join(worktreePath, ".git"))) {
    try {
      await execAsync("git checkout .", {
        cwd: worktreePath, encoding: "utf-8", stdio: "pipe", timeout: 15_000,
      });
    } catch {
      // Non-fatal: rimraf will handle whatever checkout couldn't revert.
    }
  }

  if (existsSync(worktreePath)) {
    await killProcessesUnderPath(worktreePath);
  }

  if (force && isRegistered) {
    // Attempt safe removal first — much faster now that tracked changes
    // have been discarded via `git checkout .` above.
    try {
      await execAsync(`git worktree remove "${worktreePath}"`, {
        cwd: projectPath, encoding: "utf-8", timeout: 15_000,
      });
    } catch {
      // Fallback: force directory deletion below.
    }
  }

  // Always ensure directory is removed (handles git failure or non-worktree directories).
  // On Windows, EBUSY/EPERM from locked node_modules/.env should be rare now
  // because `git checkout .` above discards tracked changes before killing processes.
  if (existsSync(worktreePath)) {
    await rimrafOrFallback(worktreePath);
  }

  // Delete the branch AFTER the worktree directory is gone — git allows
  // branch deletion once the worktree is removed from disk.
  // First prune stale git worktree registrations so git doesn't think the
  // branch is still checked out by a phantom worktree.
  if (isRegistered) {
    try { await execAsync("git worktree prune", { cwd: projectPath, encoding: "utf-8", timeout: 10_000 }); } catch {}
  }
  try { await execAsync(`git branch -D "${branchToDelete}"`, { cwd: projectPath, encoding: "utf-8", timeout: 10_000 }); } catch {}

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
