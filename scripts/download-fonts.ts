/**
 * Download bundled font files into public/fonts/.
 *
 * Run via: bun run scripts/download-fonts.ts
 * or automatically via `bun run prebuild`.
 *
 * Fonts:
 *   - Maple Mono v7.9 (NF + CN) — SIL OFL 1.1
 *   - JetBrains Mono v2.304     — SIL OFL 1.1
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const FONTS_DIR = resolve(import.meta.dirname, "../public/fonts");

interface FontSource {
  repo: string;
  tag: string;
  files: string[];
  label: string;
}

const SOURCES: FontSource[] = [
  {
    label: "Maple Mono v7.9 (NF + CN)",
    repo: "subframe7536/maple-font",
    tag: "v7.9",
    files: [
      "MapleMono-NF-CN-Regular.ttf",
      "MapleMono-NF-CN-Bold.ttf",
      "MapleMono-NF-CN-Italic.ttf",
      "MapleMono-NF-CN-BoldItalic.ttf",
      "LICENSE.txt",
    ],
  },
  {
    label: "JetBrains Mono v2.304",
    repo: "JetBrains/JetBrainsMono",
    tag: "v2.304",
    files: [
      "JetBrainsMono-Regular.ttf",
      "JetBrainsMono-Bold.ttf",
      "JetBrainsMono-Italic.ttf",
      "JetBrainsMono-BoldItalic.ttf",
    ],
    // JetBrains Mono releases bundle fonts inside a zip — extract from it.
    zip: "JetBrainsMono-2.304.zip",
    zipPaths: [
      "fonts/ttf/JetBrainsMono-Regular.ttf",
      "fonts/ttf/JetBrainsMono-Bold.ttf",
      "fonts/ttf/JetBrainsMono-Italic.ttf",
      "fonts/ttf/JetBrainsMono-BoldItalic.ttf",
    ],
  },
];

function main() {
  if (!existsSync(FONTS_DIR)) {
    mkdirSync(FONTS_DIR, { recursive: true });
  }

  let anyDownloaded = false;

  for (const src of SOURCES) {
    const allPresent = src.files.every((f) =>
      existsSync(resolve(FONTS_DIR, f)),
    );
    if (allPresent) {
      console.log(`${src.label} already present — skipping.`);
      continue;
    }

    console.log(`Downloading ${src.label} ...`);

    if (src.zip) {
      // Download the zip, extract needed files, then remove the zip.
      const zipPath = resolve(FONTS_DIR, src.zip);
      if (!existsSync(zipPath)) {
        execSync(
          `gh release download "${src.tag}" --repo "${src.repo}" --pattern "${src.zip}" --dir "${FONTS_DIR}" --clobber`,
          { stdio: "inherit" },
        );
      }
      for (let i = 0; i < src.files.length; i++) {
        const dest = resolve(FONTS_DIR, src.files[i]);
        if (existsSync(dest)) continue;
        execSync(
          `unzip -o "${zipPath}" "${src.zipPaths![i]}" -d "${FONTS_DIR}"`,
          { stdio: "inherit" },
        );
        // Move from nested path to flat.
        execSync(
          `mv "${resolve(FONTS_DIR, src.zipPaths![i])}" "${dest}"`,
          { stdio: "inherit" },
        );
      }
      // Clean up zip and extracted dirs.
      try { execSync(`rm -rf "${resolve(FONTS_DIR, "fonts")}"`, { stdio: "ignore" }); } catch { /* ok */ }
      try { execSync(`rm -f "${zipPath}"`, { stdio: "ignore" }); } catch { /* ok */ }
    } else {
      for (const file of src.files) {
        if (existsSync(resolve(FONTS_DIR, file))) continue;
        execSync(
          `gh release download "${src.tag}" --repo "${src.repo}" --pattern "${file}" --dir "${FONTS_DIR}" --clobber`,
          { stdio: "inherit" },
        );
      }
    }

    anyDownloaded = true;
  }

  if (!anyDownloaded) {
    console.log("All fonts already present.");
  } else {
    console.log("Done.");
  }
}

main();
