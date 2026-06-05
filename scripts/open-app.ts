/**
 * Open AgentDock in browser.
 *
 * Usage: bun run scripts/open-app.ts
 *
 * Requires FRONTEND_PORT to be set in .env or environment.
 */
import { spawn } from "node:child_process";

const port = process.env.FRONTEND_PORT;
if (!port) {
  console.error("FRONTEND_PORT is required. Set it in .env or environment.");
  process.exit(1);
}

const url = `http://localhost:${port}`;
const platform = process.platform;

if (platform === "win32") {
  spawn("cmd", ["/c", "start", url], { stdio: "ignore", detached: true }).unref();
} else if (platform === "darwin") {
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
} else {
  spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
}

console.log(`Opened ${url}`);
