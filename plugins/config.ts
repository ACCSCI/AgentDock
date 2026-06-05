import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// --- SyncStrategy ---
export const SyncStrategy = z.enum(["overwrite", "skip", "merge"]);
export type SyncStrategy = z.infer<typeof SyncStrategy>;

// --- ResourceDefinition ---
export const ResourceDefinitionSchema = z.object({
  source: z.string().min(1, "source must not be empty"),
  strategy: SyncStrategy.default("overwrite"),
  skipIfMissing: z.boolean().default(true),
});
export type ResourceDefinition = z.infer<typeof ResourceDefinitionSchema>;

// --- HookDefinition ---
export const HookLifecycleEvent = z.enum([
  "beforeCreateSession",
  "afterCreateSession",
  "beforeDeleteSession",
  "afterDeleteSession",
]);
export type HookLifecycleEvent = z.infer<typeof HookLifecycleEvent>;

export const HookDefinitionSchema = z.object({
  run: z.string().min(1, "run must not be empty"),
  required: z.boolean().default(false),
  timeout: z.number().default(30000),
  cwd: z.enum(["worktree", "project"]).default("worktree"),
  async: z.boolean().default(false),
});
export type HookDefinition = z.infer<typeof HookDefinitionSchema>;

// --- AgentDockConfig ---
export const AgentDockConfigSchema = z.object({
  version: z.string().default("1"),
  resources: z
    .object({
      sync: z.array(ResourceDefinitionSchema).default([]),
    })
    .default({ sync: [] }),
  hooks: z
    .record(z.string(), z.array(HookDefinitionSchema))
    .default({}),
});
export type AgentDockConfig = z.infer<typeof AgentDockConfigSchema>;

const CONFIG_FILENAME = "agentdock.config.yaml";

/**
 * Load AgentDock configuration from a project directory.
 * Returns a default config if the file doesn't exist.
 * Throws on invalid YAML or schema validation errors.
 */
export function loadConfig(projectPath: string): AgentDockConfig {
  const configPath = path.join(projectPath, CONFIG_FILENAME);

  if (!existsSync(configPath)) {
    return AgentDockConfigSchema.parse({});
  }

  const content = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(content);

  return AgentDockConfigSchema.parse(parsed ?? {});
}
