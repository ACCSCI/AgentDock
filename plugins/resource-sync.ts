import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ResourceDefinition } from "./config.js";
import { parseEnv, mergeEnv, writeEnv } from "./env.js";

// --- SyncError ---
export class SyncError extends Error {
  constructor(
    message: string,
    public readonly source: string,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

// --- 同步单个资源的结果 ---
export interface ResourceSyncResult {
  source: string;
  target: string;
  action: "copied" | "skipped" | "merged" | "missing-skipped";
  success: boolean;
  error?: string;
}

// --- 整体同步结果 ---
export interface SyncReport {
  results: ResourceSyncResult[];
  success: boolean;
  duration: number;
}

// --- ResourceSyncService ---
export interface ResourceSyncService {
  syncAll(
    projectPath: string,
    worktreePath: string,
    resources: ResourceDefinition[],
  ): Promise<SyncReport>;

  syncOne(
    projectPath: string,
    worktreePath: string,
    resource: ResourceDefinition,
  ): Promise<ResourceSyncResult>;
}

/**
 * Check if a file path looks like an env-style key=value file.
 */
function isEnvFile(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  return basename === ".env" || basename.startsWith(".env.");
}

/**
 * Recursively copy a directory from src to dest.
 * Files in dest that already exist get overwritten.
 */
function copyDirSync(src: string, dest: string): void {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
  }
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Merge a directory: copy all files from src to dest, overwriting same-named files
 * but keeping files in dest that don't exist in src.
 */
function mergeDirSync(src: string, dest: string): void {
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
  }
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      mergeDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Merge an env-style file: source keys override target keys, target-only keys are kept.
 */
function mergeEnvFileSync(srcPath: string, destPath: string): void {
  const srcContent = readFileSync(srcPath, "utf-8");
  const srcEnv = parseEnv(srcContent);

  let destEnv: Record<string, string> = {};
  if (existsSync(destPath)) {
    const destContent = readFileSync(destPath, "utf-8");
    destEnv = parseEnv(destContent);
  }

  const merged = mergeEnv(destEnv, srcEnv); // src overrides dest
  writeFileSync(destPath, writeEnv(merged), "utf-8");
}

export function createResourceSyncService(): ResourceSyncService {
  async function syncOne(
    projectPath: string,
    worktreePath: string,
    resource: ResourceDefinition,
  ): Promise<ResourceSyncResult> {
    if (!existsSync(worktreePath)) {
      throw new SyncError(`Worktree path does not exist: ${worktreePath}`, resource.source);
    }

    const srcPath = path.join(projectPath, resource.source);
    const destPath = path.join(worktreePath, resource.source);
    const srcExists = existsSync(srcPath);
    const destExists = existsSync(destPath);
    const isDir = srcExists ? statSync(srcPath).isDirectory() : resource.source.endsWith("/");

    // Source missing
    if (!srcExists) {
      if (resource.skipIfMissing) {
        return {
          source: resource.source,
          target: resource.source,
          action: "missing-skipped",
          success: true,
        };
      }
      return {
        source: resource.source,
        target: resource.source,
        action: "missing-skipped",
        success: false,
        error: `Source not found: ${srcPath}`,
      };
    }

    // Strategy: skip — if dest exists, skip; if dest doesn't exist, copy
    if (resource.strategy === "skip") {
      if (destExists) {
        return {
          source: resource.source,
          target: resource.source,
          action: "skipped",
          success: true,
        };
      }
      // dest doesn't exist — copy the file or directory
      if (isDir) {
        copyDirSync(srcPath, destPath);
      } else {
        const destDir = path.dirname(destPath);
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true });
        }
        copyFileSync(srcPath, destPath);
      }
      return {
        source: resource.source,
        target: resource.source,
        action: "copied",
        success: true,
      };
    }

    // Strategy: overwrite
    if (resource.strategy === "overwrite") {
      if (isDir) {
        // Remove existing dest dir first for clean overwrite
        const { rmSync } = await import("node:fs");
        if (destExists) {
          rmSync(destPath, { recursive: true, force: true });
        }
        copyDirSync(srcPath, destPath);
      } else {
        // Ensure parent dir exists
        const destDir = path.dirname(destPath);
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true });
        }
        copyFileSync(srcPath, destPath);
      }
      return {
        source: resource.source,
        target: resource.source,
        action: "copied",
        success: true,
      };
    }

    // Strategy: merge
    if (resource.strategy === "merge") {
      if (isDir) {
        mergeDirSync(srcPath, destPath);
      } else if (isEnvFile(srcPath) && destExists) {
        mergeEnvFileSync(srcPath, destPath);
      } else {
        // Non-env file or dest doesn't exist: just copy
        const destDir = path.dirname(destPath);
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true });
        }
        copyFileSync(srcPath, destPath);
      }
      return {
        source: resource.source,
        target: resource.source,
        action: destExists ? "merged" : "copied",
        success: true,
      };
    }

    // Should never reach here
    return {
      source: resource.source,
      target: resource.source,
      action: "skipped",
      success: false,
      error: `Unknown strategy: ${resource.strategy}`,
    };
  }

  async function syncAll(
    projectPath: string,
    worktreePath: string,
    resources: ResourceDefinition[],
  ): Promise<SyncReport> {
    const start = Date.now();
    const results: ResourceSyncResult[] = [];

    for (const resource of resources) {
      const result = await syncOne(projectPath, worktreePath, resource);
      results.push(result);
      // If a resource fails and skipIfMissing is false, throw immediately
      if (!result.success) {
        throw new SyncError(result.error ?? "Sync failed", resource.source);
      }
    }

    return {
      results,
      success: results.every((r) => r.success),
      duration: Date.now() - start,
    };
  }

  return { syncOne, syncAll };
}
