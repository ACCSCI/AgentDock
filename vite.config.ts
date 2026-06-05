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
  },
});
