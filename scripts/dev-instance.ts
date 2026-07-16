#!/usr/bin/env node
/** Launch an isolated single-process Electron development instance. */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "../plugins/env.js";

const instance = Number.parseInt(process.argv[2] ?? "", 10);
if (!Number.isFinite(instance) || instance < 1) {
  console.error("usage: bun run scripts/dev-instance.ts <N> [-- <extra args>]");
  process.exit(1);
}

const separatorIndex = process.argv.indexOf("--");
const extraArgs = separatorIndex >= 0 ? process.argv.slice(separatorIndex + 1) : [];
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const userDataDir = join(projectRoot, ".agentdock-dev", `instance${instance}`);
const workspaceEnv = readEnvFile(join(projectRoot, ".env"));
const configuredBasePort = Number.parseInt(
  process.env.AGENTDOCK_DEV_FRONTEND_BASE_PORT ?? workspaceEnv.FRONTEND_PORT ?? "5200",
  10,
);
const basePort =
  Number.isInteger(configuredBasePort) && configuredBasePort > 0 ? configuredBasePort : 5200;
const frontendPort = basePort + instance;

mkdirSync(userDataDir, { recursive: true });
console.log(`[dev-instance ${instance}]`);
console.log(`  userDataDir  = ${userDataDir}`);
console.log(`  frontendPort = ${frontendPort}`);
console.log(`  forwarding   = electron-vite dev ${extraArgs.join(" ") || "(no extra args)"}`);

const child = spawn(process.execPath, ["x", "electron-vite", "dev", ...extraArgs], {
  cwd: projectRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    FRONTEND_PORT: String(frontendPort),
    AGENTDOCK_USER_DATA_DIR: userDataDir,
    AGENTDOCK_DEV_INSTANCE: String(instance),
  },
});

child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
  console.error(`[dev-instance ${instance}] spawn failed:`, error);
  process.exit(1);
});
