#!/usr/bin/env node
/**
 * dev-instance <N> [-- <extra args...>]
 *
 * Launch an isolated Electron dev instance with a per-instance userData
 * directory so that multiple AgentDock instances do not collide on the
 * same SQLite file (projects.db).
 *
 * electron-vite dev does NOT support --user-data-dir passthrough, so we
 * use a different mechanism:
 *   1. Set AGENTDOCK_USER_DATA_DIR=<userDataDir> so electron/main.ts
 *      calls app.setPath('userData') at boot (before app.whenReady()).
 *   2. Set AGENTDOCK_DEV_INSTANCE=<N> so the openGlobalDb() caller
 *      routes projects.db into <userData>/global/projects.db.
 *   3. Set AGENTDOCK_DAEMON_URL so the instance connects to the shared
 *      external daemon instead of spawning its own.
 *
 * Usage (package.json):
 *   "dev:1": "cross-env NODE_OPTIONS=--experimental-sqlite node scripts/dev-instance.js 1"
 *   "dev:2": "cross-env NODE_OPTIONS=--experimental-sqlite node scripts/dev-instance.js 2"
 *
 * Environment:
 *   AGENTDOCK_DAEMON_PORT  — shared daemon port (default: 41001)
 *   AGENTDOCK_DAEMON_HOST  — shared daemon host (default: 127.0.0.1)
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const N = parseInt(process.argv[2] ?? "1", 10);
if (!Number.isFinite(N) || N < 1) {
  console.error("usage: node scripts/dev-instance.js <N> [-- <extra args>]");
  process.exit(1);
}

// Find "--" separator — everything after is forwarded to electron-vite dev
const sepIdx = process.argv.indexOf("--");
const extraArgs = sepIdx >= 0 ? process.argv.slice(sepIdx + 1) : [];

const projectRoot = resolve(import.meta.dirname ?? __dirname, "..");
const userDataDir = join(projectRoot, ".agentdock-dev", `instance${N}`);
mkdirSync(userDataDir, { recursive: true });

const daemonPort = process.env.AGENTDOCK_DAEMON_PORT ?? "41001";
const daemonHost = process.env.AGENTDOCK_DAEMON_HOST ?? "127.0.0.1";
const daemonUrl = `http://${daemonHost}:${daemonPort}`;

console.log(`[dev-instance ${N}]`);
console.log(`  userDataDir  = ${userDataDir}`);
console.log(`  daemonUrl    = ${daemonUrl}`);
console.log(`  forwarding   = electron-vite dev ${extraArgs.join(" ") || "(no extra args)"}`);

// electron-vite dev spawns Electron itself; we can't pass --user-data-dir to
// it. Instead, we set AGENTDOCK_USER_DATA_DIR which electron/main.ts reads
// at the very top (before app.whenReady()) and calls app.setPath('userData').
const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "electron-vite",
    "dev",
    ...extraArgs,
  ],
  {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      AGENTDOCK_USER_DATA_DIR: userDataDir,
      AGENTDOCK_DEV_INSTANCE: String(N),
      AGENTDOCK_DAEMON_URL: daemonUrl,
    },
  },
);

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  console.error(`[dev-instance ${N}] spawn failed:`, err);
  process.exit(1);
});
