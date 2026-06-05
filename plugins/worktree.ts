import { exec, execSync } from "node:child_process";
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

  if (existsSync(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }

  const baseDir = getWorktreeBase(projectPath);
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }

  execSync(`git worktree add "${worktreePath}" -b "${branch}" "${base}"`, {
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
    await rm(worktreePath, { recursive: true, force: true });
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
): { newBranch: string; worktreePath: string } {
  validateSessionId(sessionId);

  if (newName.includes("..") || newName.includes("/") || newName.includes("\\")) {
    throw new Error("Invalid new name");
  }

  const worktreePath = getWorktreePath(projectPath, sessionId);

  if (!existsSync(worktreePath)) {
    throw new Error(`Worktree not found: ${worktreePath}`);
  }

  const oldBranch = `agentdock/${sessionId}`;
  const newBranch = `agentdock/${newName}`;

  // Check if new branch name already exists
  try {
    execSync(`git rev-parse --verify "${newBranch}"`, {
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
  execSync(`git branch -m "${oldBranch}" "${newBranch}"`, {
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
