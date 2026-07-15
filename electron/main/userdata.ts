/**
 * User-data path resolution — picks per-user vs per-machine data location
 * based on the install location of the running binary.
 *
 * Install mode is determined at runtime by inspecting process.execPath:
 *   - perMachine install → exe lives under C:\Program Files\AgentDock\
 *     → userData goes to %PROGRAMDATA%\AgentDock\ (shared by all users)
 *   - perUser install    → exe lives under %LOCALAPPDATA%\Programs\AgentDock\
 *     → userData goes to %APPDATA%\AgentDock\ (current user only)
 *
 * Electron normally returns %APPDATA%\<productName> for userData. This module
 * calls app.setPath('userData', <resolved path>) before any IPC handler
 * is registered so the entire stack (DB, sessions, todos) lands in the
 * right place. See electron/main.ts for the call site.
 *
 * Migration: if the new location is empty but the legacy path exists
 * (either %APPDATA%\AgentDock from prior per-user installs, or
 * %USERPROFILE%\.agentdock\ from the very early "homedir fallback" code),
 * the legacy files are copied into the new path. The legacy path is NOT
 * deleted — the user can keep them as backup or remove manually. Run only
 * once on the first launch after switching install mode.
 */
import { app } from "electron";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
} from "node:fs";

export type InstallMode = "perUser" | "perMachine";

/** Substring in process.execPath that identifies a per-machine install. */
const PER_MACHINE_PATH_HINT = "\\program files\\";

/**
 * Pick the userData directory based on where the running binary lives.
 * Called before app.setPath to override Electron's default.
 */
export function resolveUserDataPath(): string {
  const exe = (process.execPath ?? "").toLowerCase();
  if (exe.includes(PER_MACHINE_PATH_HINT)) {
    const programData =
      process.env.PROGRAMDATA && process.env.PROGRAMDATA.length > 0
        ? process.env.PROGRAMDATA
        : "C:\\ProgramData";
    return join(programData, "AgentDock");
  }
  // PerUser path: defer to Electron's default (AppData\Roaming\<productName>).
  // We don't compute it ourselves because the productName may differ between
  // dev and packaged builds — app.getPath('userData') is the source of truth.
  return app.getPath("userData");
}

/** Which install mode did the running binary pick? Used for diagnostics. */
export function detectInstallMode(): InstallMode {
  const exe = (process.execPath ?? "").toLowerCase();
  return exe.includes(PER_MACHINE_PATH_HINT) ? "perMachine" : "perUser";
}

/** Legacy paths to migrate from on first launch after switching install mode. */
function legacyCandidatePaths(): string[] {
  const candidates: string[] = [];
  if (process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, "AgentDock"));
  }
  if (process.env.USERPROFILE) {
    candidates.push(join(process.env.USERPROFILE, ".agentdock"));
  }
  return candidates;
}

/**
 * If the new userData path is empty but a legacy path has data, copy
 * the legacy files into the new path. No-op if the new path already
 * has data (idempotent — won't clobber a real install).
 *
 * Returns { migratedFrom: string | null } so the caller can log which
 * path the data came from.
 */
export function migrateLegacyUserData(newPath: string): { migratedFrom: string | null } {
  if (!existsSync(newPath)) mkdirSync(newPath, { recursive: true });
  const existing = readdirSync(newPath).filter((n) => n !== "Preferences" && n !== "Local State");
  if (existing.length > 0) {
    // New path already has data — don't migrate over it.
    return { migratedFrom: null };
  }
  for (const candidate of legacyCandidatePaths()) {
    if (!existsSync(candidate)) continue;
    let entries: string[];
    try {
      entries = readdirSync(candidate);
    } catch {
      continue;
    }
    if (entries.length === 0) continue;
    // Copy each top-level entry into the new path.
    for (const entry of entries) {
      const src = join(candidate, entry);
      const dst = join(newPath, entry);
      try {
        const stat = statSync(src);
        if (stat.isDirectory()) {
          copyDirSync(src, dst);
        } else {
          copyFileSync(src, dst);
        }
      } catch {
        // Best-effort: skip entries we can't read.
      }
    }
    return { migratedFrom: candidate };
  }
  return { migratedFrom: null };
}

function copyDirSync(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dst, entry);
    const stat = statSync(s);
    if (stat.isDirectory()) copyDirSync(s, d);
    else copyFileSync(s, d);
  }
}
