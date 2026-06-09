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

// --- EnvConfig ---
const PORT_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
export const PortVarNameSchema = z.string().regex(PORT_NAME_RE, "端口变量名必须是大写字母、数字、下划线，且以字母开头");

export const PORT_KEYS_DEFAULT = [
  "FRONTEND_PORT",
  "BACKEND_PORT",
  "WS_PORT",
  "DEBUG_PORT",
  "PREVIEW_PORT",
] as const;

export const EnvConfigSchema = z.object({
  ports: z.array(PortVarNameSchema).min(1, "至少需要 1 个端口变量").default([...PORT_KEYS_DEFAULT]),
}).default({ ports: [...PORT_KEYS_DEFAULT] });
export type EnvConfig = z.infer<typeof EnvConfigSchema>;

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
  env: EnvConfigSchema,
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
  const parsed = parseYaml(content) ?? {};

  // Backward compatibility: strip `required` from async hooks to avoid
  // schema validation errors (async + required is now forbidden).
  if (parsed.hooks) {
    for (const event of Object.keys(parsed.hooks)) {
      if (Array.isArray(parsed.hooks[event])) {
        parsed.hooks[event] = parsed.hooks[event].map((h: Record<string, unknown>) => {
          if (h.async && h.required) {
            return { ...h, required: false };
          }
          return h;
        });
      }
    }
  }

  return AgentDockConfigSchema.parse(parsed);
}
