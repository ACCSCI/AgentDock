import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { apiPlugin } from "./plugins/api";

// Vite's built-in .env loading happens AFTER config evaluation, so we must
// read .env directly here so that the server.port IIFE can read FRONTEND_PORT.
// File values take precedence over inherited environment variables.
const envFile = resolve(__dirname, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    process.env[key] = val;
  }
}

export default defineConfig({
  plugins: [tanstackRouter({ quoteStyle: "double" }), react(), apiPlugin()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
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
      // Worktrees live under .agentdock/worktrees and contain their own
      // index.html / tsconfig.json / vite.config.ts. Creating or deleting a
      // session mutates those files, which would otherwise trigger a Vite
      // full page reload and abort the in-flight create/delete SSE stream
      // (surfacing as "network error" in the UI). Ignore the whole dir.
      ignored: ["**/.agentdock/**"],
    },
  },
});
