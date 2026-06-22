/**
 * Multi-Electron daemon-reuse E2E.
 *
 * Since daemon.json is now fixed at ~/.agentdock/, multiple Electrons
 * from the same machine automatically share the same daemon. This spec
 * verifies the two-Electron scenario by launching two instances with
 * different data dirs — both discover the same daemon via ~/.agentdock/
 * and register as distinct clients.
 */
import {
  test as base,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const test = base.extend({});

function mainEntry(): string {
  const dir = join(ROOT, "out", "main");
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  return join(dir, files[0]!);
}

function tmp(label: string): string {
  const d = join(tmpdir(), `agentdock-e2e-multi-${label}-${process.hrtime.bigint().toString(36)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

async function launch(args: { dataDir: string; userDataDir: string }): Promise<ElectronApplication> {
  return electron.launch({
    args: [mainEntry(), `--user-data-dir=${args.userDataDir}`],
    cwd: args.dataDir,
    env: {
      ...process.env,
      AGENTDOCK_DATA_DIR: args.dataDir,
      FRONTEND_PORT: "5173",
      AGENTDOCK_USE_BUN: "1",
      ELECTRON_DISABLE_GPU: "1",
      ELECTRON_ENABLE_LOGGING: "1",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --experimental-sqlite`.trim(),
    },
    timeout: 30_000,
  });
}

async function readyWindow(app: ElectronApplication) {
  const w = await app.firstWindow({ timeout: 20_000 });
  await w.waitForLoadState("domcontentloaded");
  await w.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === "object",
    null,
    { timeout: 10_000 },
  );
  return w;
}

test("two Electrons share one daemon via fixed ~/.agentdock/", async () => {
  const dataA = tmp("a-data");
  const dataB = tmp("b-data");
  const userA = tmp("a-user");
  const userB = tmp("b-user");

  let appA: ElectronApplication | null = null;
  let appB: ElectronApplication | null = null;

  try {
    // 1. Boot A → daemon is spawned at ~/.agentdock/ (fixed path).
    appA = await launch({ dataDir: dataA, userDataDir: userA });
    const winA = await readyWindow(appA);
    const healthA = await winA.evaluate(() =>
      (window as unknown as { api: { bootstrap: { health: () => Promise<{ daemon: string }> } } })
        .api.bootstrap.health(),
    );
    expect(healthA.daemon).toBe("ok");

    const daemonJsonPath = join(process.env.HOME ?? process.env.USERPROFILE ?? tmpdir(), ".agentdock", "daemon.json");
    const daemonJson = JSON.parse(readFileSync(daemonJsonPath, "utf-8")) as { pid: number; port: number };
    const baseUrl = `http://127.0.0.1:${daemonJson.port}`;

    // 2. Boot B → discovers same daemon, registers as separate client.
    appB = await launch({ dataDir: dataB, userDataDir: userB });
    const winB = await readyWindow(appB);
    const healthB = await winB.evaluate(() =>
      (window as unknown as { api: { bootstrap: { health: () => Promise<{ daemon: string }> } } })
        .api.bootstrap.health(),
    );
    expect(healthB.daemon).toBe("ok");

    // 3. daemon.json still points at A's daemon — B didn't spawn a new one.
    const infoAfterB = JSON.parse(readFileSync(daemonJsonPath, "utf-8")) as { pid: number; port: number };
    expect(infoAfterB.pid).toBe(daemonJson.pid);
    expect(infoAfterB.port).toBe(daemonJson.port);

    // 4. Both clients registered.
    const matchesA = (c: { projectPaths?: string[] }) =>
      c.projectPaths?.some((p) => p === dataA) ?? false;
    const matchesB = (c: { projectPaths?: string[] }) =>
      c.projectPaths?.some((p) => p === dataB) ?? false;
    const clientsRes = (await fetch(`${baseUrl}/debug/clients`).then((r) => r.json())) as {
      clients: Array<{ projectPaths: string[]; clientId: string }>;
    };
    expect(clientsRes.clients.some(matchesA), "client A not registered").toBe(true);
    expect(clientsRes.clients.some(matchesB), "client B not registered").toBe(true);

    // 5. Different clientIds (different data dirs → different cwds → different hashes).
    const clientA = clientsRes.clients.find(matchesA)!;
    const clientB = clientsRes.clients.find(matchesB)!;
    expect(clientA.clientId).not.toBe(clientB.clientId);

    // 6. Close B → A still works.
    await appB.close();
    appB = null;
    await new Promise((r) => setTimeout(r, 500));
    const healthAStill = await winA.evaluate(() =>
      (window as unknown as { api: { bootstrap: { health: () => Promise<{ daemon: string }> } } })
        .api.bootstrap.health(),
    );
    expect(healthAStill.daemon).toBe("ok");

    // 7. B's client removed from registry.
    const clientsAfter = (await fetch(`${baseUrl}/debug/clients`).then((r) => r.json())) as {
      clients: Array<{ projectPaths: string[] }>;
    };
    expect(clientsAfter.clients.some(matchesB)).toBe(false);
  } finally {
    if (appB) await appB.close().catch(() => {});
    if (appA) await appA.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 750));
    for (const d of [dataA, dataB, userA, userB]) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  }
});
