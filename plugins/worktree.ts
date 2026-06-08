import { exec, execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

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
 * Best-effort termination of any process whose executable lives under `dirPath`.
 *
 * Session worktrees may contain their own node_modules with long-lived binaries
 * (e.g. @biomejs/.../biome.exe started by background hooks). On Windows these
 * processes hold an open handle to their own .exe, which makes the file
 * impossible to unlink — fs.rm then fails with EPERM no matter how many times
 * it retries. We terminate those processes before deleting the directory.
 */
export async function killProcessesUnderPath(dirPath: string): Promise<void> {
  const normalized = path.resolve(dirPath);
  try {
    if (process.platform === "win32") {
      // Query processes whose ExecutablePath is inside the worktree dir, then kill them.
      const escaped = normalized.replace(/\\/g, "\\\\").replace(/'/g, "''");
      const ps = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${escaped}\\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      await execAsync(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, {
        encoding: "utf-8",
      });
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
  force = false,
): Promise<{ removed: string }> {
  validateSessionId(sessionId);

  const worktreePath = getWorktreePath(projectPath, sessionId);

  if (!existsSync(worktreePath)) {
    throw new Error(`Worktree not found: ${worktreePath}`);
  }

  if (!force) {
    try {
      const status = execSync("git status --porcelain", {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: "pipe",
      });
      if (status.trim().length > 0) {
        throw new Error("Worktree has uncommitted changes. Use force=true to override.");
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("uncommitted changes")) {
        throw err;
      }
    }
  }

  // Only attempt git worktree remove if this is a registered worktree
  if (await isRegisteredWorktree(projectPath, worktreePath)) {
    try {
      await execAsync(`git worktree remove ${force ? "--force " : ""}"${worktreePath}"`, {
        cwd: projectPath,
        encoding: "utf-8",
      });
    } catch {
      // git worktree remove may fail (e.g., "Directory not empty" on Windows
      // when untracked files exist from hooks). Fall through to fs.rm below.
    }

    try {
      const branch = `agentdock/${sessionId}`;
      await execAsync(`git branch -D "${branch}"`, {
        cwd: projectPath,
        encoding: "utf-8",
      });
    } catch {
      // Branch deletion is best-effort
    }
  }

  // Always ensure directory is removed (handles git failure or non-worktree directories)
  if (existsSync(worktreePath)) {
    // Terminate any long-lived process (e.g. biome.exe started by hooks) that
    // holds a handle to a file inside the worktree, otherwise unlink fails with
    // EPERM/EBUSY on Windows and the retries below would never succeed.
    await killProcessesUnderPath(worktreePath);
    // On Windows, files may still be transiently locked right after the holder
    // exits; maxRetries + retryDelay make fs.rm retry those transient failures.
    await rm(worktreePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
  const newBranch = `agentdock/${newName}`;

  // oldBranch derives from validated sessionId; newBranch derives from caller
  // input and MUST be validated before reaching git.
  validateBranchName(oldBranch);
  validateBranchName(newBranch);

  // Check if new branch name already exists
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
  reason: "no-git-file" | "empty-dir";
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
 */
export async function removeOrphanDir(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) return;

  await killProcessesUnderPath(dirPath);
  await rm(dirPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
