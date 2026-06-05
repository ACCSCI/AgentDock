/**
 * Start AgentDock dev server and open browser.
 *
 * Usage: bun run scripts/start.ts
 *
 * Requires FRONTEND_PORT to be set in .env or environment.
 */
import { spawn } from "node:child_process";

const port = process.env.FRONTEND_PORT;
if (!port) {
  console.error("FRONTEND_PORT is required. Set it in .env or environment.");
  process.exit(1);
}

// Start vite dev server
const dev = spawn("bun", ["run", "dev"], { stdio: "inherit", shell: true });
dev.on("error", (err) => {
  console.error("Failed to start dev server:", err.message);
  process.exit(1);
});

// Wait for server to start, then open browser
setTimeout(() => {
  const url = `http://localhost:${port}`;
  const platform = process.platform;
  if (platform === "win32") {
    spawn("cmd", ["/c", "start", url], { stdio: "ignore", detached: true }).unref();
  } else if (platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  } else {
    spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  }
}, 3000);

// Forward signals to child
process.on("SIGINT", () => { dev.kill("SIGINT"); process.exit(0); });
process.on("SIGTERM", () => { dev.kill("SIGTERM"); process.exit(0); });
