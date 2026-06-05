import { existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Validate a project path supplied by an API client before it is used to
 * create/open a SQLite database or scan the filesystem.
 *
 * Requirements:
 *  - non-empty string
 *  - absolute path (relative paths are resolved against the dev-server CWD,
 *    which would let a client write a DB into arbitrary locations)
 *  - the path must already exist and be a directory
 *
 * Returns the resolved (normalized) absolute path.
 */
export function validateProjectPath(projectPath: string): string {
  if (!projectPath || typeof projectPath !== "string") {
    throw new Error("projectPath is required");
  }
  if (!path.isAbsolute(projectPath)) {
    throw new Error("projectPath must be an absolute path");
  }
  const resolved = path.resolve(projectPath);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`projectPath is not an existing directory: ${resolved}`);
  }
  return resolved;
}
