/**
 * Worktree orphan + Shell integration IPC handlers.
 *
 * worktree:orphans / worktree:deleteOrphans: detect worktrees on disk
 * that aren't tracked in DB, and let the user clean them up. Mirrors the
 * master-branch `/api/projects/:id/orphans` + `/api/orphans/delete` API:
 * unions orphan directories with orphan `agentdock/*` git branches and
 * accepts a `{ paths?, branches? }` delete body.
 *
 * shell:openExplorer / shell:openTerminal: hand off to Electron's
 * shell APIs (file manager, terminal).
 */
import { BrowserWindow, ipcMain, shell } from "electron";
import { eq } from "drizzle-orm";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IPC_CHANNELS } from "../../shared/api-types.js";
import {
  getWorktreeBase,
  listWorktrees,
  removeOrphanBranch,
  removeOrphanDir,
  scanOrphanBranches,
  scanOrphanWorktrees,
} from "../../../plugins/worktree.js";
import * as schema from "../../../plugins/db/schema.js";
import { getActiveDb } from "../../../plugins/db/index.js";
import { openInFileManager } from "../../../plugins/open-explorer.js";
import { openInTerminal } from "../../../plugins/open-terminal.js";
import { log } from "../../../plugins/logger.js";

const execFileAsync = promisify(execFile);

/** Cache of open PR windows keyed by pulls URL. Prevents duplicate windows. */
const prWindows = new Map<string, BrowserWindow>();

/**
 * Normalize a path for prefix comparison: resolve to absolute, lower-case
 * on Windows (case-insensitive FS), forward slashes. realpathSync resolves
 * symlinks so an attacker can't bypass the prefix guard with a junction.
 */
function normalizePath(p: string): string {
  let abs = resolve(p);
  try {
    abs = realpathSync(abs);
  } catch {
    // path may not exist; fall back to resolved-only.
  }
  abs = abs.replace(/\\/g, "/");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * Resolve the actual filesystem root of a project. If `projectId` is
 * supplied, look it up in the active DB — this is the path callers SHOULD
 * use when they have a project context (multi-project setups would
 * otherwise hit the launch-cwd path). Falls back to `getProjectPath()`
 * (the active path) for legacy callers and the daemon-auto-init case.
 */
let getProjectPathRef: (() => string | null) | null = null;
function resolveProjectPath(projectId?: string): string {
  if (projectId) {
    const db = getActiveDb();
    if (db) {
      const row = db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId))
        .get();
      if (row?.path) return row.path;
      throw new Error(`Project not found: ${projectId}`);
    }
  }
  const fallback = getProjectPathRef?.();
  if (!fallback) {
    throw new Error(
      "no active project; call db:init or pass projectId in the request body",
    );
  }
  return fallback;
}

export function registerWorktreeAndShell(getProjectPath: () => string | null): void {
  // Stash the lookup for resolveProjectPath above. Avoids threading the
  // ref through every helper signature.
  getProjectPathRef = getProjectPath;
  // worktree:orphans — list orphan worktree directories AND orphan
  // agentdock/* branches under the project. Accepts an optional
  // `projectId`; resolves the real project root from DB so multi-
  // project setups work even when `activeProjectPath` (= launch cwd)
  // is something unrelated. Falls back to `activeProjectPath` for
  // backward compat with the no-arg callers.
  ipcMain.handle(IPC_CHANNELS["worktree:orphans"], (_e, projectId?: string) => {
    const projectPath = resolveProjectPath(projectId);
    const dirOrphans = scanOrphanWorktrees(projectPath);

    // Build the "known branches" set from (a) the DB sessions table and
    // (b) every `agentdock/*` branch that currently backs a registered
    // git worktree. Anything outside this union is fair game to flag.
    const known = new Set<string>();
    try {
      for (const wt of listWorktrees(projectPath)) {
        if (wt.branch.startsWith("agentdock/")) known.add(wt.branch);
      }
    } catch {
      // listWorktrees throws if the project isn't a git repo; OK to ignore.
    }
    const db = getActiveDb();
    if (db) {
      try {
        const rows = db
          .select({ branch: schema.sessions.branch })
          .from(schema.sessions)
          .all();
        for (const r of rows) {
          if (r.branch) known.add(r.branch);
        }
      } catch (err) {
        // Stale schema would surface here; log but don't fail the scan.
        log.warn({ err }, "worktree:orphans: failed to read sessions.branch");
      }
    }

    const branchOrphans = scanOrphanBranches(projectPath, known);
    return [...dirOrphans, ...branchOrphans].map((o) => ({
      sessionId: o.sessionId,
      worktreePath: o.worktreePath,
      reason: o.reason,
      branch: o.branch ?? null,
    }));
  });

  // worktree:deleteOrphans — remove the supplied orphan dirs and/or
  // agentdock/* branches. Body shapes accepted:
  //   - { paths?, branches?, projectId? }  (preferred, mirrors master)
  //   - string[]                            (legacy paths-only callers)
  ipcMain.handle(
    IPC_CHANNELS["worktree:deleteOrphans"],
    async (
      _e,
      body:
        | { paths?: string[]; branches?: string[]; projectId?: string }
        | string[],
    ) => {
      // Backwards-compat: the old single-array shape is still accepted
      // (Phase 5 renderer code that hasn't migrated yet).
      const paths = Array.isArray(body)
        ? body
        : Array.isArray(body?.paths)
          ? body.paths
          : [];
      const branches = !Array.isArray(body) && Array.isArray(body?.branches)
        ? body.branches
        : [];
      const projectId =
        !Array.isArray(body) && typeof body?.projectId === "string"
          ? body.projectId
          : undefined;

      if (paths.length === 0 && branches.length === 0) {
        throw new Error("paths[] or branches[] required");
      }

      const projectPath = resolveProjectPath(projectId);

      // Restrict deletions to the project's own .agentdock/worktrees/
      // subtree — never let a caller hand us, say, "C:/Windows".
      const allowedRoot = normalizePath(getWorktreeBase(projectPath));

      const deleted: string[] = [];
      const failed: Array<{ path?: string; branch?: string; error: string }> = [];

      for (const p of paths) {
        if (typeof p !== "string" || !p) {
          failed.push({ path: String(p), error: "Invalid path" });
          continue;
        }
        const norm = normalizePath(p);
        if (!norm.startsWith(allowedRoot + "/") && norm !== allowedRoot) {
          failed.push({ path: p, error: "Path outside project worktree root" });
          continue;
        }
        try {
          await removeOrphanDir(p);
          deleted.push(p);
        } catch (err) {
          log.error({ err, path: p }, "failed to remove orphan dir");
          failed.push({
            path: p,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      for (const b of branches) {
        if (typeof b !== "string" || !b) {
          failed.push({ branch: String(b), error: "Invalid branch" });
          continue;
        }
        try {
          await removeOrphanBranch(projectPath, b);
          deleted.push(b);
        } catch (err) {
          log.error({ err, branch: b }, "failed to remove orphan branch");
          failed.push({
            branch: b,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { deleted, failed };
    },
  );

  // shell:openExplorer — open file manager at a path
  ipcMain.handle(IPC_CHANNELS["shell:openExplorer"], async (_e, targetPath: string) => {
    if (!targetPath) {
      throw new Error("path required");
    }
    // shell.openPath returns "" on success or an error string.
    const err = await shell.openPath(targetPath);
    if (err) {
      // Fallback: try the cross-platform helper.
      try {
        await openInFileManager(targetPath);
        return { success: true };
      } catch (err2) {
        log.error({ err, err2, targetPath }, "open explorer failed");
        throw new Error(err);
      }
    }
    return { success: true };
  });

  // shell:openTerminal — spawn OS-native terminal at a path
  ipcMain.handle(IPC_CHANNELS["shell:openTerminal"], async (_e, targetPath: string) => {
    if (!targetPath) {
      throw new Error("path required");
    }
    try {
      await openInTerminal(targetPath);
      return { success: true };
    } catch (err) {
      log.error({ err, targetPath }, "open terminal failed");
      throw err;
    }
  });

  // shell:openPullRequests — open the GitHub pulls page in a persistent
  // BrowserWindow. The "persist:github" partition saves cookies to disk,
  // so the user only needs to log in once. Reuses an existing window
  // for the same URL (focusing it instead of creating a duplicate).
  ipcMain.handle(IPC_CHANNELS["shell:openPullRequests"], async (_e, projectId?: string) => {
    const projectPath = resolveProjectPath(projectId);

    // Get the origin remote URL
    let remoteUrl: string;
    try {
      remoteUrl = (await execFileAsync("git", ["-C", projectPath, "remote", "get-url", "origin"])).stdout.trim();
    } catch {
      throw new Error("未配置 GitHub remote（origin）");
    }

    if (!remoteUrl) {
      throw new Error("未配置 GitHub remote（origin）");
    }

    // Parse GitHub owner/repo from both SSH and HTTPS URLs, allowing dots
    // in repo names (e.g. "foo.github.io"). Strip trailing ".git" separately.
    //   SSH:    git@github.com:owner/repo.git
    //   HTTPS:  https://github.com/owner/repo.git
    const cleanUrl = remoteUrl.replace(/\/$/, "");
    const match = cleanUrl.match(/github\.com[/:]([^/]+)\/([^/]+)/);
    if (!match) {
      throw new Error("Origin remote 不是 GitHub 仓库");
    }

    const [, owner, rawRepo] = match;
    const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
    const pullsUrl = `https://github.com/${owner}/${repo}/pulls`;

    // Reuse existing window if already open for this URL
    const existing = prWindows.get(pullsUrl);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return { url: pullsUrl };
    }

    // Persistent partition: cookies are saved to disk under
    // <userData>/partitions/persist:github/, so login survives restarts.
    const pullsWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      title: `Pull Requests — ${owner}/${repo}`,
      webPreferences: {
        partition: "persist:github",
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    prWindows.set(pullsUrl, pullsWindow);
    pullsWindow.on("closed", () => {
      prWindows.delete(pullsUrl);
    });

    pullsWindow.loadURL(pullsUrl);

    return { url: pullsUrl };
  });
}