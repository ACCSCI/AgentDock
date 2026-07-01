/**
 * Global Settings — stores app-wide settings like port pool configuration.
 *
 * Settings are stored in a JSON file at <userData>/settings.json
 * In dev mode: <cwd>/data/settings.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

interface GlobalSettings {
  portPoolStart: number;
  portPoolEnd: number;
}

const DEFAULT_SETTINGS: GlobalSettings = {
  portPoolStart: 30000,
  portPoolEnd: 30100,
};

let settingsPath: string | null = null;
let cachedSettings: GlobalSettings | null = null;

/**
 * Initialize the settings path. Called once at app startup.
 */
export function initGlobalSettings(basePath: string): void {
  const dataDir = path.join(basePath, "data");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  settingsPath = path.join(dataDir, "settings.json");
  cachedSettings = null; // Reset cache
}

/**
 * Load settings from disk (or return cached).
 */
function loadSettings(): GlobalSettings {
  if (cachedSettings && settingsPath) return cachedSettings;

  if (!settingsPath) {
    return { ...DEFAULT_SETTINGS };
  }

  try {
    if (existsSync(settingsPath)) {
      const content = readFileSync(settingsPath, "utf-8");
      const parsed = JSON.parse(content) as Partial<GlobalSettings>;
      cachedSettings = { ...DEFAULT_SETTINGS, ...parsed };
      return cachedSettings;
    }
  } catch {
    // Ignore parse errors, use defaults
  }

  cachedSettings = { ...DEFAULT_SETTINGS };
  return cachedSettings;
}

/**
 * Save settings to disk.
 */
function saveSettings(settings: GlobalSettings): void {
  if (!settingsPath) return;

  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    cachedSettings = settings;
  } catch {
    // Ignore write errors
  }
}

/**
 * Get the port pool start value.
 */
export function getPortPoolStart(): number {
  return loadSettings().portPoolStart;
}

/**
 * Get the port pool end value.
 */
export function getPortPoolEnd(): number {
  return loadSettings().portPoolEnd;
}

/**
 * Set the port pool start value.
 */
export function setPortPoolStart(start: number): void {
  updateSettings({ portPoolStart: start });
}

/**
 * Set the port pool end value.
 */
export function setPortPoolEnd(end: number): void {
  updateSettings({ portPoolEnd: end });
}

/**
 * Get all settings.
 */
export function getAllSettings(): GlobalSettings {
  return { ...loadSettings() };
}

/**
 * Update multiple settings atomically with strict boundary checks.
 *
 * Why: clamping start/end independently in setPortPoolStart/setPortPoolEnd
 * leaves the door open to invalid ranges (start=65535 → end=65635, or
 * end=1024 → start=1024 with start>=end). updateSettings is the single
 * place where the invariants `1024 <= start < end <= 65535` are enforced,
 * so callers can safely update one side without re-validating the other.
 */
export function updateSettings(updates: Partial<GlobalSettings>): void {
  const settings = loadSettings();
  if (updates.portPoolStart !== undefined) {
    settings.portPoolStart = Math.max(1024, Math.min(65534, updates.portPoolStart));
  }
  if (updates.portPoolEnd !== undefined) {
    settings.portPoolEnd = Math.max(1025, Math.min(65535, updates.portPoolEnd));
  }
  // Ensure start < end. If the caller only updates one side and the result
  // is invalid, push the other side to keep at least a 1-port gap.
  if (settings.portPoolStart >= settings.portPoolEnd) {
    if (updates.portPoolStart !== undefined) {
      // start was just set; bump end upward to be valid
      settings.portPoolEnd = Math.min(65535, settings.portPoolStart + 100);
      if (settings.portPoolStart >= settings.portPoolEnd) {
        settings.portPoolStart = settings.portPoolEnd - 1;
      }
    } else {
      // end was just set; bump start downward to be valid
      settings.portPoolStart = Math.max(1024, settings.portPoolEnd - 100);
      if (settings.portPoolStart >= settings.portPoolEnd) {
        settings.portPoolEnd = settings.portPoolStart + 1;
      }
    }
  }
  saveSettings(settings);
}
