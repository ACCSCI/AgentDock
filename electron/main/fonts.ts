/**
 * Font Manager — copy bundled fonts to user-data on first launch.
 *
 * The build step (`copyBundledFontsPlugin` in electron.vite.config.ts)
 * places the .ttf files under `app.getAppPath()/fonts/` alongside the
 * bundled main-process code. On startup we copy them into
 * `userData/fonts/` (where the `agentdock-fonts://` protocol serves them
 * from) — only when they are not already present, so subsequent launches
 * are instant and work offline.
 *
 * A version file (`font-bundled-version`) is written alongside the fonts
 * so that a future release that ships new font files triggers a fresh copy.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type BrowserWindow, app, protocol } from "electron";
import { log } from "../../plugins/logger.js";

// ── Constants ──────────────────────────────────────────────────────────

const FONTS_SUBDIR = "fonts";
const READY_CHANNEL = "fonts:ready";
const VERSION_FILE = "font-bundled-version";

// Maple Mono NF CN v7.9
const MAPLE_MONO_FILES = [
  "MapleMono-NF-CN-Regular.ttf",
  "MapleMono-NF-CN-Bold.ttf",
  "MapleMono-NF-CN-Italic.ttf",
  "MapleMono-NF-CN-BoldItalic.ttf",
];

// JetBrains Mono v2.304
const JETBRAINS_FILES = [
  "JetBrainsMono-Regular.ttf",
  "JetBrainsMono-Bold.ttf",
  "JetBrainsMono-Italic.ttf",
  "JetBrainsMono-BoldItalic.ttf",
];

const ALL_BUNDLED_FILES = [...MAPLE_MONO_FILES, ...JETBRAINS_FILES];

// Increment this whenever the bundled font set changes so existing
// user-data copies are refreshed on next launch.
const BUNDLED_VERSION = "1";

// ── Path helpers ───────────────────────────────────────────────────────

function bundledFontsDir(): string {
  return join(app.getAppPath(), FONTS_SUBDIR);
}

function userFontsDir(): string {
  return join(app.getPath("userData"), FONTS_SUBDIR);
}

function userVersionPath(): string {
  return join(userFontsDir(), VERSION_FILE);
}

// ── Protocol registration ──────────────────────────────────────────────

/**
 * Register the `agentdock-fonts://` custom protocol so that `@font-face`
 * rules referencing `agentdock-fonts:///fonts/<file>` resolve to files
 * in userData/fonts/.
 *
 * Must be called before any BrowserWindow is created.
 */
export function registerFontProtocol(): void {
  const dir = userFontsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  protocol.handle("agentdock-fonts", async (request) => {
    const relativePath = new URL(request.url).pathname;
    const filePath = join(dir, relativePath.replace(/^\/fonts\//, ""));
    try {
      const data = readFileSync(filePath);
      return new Response(data);
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  log.info("agentdock-fonts protocol registered");
}

// ── Bundled → userData copy ───────────────────────────────────────────

/**
 * Returns true when the fonts in userData/fonts/ match the current
 * bundled version (i.e. no copy needed).
 */
function fontsAreUpToDate(): boolean {
  const vPath = userVersionPath();
  if (!existsSync(vPath)) return false;

  try {
    const current = readdirSync(userFontsDir());
    const hasAll = ALL_BUNDLED_FILES.every((f) => current.includes(f));
    if (!hasAll) return false;
    const version = readFileSync(vPath, "utf-8").trim();
    return version === BUNDLED_VERSION;
  } catch {
    return false;
  }
}

/**
 * Copy all font .ttf files from the bundled location (app.getAppPath()/fonts/)
 * into userData/fonts/. Writes a version marker so we can detect future updates.
 */
function copyBundledFonts(): void {
  const srcDir = bundledFontsDir();
  const dstDir = userFontsDir();

  if (!existsSync(dstDir)) {
    mkdirSync(dstDir, { recursive: true });
  }

  // Validate source — if the build plugin didn't copy fonts, warn and
  // fall through silently so dev-mode (Vite serving public/fonts/) still works.
  if (!existsSync(srcDir)) {
    log.warn(
      `bundled fonts not found at ${srcDir} — running in dev mode? fonts served from public/fonts/`,
    );
    return;
  }

  // Skip copy if already up to date
  if (fontsAreUpToDate()) {
    log.info("bundled fonts already present in userData — skipping copy");
    return;
  }

  // Clear old files (partial copy from a previous failed launch)
  try {
    const existing = readdirSync(dstDir);
    for (const f of existing) {
      if (f !== VERSION_FILE) {
        rmSync(join(dstDir, f), { force: true });
      }
    }
  } catch {
    // dir may not exist yet
  }

  // Copy all font files
  for (const file of ALL_BUNDLED_FILES) {
    const src = join(srcDir, file);
    const dst = join(dstDir, file);
    if (existsSync(src)) {
      cpSync(src, dst);
    } else {
      log.warn({ file }, "bundled font file missing — font may not render correctly");
    }
  }

  // Write version marker
  writeFileSync(userVersionPath(), BUNDLED_VERSION);
  log.info(`bundled fonts copied to userData (v${BUNDLED_VERSION})`);
}

// ── Renderer notification ──────────────────────────────────────────────

function notifyRenderer(win: BrowserWindow): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(READY_CHANNEL);
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Called once during bootstrap after the window is created.
 *
 * Copies bundled fonts to userData if needed (instant local operation).
 * Notifies the renderer so `@font-face` rules resolve.
 */
export function ensureFontsReady(win: BrowserWindow): void {
  // Fonts are now bundled — copy is always instantaneous.
  copyBundledFonts();
  notifyRenderer(win);
}
