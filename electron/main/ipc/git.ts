/**
 * Git IPC handlers — check repo status and initialize new repositories.
 *
 * Channels:
 *   git:isRepo — returns true if `dirPath` is inside a git work tree.
 *   git:init   — runs `git init -q -b main` in `dirPath`.
 *
 * Used by the renderer-driven "open project" flow: after the user selects
 * a directory via DirBrowserModal, the renderer checks if it is a git
 * repo. If not, a confirmation modal offers to run `git init` before
 * creating the project — this prevents silent failures downstream when
 * session creation tries `git worktree add`.
 */
import { ipcMain } from "electron";
import { log } from "../../../plugins/logger.js";
import { initGitRepo, isGitRepo } from "../../../plugins/worktree.js";
import { IPC_CHANNELS } from "../../shared/api-types.js";

export function registerGit(): void {
  ipcMain.handle(IPC_CHANNELS["git:isRepo"], (_e, dirPath: string) => {
    if (!dirPath || typeof dirPath !== "string") {
      throw new Error("dirPath is required");
    }
    return isGitRepo(dirPath);
  });

  // Returns { success: true } or { success: false, error } — never throws,
  // so the renderer can surface the underlying message via toast.
  ipcMain.handle(IPC_CHANNELS["git:init"], async (_e, dirPath: string) => {
    if (!dirPath || typeof dirPath !== "string") {
      throw new Error("dirPath is required");
    }
    try {
      await initGitRepo(dirPath);
      return { success: true as const };
    } catch (err) {
      log.error({ err, dirPath }, "git init failed");
      return {
        success: false as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
