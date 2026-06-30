// @ts-nocheck
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import path from "node:path";
import { DaemonState } from "./daemon-state.js";

const STATE_FILE = "daemon-state.json";

/**
 * Write-Ahead Log for DaemonState (v1 — the legacy 4-map shape).
 *
 * Persists the daemon's in-memory state to a single JSON file.
 * Uses atomic write (write to temp file, then rename) to avoid
 * partial writes on crash.
 *
 * NOTE: this is the LEGACY WAL used by the v1 daemon API. The new
 * three-table v2 model lives in `daemon-wal-v2.ts`. The two are
 * decoupled — v1 keeps the existing routes working; v2 is wired up
 * when P3 lands the new /claim /release /session/* routes.
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

    // Stamp schemaVersion=1 so v2 WAL can distinguish this file from
    // a raw v1 file that never went through the new code path.
    const parsed = JSON.parse(state.serialize());
    parsed.schemaVersion = 1;
    const json = JSON.stringify(parsed, null, 2);

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

    let json: string;
    try {
      json = readFileSync(this.filePath, "utf-8");
    } catch {
      return null;
    }

    // Refuse to load v2 state — only the v2 WAL may handle v2 files.
    try {
      const parsed = JSON.parse(json);
      if (parsed.schemaVersion === 2) {
        throw new Error(
          "refuse-overwrite-v2-state: v1 WAL detected schemaVersion=2, cannot load",
        );
      }
    } catch (err) {
      // Re-throw the v2 refusal; let JSON parse errors fall through
      // to DaemonState.deserialize which handles corrupt files gracefully.
      if (
        err instanceof Error &&
        err.message.startsWith("refuse-overwrite-v2-state")
      ) {
        throw err;
      }
    }

    try {
      return DaemonState.deserialize(json);
    } catch {
      return null;
    }
  }
}
