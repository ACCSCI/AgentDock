// @ts-nocheck
/**
 * DaemonWAL v2 — three-table persistence + automatic v1→v2 migration
 * (新架构 §5.1.1).
 *
 * Persists DaemonStateV2 to a single JSON file using atomic write-rename.
 * On load, the on-disk file's schemaVersion is read; if it is older than
 * CURRENT_SCHEMA_VERSION, the migration chain in `daemon-migrate.ts` runs
 * entirely in memory and the migrated state is written back atomically.
 *
 * Crash safety:
 *   - Migration is a pure in-memory transform before any write.
 *   - On crash mid-migration, the on-disk file is the original (rename
 *     has not happened); next start re-runs the chain idempotently.
 *   - First-time upgrades create `daemon-state.json.bak.v${fromVersion}`
 *     (one-shot, not overwritten) so users have a manual escape hatch.
 *
 * Downgrade protection: schemaVersion > CURRENT_SCHEMA_VERSION throws
 * immediately — newer-daemon-written files must not be silently truncated.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { CURRENT_SCHEMA_VERSION, DaemonStateV2 } from "./daemon-state-v2.js";
import { migrateToCurrent, validateV2State } from "./daemon-migrate.js";

const STATE_FILE = "daemon-state.json";
const BACKUP_PREFIX = "daemon-state.json.bak.v";

export class DaemonWALV2 {
  private readonly filePath: string;
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.filePath = path.join(baseDir, STATE_FILE);
  }

  getPath(): string {
    return this.filePath;
  }

  /** Persist v2 state. Atomic via temp + rename (Windows: unlink target first). */
  persist(state: DaemonStateV2): void {
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }

    const json = JSON.stringify(state.serialize(), null, 2);
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, json, "utf-8");

    try {
      if (existsSync(this.filePath)) {
        unlinkSync(this.filePath);
      }
      renameSync(tmpPath, this.filePath);
    } catch {
      writeFileSync(this.filePath, json, "utf-8");
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Load and migrate. Returns null if no file, throws on downgrade or
   * irreparable corruption.
   *
   * Side effect on upgrade: creates a backup at
   * `${baseDir}/daemon-state.json.bak.v${fromVersion}` (first time only).
   * After successful migration, the on-disk file is replaced with v2
   * content so subsequent loads take the fast path.
   */
  load(): DaemonStateV2 | null {
    if (!existsSync(this.filePath)) return null;

    const raw = readFileSync(this.filePath, "utf-8");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `WAL file at ${this.filePath} is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const fromVersion =
      typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1;

    if (fromVersion === CURRENT_SCHEMA_VERSION) {
      const problems = validateV2State(parsed);
      if (problems.length > 0) {
        throw new Error(
          `WAL v${CURRENT_SCHEMA_VERSION} validation failed: ${problems.join("; ")}`,
        );
      }
      return DaemonStateV2.deserialize(JSON.stringify(parsed));
    }

    if (fromVersion < CURRENT_SCHEMA_VERSION) {
      this.backupIfMissing(fromVersion);
    }

    const migrated = migrateToCurrent(parsed);

    const problems = validateV2State(migrated);
    if (problems.length > 0) {
      throw new Error(
        `Post-migration v2 validation failed: ${problems.join("; ")}`,
      );
    }

    const state = DaemonStateV2.deserialize(JSON.stringify(migrated));
    try {
      this.persist(state);
    } catch {
      // Read-only fs, etc. — return in-memory state; next persist catches up.
    }
    return state;
  }

  private backupIfMissing(fromVersion: number): void {
    const backupPath = path.join(
      this.baseDir,
      `${BACKUP_PREFIX}${fromVersion}`,
    );
    if (existsSync(backupPath)) return;
    try {
      copyFileSync(this.filePath, backupPath);
    } catch {
      // Backup is best-effort.
    }
  }
}
