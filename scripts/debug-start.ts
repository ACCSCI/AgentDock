// @ts-nocheck
/**
 * debug-start.ts — spawn Electron exactly like `bun run start` would,
 * but pipe every byte of stdout/stderr to THIS process's console so we
 * can SEE the actual error when the app fails (e.g. EPIPE).
 *
 * Usage: bun run scripts/debug-start.ts
 *
 * Why this exists: when Electron's main process throws an uncaught
 * exception, it pops up a native error dialog AND tries to forward the
 * error to the renderer console. In a headless / sandboxed test
 * environment the renderer is dead, so the forward fails with EPIPE —
 * but the underlying error is still real, just hidden behind the EPIPE
 * noise. This script prints EVERY line so we see the real error.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const dataDir = process.env.AGENTDOCK_DATA_DIR ?? resolve(ROOT, "out/.tmp-debug-data");
process.env.AGENTDOCK_DATA_DIR = dataDir;
process.env.AGENTDOCK_USE_BUN = "1";
process.env.AGENTDOCK_ELECTRON = "1";

const mainEntry = resolve(ROOT, "out/main/main.js");
if (!existsSync(mainEntry)) {
  console.error(`[debug-start] no built main at ${mainEntry}. Run: bunx electron-vite build`);
  process.exit(1);
}

console.log(`[debug-start] AGENTDOCK_DATA_DIR = ${dataDir}`);
console.log(`[debug-start] launching Electron: ${process.execPath} ${mainEntry}`);

// Use the Electron binary (not bun) so the main process runs as Electron.
import { execSync } from "node:child_process";
let electronBin: string;
try {
  electronBin = execSync(
    "node -e \"console.log(require('electron'))\"",
    { encoding: "utf-8" },
  ).trim();
} catch {
  electronBin = "node_modules/electron/dist/electron.exe";
}
console.log(`[debug-start] electron binary: ${electronBin}`);

const proc = spawn(electronBin, [mainEntry], {
  env: { ...process.env, AGENTDOCK_ELECTRON: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdoutBuf = "";
let stderrBuf = "";

proc.stdout.on("data", (chunk: Buffer) => {
  const s = chunk.toString();
  stdoutBuf += s;
  process.stdout.write(`[main:out] ${s}`);
});
proc.stderr.on("data", (chunk: Buffer) => {
  const s = chunk.toString();
  stderrBuf += s;
  process.stderr.write(`[main:err] ${s}`);
});

proc.on("error", (err) => {
  console.error(`[debug-start] spawn error: ${err.message}`);
});

proc.on("exit", (code) => {
  console.log(`\n[debug-start] Electron exited with code ${code}`);
  if (stdoutBuf) console.log(`\n[debug-start] STDOUT length: ${stdoutBuf.length}`);
  if (stderrBuf) console.log(`[debug-start] STDERR length: ${stderrBuf.length}`);
  // Check daemon.json
  try {
    const info = JSON.parse(readFileSync(resolve(dataDir, "daemon.json"), "utf-8"));
    console.log(`[debug-start] daemon.json: ${JSON.stringify(info)}`);
  } catch {
    console.log(`[debug-start] no daemon.json written`);
  }
  process.exit(code ?? 0);
});

// Run for 10s, then kill — enough to see startup + first IPC round-trip
setTimeout(() => {
  console.log(`\n[debug-start] timeout reached, killing Electron`);
  proc.kill("SIGTERM");
}, 10_000);
