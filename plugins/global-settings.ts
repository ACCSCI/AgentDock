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
  const settings = loadSettings();
  settings.portPoolStart = Math.max(1024, Math.min(65535, start));
  // Ensure start < end
  if (settings.portPoolStart >= settings.portPoolEnd) {
    settings.portPoolEnd = settings.portPoolStart + 100;
  }
  saveSettings(settings);
}

/**
 * Set the port pool end value.
 */
export function setPortPoolEnd(end: number): void {
  const settings = loadSettings();
  settings.portPoolEnd = Math.max(1024, Math.min(65535, end));
  // Ensure start < end
  if (settings.portPoolEnd <= settings.portPoolStart) {
    settings.portPoolStart = settings.portPoolEnd - 100;
    if (settings.portPoolStart < 1024) settings.portPoolStart = 1024;
  }
  saveSettings(settings);
}

/**
 * Get all settings.
 */
export function getAllSettings(): GlobalSettings {
  return { ...loadSettings() };
}

/**
 * Update multiple settings at once.
 */
export function updateSettings(updates: Partial<GlobalSettings>): void {
  const settings = loadSettings();
  if (updates.portPoolStart !== undefined) {
    settings.portPoolStart = Math.max(1024, Math.min(65535, updates.portPoolStart));
  }
  if (updates.portPoolEnd !== undefined) {
    settings.portPoolEnd = Math.max(1024, Math.min(65535, updates.portPoolEnd));
  }
  // Ensure start < end
  if (settings.portPoolStart >= settings.portPoolEnd) {
    settings.portPoolEnd = settings.portPoolStart + 100;
  }
  saveSettings(settings);
}
