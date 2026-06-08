import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import path from "node:path";
import { DaemonState } from "./daemon-state.js";

const STATE_FILE = "daemon-state.json";

/**
 * Write-Ahead Log for DaemonState.
 *
 * Persists the daemon's in-memory state to a single JSON file.
 * Uses atomic write (write to temp file, then rename) to avoid
 * partial writes on crash.
 */
export class DaemonWAL {
  private filePath: string;

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, STATE_FILE);
  }

  /**
   * Get the path to the WAL file.
   */
  getPath(): string {
    return this.filePath;
  }

  /**
   * Persist state to disk. Creates directory if needed.
   */
  persist(state: DaemonState): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const json = state.serialize();

    // Atomic write: write to temp file, then rename
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, json, "utf-8");

    try {
      // On Windows, rename fails if target exists, so delete first
      if (existsSync(this.filePath)) {
        unlinkSync(this.filePath);
      }
      renameSync(tmpPath, this.filePath);
    } catch {
      // Fallback: direct write if rename fails
      writeFileSync(this.filePath, json, "utf-8");
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  /**
   * Load state from disk. Returns null if file doesn't exist or is corrupt.
   */
  load(): DaemonState | null {
    if (!existsSync(this.filePath)) return null;

    try {
      const json = readFileSync(this.filePath, "utf-8");
      return DaemonState.deserialize(json);
    } catch {
      return null;
    }
  }
}
