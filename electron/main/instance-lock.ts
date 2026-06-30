/**
 * Global Instance Lock — ensures only one AgentDock process runs at a time.
 *
 * Uses the existing OS-level file lock from plugins/os-file-lock.ts.
 * In dev mode (AGENTDOCK_DEV_INSTANCE set or !app.isPackaged), the lock
 * is skipped to allow multiple dev windows.
 */
import { app } from "electron";
import { join } from "node:path";
import { tryAcquireLock, type FileLock } from "../../plugins/os-file-lock.js";

export type { FileLock };

/**
 * Try to acquire the global instance lock.
 *
 * @returns The lock handle if acquired (caller must hold for app lifetime),
 *          or null if another instance holds the lock OR we're in dev mode.
 */
export async function acquireInstanceLock(): Promise<FileLock | null> {
  // Dev mode: skip lock entirely
  if (!app.isPackaged || process.env.AGENTDOCK_DEV_INSTANCE) {
    return null;
  }

  const lockDir = join(app.getPath("userData"), ".agentdock");
  const lockPath = join(lockDir, "instance.lock");

  try {
    return await tryAcquireLock(lockPath, { pid: process.pid });
  } catch {
    // Another instance holds the lock
    return null;
  }
}
