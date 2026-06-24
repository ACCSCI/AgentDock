/**
 * FS + Config IPC handlers.
 *
 * fs:browseDirs / fs:files: enumerate the filesystem to feed the
 * project's "open project" picker and file browser.
 *
 * config:get / config:save: read and write agentdock.config.yaml.
 * Uses the projectId to look up the project root from DB so the .env
 * hint always points at the real project directory, not a worktree.
 */
import { ipcMain } from "electron";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { eq } from "drizzle-orm";
import { IPC_CHANNELS } from "../../shared/api-types.js";
import * as schema from "../../../plugins/db/schema.js";
import { loadConfig, AgentDockConfigSchema } from "../../../plugins/config.js";
import { discoverPortKeysFromEnv } from "../../../plugins/env.js";
import { log } from "../../../plugins/logger.js";
import type { DrizzleDb } from "../../../plugins/db/index.js";

function resolveProjectRoot(
  projectId?: string | null,
  fallback?: string | null,
  getGlobalDb?: () => DrizzleDb | null,
): string {
  if (projectId) {
    const globalDb = getGlobalDb?.();
    if (globalDb) {
      const row = globalDb
        .select({ path: schema.projects.path })
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId))
        .get();
      if (row?.path) return row.path;
    }
  }
  if (fallback) return fallback;
  throw new Error("db:init must be called first");
}

export function registerFsAndConfig(
  getProjectPath: () => string | null,
  getGlobalDb?: () => DrizzleDb | null,
): void {
  // fs:browseDirs — list subdirectories at a given path (or drive roots if empty).
  ipcMain.handle(IPC_CHANNELS["fs:browseDirs"], async (_e, targetPath: string) => {
    if (!targetPath) {
      if (process.platform === "win32") {
        const roots: Array<{ name: string; path: string }> = [];
        for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
          const drive = `${letter}:\\`;
          try {
            statSync(drive);
            roots.push({ name: drive, path: drive });
          } catch {
            // drive not present
          }
        }
        return roots;
      }
      return [{ name: "/", path: "/" }];
    }
    try {
      const entries = readdirSync(targetPath, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: join(targetPath, e.name) }));
    } catch {
      return [];
    }
  });

  // fs:files — list files at a relative path.
  ipcMain.handle(IPC_CHANNELS["fs:files"], async (_e, relPath: string) => {
    const projectPath = getProjectPath();
    if (!projectPath) throw new Error("db:init must be called first");
    const absPath = relPath ? join(projectPath, relPath) : projectPath;
    if (!existsSync(absPath)) return [];
    const entries = readdirSync(absPath, { withFileTypes: true });
    return entries.map((e) => {
      const fullPath = join(absPath, e.name);
      const rel = relPath ? join(relPath, e.name) : e.name;
      const stat = statSync(fullPath);
      return { name: e.name, path: rel, isDir: e.isDirectory(), size: e.isFile() ? stat.size : null };
    });
  });

  // config:get — read the project's agentdock.config.yaml + .env hints.
  // projectId is passed by the renderer so we resolve the REAL project root
  // from DB instead of using getProjectPath() which may point at a worktree.
  ipcMain.handle(
    IPC_CHANNELS["config:get"],
    (_e, params?: { projectId?: string }) => {
      const projectId = params?.projectId;
      const projectPath = resolveProjectRoot(projectId, getProjectPath(), getGlobalDb);
      const config = loadConfig(projectPath);
      const yamlPath = join(projectPath, "agentdock.config.yaml");
      let yaml = "";
      if (existsSync(yamlPath)) {
        yaml = readFileSync(yamlPath, "utf-8");
      }
      const envPath = join(projectPath, ".env");
      const envPorts = existsSync(envPath) ? discoverPortKeysFromEnv(envPath) : [];
      return { config, exists: existsSync(yamlPath), yaml, envPorts };
    },
  );

  // config:save — write agentdock.config.yaml
  ipcMain.handle(
    IPC_CHANNELS["config:save"],
    (_e, params: { config: ReturnType<typeof loadConfig>; projectId?: string }) => {
      if (!params?.config) throw new Error("config required");
      const projectPath = resolveProjectRoot(params.projectId, getProjectPath(), getGlobalDb);
      const parsed = AgentDockConfigSchema.parse(params.config);
      const yamlPath = join(projectPath, "agentdock.config.yaml");
      const yaml = yamlStringify(parsed);
      writeFileSync(yamlPath, yaml, "utf-8");
      return { success: true, yaml };
    },
  );
}