/**
 * electron-vite configuration
 *
 * Three-target model: main process, preload script, renderer.
 * Each target is built separately:
 *   - main/preload: bundled with esbuild (auto-restart on change)
 *   - renderer: Vite dev server with HMR
 *
 * Phase 0: scaffold only. Renderer config will pick up the existing
 * vite.config.ts plugins (tanstackRouter, react) in Phase 3.
 */
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";
import { loadDotEnvIntoProcess } from "./plugins/env.js";

// Dev-mode entry: read .env from cwd (typically the worktree root where
// 父 AgentDock wrote the claimed ports via port-write-env.ts). This must
// run before `defineConfig` below, since the renderer.server.port IIFE
// reads process.env.FRONTEND_PORT at config-eval time. Production never
// loads .env — see 新架构 §8.
// Gracefully skip when .env is absent (CI/CD, fresh clone) instead of
// throwing — the build still works, just without env-var port overrides.
try { loadDotEnvIntoProcess(); } catch { /* .env optional */ }

/**
 * Copy `plugins/pty-host.cjs` next to the main bundle. The PTY host is
 * spawned with `spawn(electron.exe, [path, "ELECTRON_RUN_AS_NODE=1"])`
 * and its path resolves relative to `__dirname` of the bundled main
 * file. Without this copy, prod launches show
 *   "Error launching app: Unable to find Electron app at
 *    out/main/pty-host.cjs"
 * the moment the user tries to open a terminal.
 */
function copyPtyHostPlugin(): Plugin {
  return {
    name: "agentdock:copy-pty-host",
    apply: "build",
    closeBundle() {
      const src = resolve(__dirname, "plugins/pty-host.cjs");
      const dest = resolve(__dirname, "out/main/pty-host.cjs");
      if (!existsSync(src)) {
        this.warn?.(`pty-host.cjs missing at ${src} — terminal will not work`);
        return;
      }
      cpSync(src, dest);
    },
  };
}

/**
 * Copy `public/fonts/` into the main-process output directory so the
 * fonts are bundled with the packaged app (no runtime download needed).
 *
 * Depends on `prebuild` having already run `bun run download-fonts`
 * so that `public/fonts/` contains the .ttf files.
 */
function copyBundledFontsPlugin(): Plugin {
  return {
    name: "agentdock:copy-fonts",
    apply: "build",
    closeBundle() {
      const src = resolve(__dirname, "public/fonts");
      const dest = resolve(__dirname, "out/main/fonts");
      if (!existsSync(src)) {
        this.warn?.(`public/fonts/ missing — run \`bun run download-fonts\` first`);
        return;
      }
      cpSync(src, dest, { recursive: true });
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyPtyHostPlugin(), copyBundledFontsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, "electron/main.ts") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, "electron/preload.ts") },
    },
  },
  renderer: {
    // Use the project root as the renderer root so index.html (which lives
    // at the repo root and references /src/main.tsx) resolves correctly.
    // The src/ alias still maps to ./src for code imports.
    root: __dirname,
    publicDir: "public",
    plugins: [
      // Explicit routesDirectory so the tanstackRouter plugin doesn't
      // double-prefix the path when root is the project root.
      tanstackRouter({
        quoteStyle: "double",
        routesDirectory: resolve(__dirname, "src/routes"),
        generatedRouteTree: resolve(__dirname, "src/routeTree.gen.ts"),
      }),
      react(),
    ],
    resolve: {
      alias: { "@": resolve(__dirname, "./src") },
    },
    build: {
      outDir: resolve(__dirname, "out/renderer"),
      emptyOutDir: true,
      // Force SPA mode (not SSR) so the build produces index.html.
      ssr: false,
      rollupOptions: {
        input: resolve(__dirname, "index.html"),
      },
    },
    server: {
      port: (() => {
        const p = Number(process.env.FRONTEND_PORT);
        if (!p || p < 1 || p > 65535) {
          throw new Error("FRONTEND_PORT is required — set it in .env or environment");
        }
        return p;
      })(),
      strictPort: true,
      watch: {
        ignored: ["**/.agentdock/**", "**/.agentdock-dev/**", "**/.claude/**"],
      },
    },
  },
});