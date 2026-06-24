/**
 * Download bundled font files into public/fonts/.
 *
 * Run via: bun run scripts/download-fonts.ts
 * or automatically via `bun run prebuild`.
 *
 * Fonts:
 *   - Maple Mono v7.9 (NF + CN) — SIL OFL 1.1
 *   - JetBrains Mono v2.304     — SIL OFL 1.1
 *
 * Uses Node.js built-in APIs (fetch, fs, child_process) — no external CLI deps.
 * Cross-platform: works on Windows, macOS, and Linux.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

const FONTS_DIR = resolve(import.meta.dirname, "../public/fonts");

// ---- GitHub release helpers ----

async function ghReleaseAssets(repo: string, tag: string): Promise<{ name: string; browser_download_url: string }[]> {
  const url = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`Failed to fetch release ${repo}@${tag}: ${res.status}`);
  const data = (await res.json()) as { assets: { name: string; browser_download_url: string }[] };
  return data.assets;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

function unzipFile(zipPath: string, outDir: string, innerPath: string, destPath: string): void {
  // Cross-platform unzip: try `unzip` (Linux/macOS/Git Bash) then `tar` then PowerShell.
  const escaped = (s: string) => s.replace(/'/g, "'\\''");
  const cmds = [
    `unzip -o '${escaped(zipPath)}' '${escaped(innerPath)}' -d '${escaped(outDir)}'`,
    `tar -xf '${escaped(zipPath)}' '${escaped(innerPath)}' -C '${escaped(outDir)}'`,
  ];
  for (const cmd of cmds) {
    try {
      execSync(cmd, { stdio: "ignore" });
      const extracted = join(outDir, innerPath);
      renameSync(extracted, destPath);
      return;
    } catch { /* try next */ }
  }
  // Windows PowerShell fallback (no single-file extraction — extract all then move)
  try {
    execSync(
      `powershell -Command "Expand-Archive -Path '${escaped(zipPath)}' -DestinationPath '${escaped(outDir)}' -Force"`,
      { stdio: "ignore" },
    );
    const extracted = join(outDir, innerPath);
    renameSync(extracted, destPath);
    return;
  } catch { /* fail */ }
  throw new Error(`Could not extract ${innerPath} from ${zipPath} — no supported unzip tool found`);
}

// ---- Font sources ----

interface FontSource {
  label: string;
  repo: string;
  tag: string;
  /** Direct release asset files to download (flat). */
  directFiles: string[];
  /** Zip archive to download + extract from. */
  zipAsset?: string;
  /** Paths inside the zip → filenames in FONTS_DIR. */
  zipExtract?: { innerPath: string; destName: string }[];
}

const SOURCES: FontSource[] = [
  {
    label: "Maple Mono v7.9 (NF + CN)",
    repo: "subframe7536/maple-font",
    tag: "v7.9",
    directFiles: [],
    zipAsset: "MapleMono-NF-CN.zip",
    zipExtract: [
      { innerPath: "MapleMono-NF-CN-Regular.ttf", destName: "MapleMono-NF-CN-Regular.ttf" },
      { innerPath: "MapleMono-NF-CN-Bold.ttf", destName: "MapleMono-NF-CN-Bold.ttf" },
      { innerPath: "MapleMono-NF-CN-Italic.ttf", destName: "MapleMono-NF-CN-Italic.ttf" },
      { innerPath: "MapleMono-NF-CN-BoldItalic.ttf", destName: "MapleMono-NF-CN-BoldItalic.ttf" },
    ],
  },
  {
    label: "JetBrains Mono v2.304",
    repo: "JetBrains/JetBrainsMono",
    tag: "v2.304",
    directFiles: [],
    zipAsset: "JetBrainsMono-2.304.zip",
    zipExtract: [
      { innerPath: "fonts/ttf/JetBrainsMono-Regular.ttf", destName: "JetBrainsMono-Regular.ttf" },
      { innerPath: "fonts/ttf/JetBrainsMono-Bold.ttf", destName: "JetBrainsMono-Bold.ttf" },
      { innerPath: "fonts/ttf/JetBrainsMono-Italic.ttf", destName: "JetBrainsMono-Italic.ttf" },
      { innerPath: "fonts/ttf/JetBrainsMono-BoldItalic.ttf", destName: "JetBrainsMono-BoldItalic.ttf" },
    ],
  },
];

// ---- Main ----

async function main() {
  if (!existsSync(FONTS_DIR)) {
    mkdirSync(FONTS_DIR, { recursive: true });
  }

  let anyDownloaded = false;

  for (const src of SOURCES) {
    // Check if already present
    const allDirect = src.directFiles.every((f) => existsSync(join(FONTS_DIR, f)));
    const allZip = !src.zipExtract || src.zipExtract.every((e) => existsSync(join(FONTS_DIR, e.destName)));
    if (allDirect && allZip) {
      console.log(`${src.label} already present — skipping.`);
      continue;
    }

    console.log(`Downloading ${src.label} ...`);

    // Fetch release metadata
    const assets = await ghReleaseAssets(src.repo, src.tag);
    const assetMap = new Map(assets.map((a) => [a.name, a.browser_download_url]));

    // Download direct files
    for (const file of src.directFiles) {
      const dest = join(FONTS_DIR, file);
      if (existsSync(dest)) continue;
      const url = assetMap.get(file);
      if (!url) throw new Error(`Asset ${file} not found in ${src.repo}@${src.tag}`);
      console.log(`  ${file}`);
      await downloadFile(url, dest);
    }

    // Download + extract zip
    if (src.zipAsset && src.zipExtract) {
      const zipDest = join(FONTS_DIR, src.zipAsset);
      if (!existsSync(zipDest)) {
        const url = assetMap.get(src.zipAsset);
        if (!url) throw new Error(`Asset ${src.zipAsset} not found in ${src.repo}@${src.tag}`);
        console.log(`  ${src.zipAsset}`);
        await downloadFile(url, zipDest);
      }
      for (const { innerPath, destName } of src.zipExtract) {
        const dest = join(FONTS_DIR, destName);
        if (existsSync(dest)) continue;
        console.log(`  extract ${destName}`);
        unzipFile(zipDest, FONTS_DIR, innerPath, dest);
      }
      // Clean up zip
      rmSync(zipDest, { force: true });
    }

    anyDownloaded = true;
  }

  if (!anyDownloaded) {
    console.log("All fonts already present.");
  } else {
    console.log("Done.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
