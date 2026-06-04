import { existsSync, readFileSync, writeFileSync } from "node:fs";

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
