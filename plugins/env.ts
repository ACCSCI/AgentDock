import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const FALLBACK_STRIP_KEYS = new Set([
  "FRONTEND_PORT",
  "BACKEND_PORT",
  "WS_PORT",
  "DEBUG_PORT",
  "PREVIEW_PORT",
  "PORT",
]);

/**
 * Parse .env file content into key-value pairs.
 */
export function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip inline comments for unquoted values
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIdx = value.indexOf(" #");
      if (commentIdx !== -1) {
        value = value.slice(0, commentIdx).trim();
      }
    } else {
      // Strip surrounding quotes
      const quote = value[0];
      const closingIdx = value.indexOf(quote, 1);
      if (closingIdx !== -1) {
        value = value.slice(1, closingIdx);
      }
    }

    result[key] = value;
  }

  return result;
}

export function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  return parseEnv(readFileSync(filePath, "utf-8"));
}

export function readWorkspaceEnv(workspacePath: string): Record<string, string> {
  return readEnvFile(path.join(workspacePath, ".env"));
}

export function buildScopedChildEnv(
  workspacePath: string,
  runtimeEnv: Record<string, string> = {},
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const workspaceEnv = readWorkspaceEnv(workspacePath);
  const env: NodeJS.ProcessEnv = { ...parentEnv };

  for (const key of FALLBACK_STRIP_KEYS) {
    delete env[key];
  }
  for (const key of Object.keys(workspaceEnv)) {
    delete env[key];
  }

  return {
    ...env,
    ...workspaceEnv,
    ...runtimeEnv,
  };
}

/**
 * Merge updates into existing env config. Returns a new object.
 */
export function mergeEnv(
  existing: Record<string, string>,
  updates: Record<string, string>,
): Record<string, string> {
  return { ...existing, ...updates };
}

/**
 * Serialize env config to .env format string.
 */
export function writeEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + (Object.keys(env).length > 0 ? "\n" : "");
}

/**
 * Discover port variable names from an .env file.
 * Returns all keys ending with `_PORT`.
 */
export function discoverPortKeysFromEnv(envPath: string): string[] {
  const env = readEnvFile(envPath);
  return Object.keys(env).filter((k) => k.endsWith("_PORT"));
}

/**
 * Read .env file, merge updates, and write back.
 */
export function updateEnvFile(
  filePath: string,
  updates: Record<string, string>,
): void {
  let existing: Record<string, string> = {};
  if (existsSync(filePath)) {
    existing = parseEnv(readFileSync(filePath, "utf-8"));
  }
  const merged = mergeEnv(existing, updates);
  writeFileSync(filePath, writeEnv(merged), "utf-8");
}
