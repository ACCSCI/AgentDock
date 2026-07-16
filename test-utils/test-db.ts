/**
 * Test DB — creates an isolated SQLite instance for each test.
 *
 * Phase 0: Scaffold. Phase 4 will use this to give IPC handlers a real DB
 * without polluting the user's project DB.
 *
 * Strategy: each call creates a fresh temp dir and a fresh DB file,
 * returns the path. The caller is responsible for cleanup (delete the
 * temp dir in afterEach/afterAll).
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestDb {
  path: string;
  cleanup: () => void;
}

export function createTestDb(): TestDb {
  const dir = join(tmpdir(), `agentdock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "db.sqlite");

  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}
