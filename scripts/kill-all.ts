/**
 * Kill all AgentDock instances (Vite dev servers) and the daemon process.
 *
 * Usage: bun run scripts/kill-all.ts
 *    or: npx tsx scripts/kill-all.ts
 *
 * What it does:
 *  1. Read ~/.agentdock/registry.json → kill all registered PIDs
 *  2. Find node/bun processes running vite with AgentDock paths → kill them
 *  3. Find daemon process on port 20000 → kill it
 *  4. Clean up registry.json and daemon-state.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import os from "node:os";

const AGENTDOCK_DIR = join(os.homedir(), ".agentdock");
const REGISTRY_PATH = join(AGENTDOCK_DIR, "registry.json");
const DAEMON_STATE_PATH = join(AGENTDOCK_DIR, "daemon-state.json");
const DAEMON_PORT = 20000;

function log(msg: string) {
  console.log(`[kill-all] ${msg}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: "utf-8", timeout: 5000 });
      return out.includes(String(pid));
    } else {
      process.kill(pid, 0);
      return true;
    }
  } catch {
    return false;
  }
}

function killPid(pid: number, label: string): boolean {
  if (!isProcessAlive(pid)) {
    log(`  ${label} (PID ${pid}) — already dead, skipping`);
    return false;
  }
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid} /F /T`, { timeout: 5000, stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
    log(`  ${label} (PID ${pid}) — killed ✓`);
    return true;
  } catch {
    log(`  ${label} (PID ${pid}) — failed to kill`);
    return false;
  }
}

function findDaemonPid(): number | null {
  try {
    if (process.platform === "win32") {
      const out = execSync(`netstat -ano | findstr :${DAEMON_PORT} | findstr LISTENING`, {
        encoding: "utf-8", timeout: 5000,
      });
      const match = out.trim().match(/\s(\d+)\s*$/);
      return match ? parseInt(match[1], 10) : null;
    } else {
      const out = execSync(`lsof -i :${DAEMON_PORT} -t`, { encoding: "utf-8", timeout: 5000 });
      const pid = parseInt(out.trim().split("\n")[0], 10);
      return isNaN(pid) ? null : pid;
    }
  } catch {
    return null;
  }
}

/**
 * Find all node/bun processes whose command line contains "vite" or "agentdock"
 * (excluding this script itself).
 */
function findVitePids(): number[] {
  const selfPid = process.pid;
  const pids: number[] = [];
  try {
    if (process.platform === "win32") {
      // wmic returns CommandLine + ProcessId for all node/bun processes
      const out = execSync(
        `wmic process where "(Name='node.exe' or Name='bun.exe') and CommandLine like '%vite%' and ProcessId!=${selfPid}" get ProcessId,CommandLine /FORMAT:CSV`,
        { encoding: "utf-8", timeout: 10000 },
      );
      for (const line of out.split("\n")) {
        const match = line.match(/,(\d+)\s*$/);
        if (match) pids.push(parseInt(match[1], 10));
      }
    } else {
      const out = execSync(
        `ps -eo pid,args | grep -E 'vite|agentdock' | grep -v grep | grep -v ${selfPid}`,
        { encoding: "utf-8", timeout: 5000 },
      );
      for (const line of out.split("\n")) {
        const match = line.trim().match(/^(\d+)/);
        if (match) pids.push(parseInt(match[1], 10));
      }
    }
  } catch {
    // wmic/grep returns non-zero if no matches — that's fine
  }
  return [...new Set(pids)]; // dedupe
}

// --- Main ---

log("Stopping all AgentDock processes...");
log("");

let killed = 0;
const seenPids = new Set<number>();

// 1. Kill registered instances from registry
if (existsSync(REGISTRY_PATH)) {
  try {
    const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
    const entries = Object.entries(registry) as Array<[string, { pid: number }]>;
    log(`Registry: ${entries.length} entries`);
    for (const [dir, entry] of entries) {
      const label = dir.split(/[\\/]/).pop() ?? dir;
      if (!seenPids.has(entry.pid)) {
        seenPids.add(entry.pid);
        if (killPid(entry.pid, label)) killed++;
      }
    }
  } catch (err) {
    log(`Failed to read registry: ${err instanceof Error ? err.message : err}`);
  }
} else {
  log("Registry: not found");
}

// 2. Find and kill any remaining vite/agentdock node processes
const vitePids = findVitePids();
if (vitePids.length > 0) {
  log(`Vite processes: ${vitePids.length} found`);
  for (const pid of vitePids) {
    if (!seenPids.has(pid)) {
      seenPids.add(pid);
      if (killPid(pid, "vite")) killed++;
    }
  }
} else {
  log("Vite processes: none found");
}

// 3. Kill daemon
const daemonPid = findDaemonPid();
if (daemonPid) {
  if (!seenPids.has(daemonPid)) {
    seenPids.add(daemonPid);
    if (killPid(daemonPid, "daemon")) killed++;
  }
} else {
  log("Daemon: not found on port " + DAEMON_PORT);
}

// 4. Clean up state files
log("");
log("Cleaning up state files...");
if (existsSync(REGISTRY_PATH)) {
  writeFileSync(REGISTRY_PATH, "{}", "utf-8");
  log("  registry.json — cleared");
}
if (existsSync(DAEMON_STATE_PATH)) {
  writeFileSync(DAEMON_STATE_PATH, "{}", "utf-8");
  log("  daemon-state.json — cleared");
}

log("");
log(`Done. Killed ${killed} process(es).`);
