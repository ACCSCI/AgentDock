/**
 * Test Daemon — spawns the Hono daemon in a child process for acceptance tests.
 *
 * Uses Node's child_process.spawn (not Bun's spawn) so the helper works
 * under vitest's Node environment. Phase 1 acceptance uses this to verify
 * `GET /health` etc. against a real daemon process.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface TestDaemon {
  url: string;
  port: number;
  proc: ChildProcess;
  kill: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function spawnTestDaemon(): Promise<TestDaemon> {
  const testDataDir = join(
    tmpdir(),
    `agentdock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDataDir, { recursive: true });

  const proc = spawn(
    "bun",
    ["run", "plugins/daemon.ts"],
    {
      env: {
        ...process.env,
        AGENTDOCK_DAEMON_PORT: "0",
        AGENTDOCK_DATA_DIR: testDataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // Wait for daemon.json (max 10s)
  const infoPath = join(testDataDir, "daemon.json");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(infoPath)) break;
    await sleep(100);
  }
  if (!existsSync(infoPath)) {
    proc.kill();
    throw new Error("Test daemon failed to write daemon.json within 10s");
  }

  const info = JSON.parse(readFileSync(infoPath, "utf-8"));
  const url = `http://127.0.0.1:${info.port}`;

  // Health check (max 5s)
  const healthDeadline = Date.now() + 5_000;
  while (Date.now() < healthDeadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        return {
          url,
          port: info.port,
          proc,
          kill: () => {
            proc.kill();
            try {
              rmSync(testDataDir, { recursive: true, force: true });
            } catch {
              // best-effort
            }
          },
        };
      }
    } catch {
      // daemon still starting
    }
    await sleep(100);
  }

  proc.kill();
  throw new Error(`Test daemon failed health check at ${url}`);
}