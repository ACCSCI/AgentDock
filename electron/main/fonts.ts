/**
 * Font Manager — automatic bundled font provisioning.
 *
 * On app startup, checks whether the required monospace fonts (Maple Mono
 * NF CN with CJK support, JetBrains Mono) exist in the user-data directory.
 * If missing, downloads them silently in the background from GitHub Releases
 * and notifies the renderer via IPC so the `@font-face` rules can resolve.
 *
 * In production builds the custom protocol `agentdock-fonts://` maps
 * `userData/fonts/` to the renderer's `/fonts/` path. In dev mode Vite's
 * dev-server serves `public/fonts/` directly, so no protocol is registered.
 *
 * Font versions must stay in sync with `scripts/download-fonts.ts`.
 */
import { app, protocol, type BrowserWindow } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { log } from "../../plugins/logger.js";

// ── Constants ──────────────────────────────────────────────────────────

const FONTS_SUBDIR = "fonts";
const READY_CHANNEL = "fonts:ready";

// Maple Mono NF CN v7.9 — includes CJK glyphs (SIL OFL 1.1)
const MAPLE_MONO_TAG = "v7.9";
const MAPLE_MONO_FILES = [
  "MapleMono-NF-CN-Regular.ttf",
  "MapleMono-NF-CN-Bold.ttf",
  "MapleMono-NF-CN-Italic.ttf",
  "MapleMono-NF-CN-BoldItalic.ttf",
];

// JetBrains Mono v2.304 — shipped as a zip archive (SIL OFL 1.1)
const JETBRAINS_TAG = "v2.304";
const JETBRAINS_ZIP = "JetBrainsMono-2.304.zip";
const JETBRAINS_EXTRACT = [
  { inner: "fonts/ttf/JetBrainsMono-Regular.ttf", dest: "JetBrainsMono-Regular.ttf" },
  { inner: "fonts/ttf/JetBrainsMono-Bold.ttf", dest: "JetBrainsMono-Bold.ttf" },
  { inner: "fonts/ttf/JetBrainsMono-Italic.ttf", dest: "JetBrainsMono-Italic.ttf" },
  { inner: "fonts/ttf/JetBrainsMono-BoldItalic.ttf", dest: "JetBrainsMono-BoldItalic.ttf" },
];

// ── Path helpers ───────────────────────────────────────────────────────

function fontsDir(): string {
  return join(app.getPath("userData"), FONTS_SUBDIR);
}

function fontExists(name: string): boolean {
  return existsSync(join(fontsDir(), name));
}

// ── Protocol registration ──────────────────────────────────────────────

/**
 * Register the `agentdock-fonts://` custom protocol in production builds
 * so that `@font-face` rules referencing
 * `agentdock-fonts:///fonts/<file>` resolve to files in userData.
 *
 * Must be called **before** any BrowserWindow is created.
 * Skipped in dev mode — Vite's dev-server serves `public/fonts/` instead.
 */
export function registerFontProtocol(): void {
  if (process.env.ELECTRON_RENDERER_URL) return; // dev mode

  const dir = fontsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  protocol.handle("agentdock-fonts", (request) => {
    // URL shape: agentdock-fonts:///fonts/MapleMono-NF-CN-Regular.ttf
    const relativePath = new URL(request.url).pathname; // e.g. "/fonts/MapleMono-..."
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

// ── GitHub helpers ─────────────────────────────────────────────────────

interface GhAsset {
  name: string;
  browser_download_url: string;
}

async function ghReleaseAssets(repo: string, tag: string): Promise<Map<string, GhAsset>> {
  const url = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub release ${repo}@${tag}: ${res.status}`);
  const data = (await res.json()) as { assets: GhAsset[] };
  return new Map(data.assets.map((a) => [a.name, a]));
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

function unzipSingle(zipPath: string, outDir: string, innerPath: string, destPath: string): void {
  const esc = (s: string) => s.replace(/'/g, "'\\''");
  const cmds = [
    `unzip -o '${esc(zipPath)}' '${esc(innerPath)}' -d '${esc(outDir)}'`,
    `tar -xf '${esc(zipPath)}' '${esc(innerPath)}' -C '${esc(outDir)}'`,
  ];
  for (const cmd of cmds) {
    try {
      execSync(cmd, { stdio: "ignore" });
      renameSync(join(outDir, innerPath), destPath);
      return;
    } catch { /* try next */ }
  }
  // PowerShell fallback
  try {
    execSync(
      `powershell -Command "Expand-Archive -Path '${esc(zipPath)}' -DestinationPath '${esc(outDir)}' -Force"`,
      { stdio: "ignore" },
    );
    renameSync(join(outDir, innerPath), destPath);
    return;
  } catch { /* fail */ }
  throw new Error(`Could not extract ${innerPath} from ${zipPath}`);
}

// ── Font download ──────────────────────────────────────────────────────

async function downloadMapleMono(destDir: string, assets: Map<string, GhAsset>): Promise<void> {
  for (const file of MAPLE_MONO_FILES) {
    const dest = join(destDir, file);
    if (existsSync(dest)) continue;
    const asset = assets.get(file);
    if (!asset) throw new Error(`Asset ${file} not found in maple-font@${MAPLE_MONO_TAG}`);
    log.info({ file }, "downloading Maple Mono");
    await downloadFile(asset.browser_download_url, dest);
  }
}

async function downloadJetBrainsMono(destDir: string, assets: Map<string, GhAsset>): Promise<void> {
  // Check if already extracted
  if (JETBRAINS_EXTRACT.every((e) => existsSync(join(destDir, e.dest)))) return;

  const zipDest = join(destDir, JETBRAINS_ZIP);
  if (!existsSync(zipDest)) {
    const asset = assets.get(JETBRAINS_ZIP);
    if (!asset) throw new Error(`Asset ${JETBRAINS_ZIP} not found in JetBrainsMono@${JETBRAINS_TAG}`);
    log.info({ file: JETBRAINS_ZIP }, "downloading JetBrains Mono");
    await downloadFile(asset.browser_download_url, zipDest);
  }
  for (const { inner, dest } of JETBRAINS_EXTRACT) {
    const destPath = join(destDir, dest);
    if (existsSync(destPath)) continue;
    log.info({ file: dest }, "extracting JetBrains Mono");
    unzipSingle(zipDest, destDir, inner, destPath);
  }
  rmSync(zipDest, { force: true });
}

async function downloadFonts(): Promise<void> {
  const dir = fontsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Fast-path: if the first Maple font exists, assume all are present.
  if (fontExists(MAPLE_MONO_FILES[0]) && fontExists(JETBRAINS_EXTRACT[0].dest)) {
    log.info("bundled fonts already present — skipping download");
    return;
  }

  log.info("downloading bundled fonts …");

  const mapleAssets = await ghReleaseAssets("subframe7536/maple-font", MAPLE_MONO_TAG);
  await downloadMapleMono(dir, mapleAssets);

  const jetbrainsAssets = await ghReleaseAssets("JetBrains/JetBrainsMono", JETBRAINS_TAG);
  await downloadJetBrainsMono(dir, jetbrainsAssets);

  log.info("bundled fonts downloaded");
}

// ── Renderer notification ──────────────────────────────────────────────

function notifyRenderer(win: BrowserWindow): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(READY_CHANNEL);
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Main entry point — called once during bootstrap after the window is
 * created. Kicks off a background font download if needed. The window
 * loads immediately with fallback system fonts; once the download finishes
 * the renderer is notified and CSS re-renders with the real fonts
 * (`font-display: swap`).
 *
 * The custom protocol (`registerFontProtocol`) must be registered before
 * any BrowserWindow is created — call it at the module level in main.ts.
 */
export async function ensureFontsReady(win: BrowserWindow): Promise<void> {
  // Background — never blocks the window from loading.
  downloadFonts()
    .then(() => notifyRenderer(win))
    .catch((err) => {
      log.warn({ err }, "bundled font download failed — using fallback fonts");
    });
}
