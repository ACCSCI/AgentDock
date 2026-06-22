/**
 * Daemon client-lifecycle E2E.
 *
 * Verifies that Electron now:
 *   1. Calls `POST /client/register` on boot.
 *   2. Sends periodic heartbeats (confirmed by /debug/clients heartbeatAge).
 *   3. Calls `POST /client/unregister` on quit.
 *
 * Uses a real daemon process (not a mock) to ensure the full stack works.
 */
import {
  test as base,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const test = base.extend({});

function mainEntry(): string {
  const dir = join(ROOT, "out", "main");
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  return join(dir, files[0]!);
}

function tmp(label: string): string {
  const d = join(tmpdir(), `agentdock-e2e-cl-${label}-${process.hrtime.bigint().toString(36)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

test("client/register on boot, heartbeat ~30s, unregister on quit", async () => {
  const dataDir = tmp("data");
  const userData = tmp("user");
  let app: ElectronApplication | null = null;

  try {
    app = await electron.launch({
      args: [mainEntry(), `--user-data-dir=${userData}`],
      cwd: dataDir,
      env: {
        ...process.env,
        AGENTDOCK_DATA_DIR: dataDir,
        FRONTEND_PORT: "5173",
        AGENTDOCK_USE_BUN: "1",
        ELECTRON_DISABLE_GPU: "1",
        ELECTRON_ENABLE_LOGGING: "1",
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --experimental-sqlite`.trim(),
      },
      timeout: 30_000,
    });

    const win = await app.firstWindow({ timeout: 20_000 });
    await win.waitForLoadState("domcontentloaded");
    await win.waitForFunction(
      () => typeof (window as unknown as { api?: unknown }).api === "object",
      null,
      { timeout: 10_000 },
    );

    // Daemon is at ~/.agentdock/ now — read daemon.json to get the port.
    const daemonJsonPath = join(homedir(), ".agentdock", "daemon.json");
    const daemonJson = JSON.parse(readFileSync(daemonJsonPath, "utf-8")) as { pid: number; port: number };
    const baseUrl = `http://127.0.0.1:${daemonJson.port}`;

    // 1. Verify client registered — match by dataDir in projectPaths.
    const matchesMe = (c: { projectPaths?: string[] }) =>
      c.projectPaths?.some((p) => p === dataDir) ?? false;

    await expect
      .poll(
        async () => {
          const r = await fetch(`${baseUrl}/debug/clients`);
          const j = (await r.json()) as { clients: Array<{ projectPaths: string[] }> };
          return j.clients.some(matchesMe);
        },
        { timeout: 10_000, message: "client never registered" },
      )
      .toBe(true);

    // 2. Verify heartbeat is actually ticking: wait 35s and confirm age < 10s.
    if (process.env.AGENTDOCK_SKIP_SLOW_E2E !== "1") {
      await new Promise((r) => setTimeout(r, 35_000));
      const after = (await fetch(`${baseUrl}/debug/clients`).then((r) => r.json())) as {
        clients: Array<{ projectPaths: string[]; heartbeatAge: number }>;
      };
      const me = after.clients.find(matchesMe);
      expect(me, "client disappeared").toBeDefined();
      expect(me!.heartbeatAge, "heartbeat not ticking").toBeLessThan(10_000);
    }

    // 3. Verify unregister on quit.
    await app.close();
    app = null;
    await new Promise((r) => setTimeout(r, 1_500));

    let daemonReachable = false;
    try {
      const probe = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      daemonReachable = probe.ok;
    } catch { daemonReachable = false; }

    if (daemonReachable) {
      const stillThere = (await fetch(`${baseUrl}/debug/clients`).then((r) => r.json())) as {
        clients: Array<{ projectPaths: string[] }>;
      };
      expect(stillThere.clients.find(matchesMe)).toBeUndefined();
    }
  } finally {
    if (app) await app.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 750));
    for (const d of [dataDir, userData]) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  }
});
