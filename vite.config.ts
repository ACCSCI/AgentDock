import { resolve } from "node:path";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { apiPlugin } from "./plugins/api";

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
