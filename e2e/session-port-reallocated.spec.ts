/**
 * Reallocated-on-boot E2E.
 *
 * Verifies the full chain that was previously dead-wired:
 *
 *   1. Electron A boots, creates a session → daemon allocates port P.
 *   2. Electron A quits gracefully (DB persists the session row).
 *   3. We pre-occupy port P with a TCP listener so it's no longer
 *      bindable.
 *   4. Electron B boots with the SAME dataDir + daemonDir → daemon's
 *      `sync.declare` notices the port collision → reallocates → reports
 *      `status: "reallocated"` back.
 *   5. Main process pushes the {sessionId, oldPorts, newPorts} into
 *      `reallocatedQueue`.
 *   6. Renderer's `window.api.bootstrap.reallocated()` returns the
 *      buffered entry. DB.sessions.ports + .env are updated to the
 *      new ports.
 *
 * The interesting bit: this whole loop USED to be no-op because main
 * never called sync.declare on boot.
 */
import {
  test as base,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  const d = join(
    tmpdir(),
    `agentdock-e2e-${label}-${process.hrtime.bigint().toString(36)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

async function launch(args: {
  dataDir: string;
  daemonDir: string;
  userDataDir: string;
}): Promise<ElectronApplication> {
  return electron.launch({
    args: [mainEntry(), `--user-data-dir=${args.userDataDir}`],
    cwd: args.dataDir,
    env: {
      ...process.env,
      AGENTDOCK_DATA_DIR: args.dataDir,
      AGENTDOCK_DAEMON_BASE_DIR: args.daemonDir,
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

function prepareGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -q -b main", { cwd: dir });
  execSync(
    'git -c user.email=e2e@local -c user.name=E2E commit --allow-empty -q -m init',
    { cwd: dir },
  );
}

function writeEmptyConfig(dir: string): void {
  writeFileSync(
    join(dir, "agentdock.config.yaml"),
    `version: "1"\nresources:\n  sync: []\nhooks: {}\n`,
    "utf-8",
  );
}

test("port collision on boot → sync.declare reallocates → bootstrap.reallocated surfaces", async () => {
  const dataDir = tmp("data");
  const daemonDir = tmp("daemon");
  const userDataA = tmp("user-a");
  const userDataB = tmp("user-b");

  const projectPath = join(dataDir, "reallocated-project");
  prepareGitRepo(projectPath);
  writeEmptyConfig(projectPath);

  let appA: ElectronApplication | null = null;
  let appB: ElectronApplication | null = null;
  const blockers: ReturnType<typeof createServer>[] = [];

  try {
    // ── Phase 1: boot A, create project + session ────────────────────
    appA = await launch({ dataDir, daemonDir, userDataDir: userDataA });
    const winA = await readyWindow(appA);

    const project = await winA.evaluate(
      (p: string) =>
        (
          window as unknown as {
            api: {
              db: {
                projects: {
                  create: (n: string, p: string) => Promise<{ id: string; path: string }>;
                };
              };
            };
          }
        ).api.db.projects.create("reallocated", p),
      projectPath,
    );

    // Install the stream wrapper INSIDE the create call (same pattern
    // as helpers/ipc.ts's createSession) so we can await complete.
    const sessionId = (await winA.evaluate(
      (pid: string) => {
        const w = window as unknown as {
          api: {
            sessions: {
              create: (p: unknown) => Promise<{ sessionId: string }>;
              stream: (id: string) => {
                onComplete: (cb: (e: unknown) => void) => () => void;
              };
            };
          };
          __e2eDone?: Record<string, unknown>;
        };
        const store = (w.__e2eDone ??= {});
        return w.api.sessions
          .create({ projectId: pid, name: "s" })
          .then((r) => {
            w.api.sessions.stream(r.sessionId).onComplete((c) => {
              store[r.sessionId] = c;
            });
            return r;
          })
          .then((r) => r.sessionId);
      },
      project.id,
    )) as string;

    await expect
      .poll(
        async () =>
          (await winA.evaluate(
            (id: string) =>
              ((window as unknown as { __e2eDone?: Record<string, unknown> })
                .__e2eDone?.[id] ?? null) as { success?: boolean } | null,
            sessionId,
          )) as { success?: boolean } | null,
        { timeout: 30_000 },
      )
      .toMatchObject({ success: true });

    // Grab the allocated ports from the renderer-side projects.list.
    const projectsBefore = (await winA.evaluate(() =>
      (
        window as unknown as {
          api: { db: { projects: { list: () => Promise<unknown[]> } } };
        }
      ).api.db.projects.list(),
    )) as Array<{
      id: string;
      sessions: Array<{ id: string; ports: Record<string, number> | null }>;
    }>;
    const sessBefore = projectsBefore[0]!.sessions.find((s) => s.id === sessionId);
    expect(sessBefore?.ports, "session has no ports yet").not.toBeNull();
    const oldPorts = sessBefore!.ports!;
    const portValues = Object.values(oldPorts);
    expect(portValues.length).toBeGreaterThan(0);

    // ── Phase 2: quit A ──────────────────────────────────────────────
    await appA.close();
    appA = null;
    // Give the daemon child + lock + WAL flush time to settle.
    await new Promise((r) => setTimeout(r, 1_500));

    // ── Phase 3: occupy the first allocated port ─────────────────────
    // The daemon's reallocate trigger is "isPortAvailable returns false
    // for ANY of the session's ports". Stealing the first one is
    // enough.
    const stolen = portValues[0]!;
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(stolen, "127.0.0.1", () => resolve());
    });
    blockers.push(blocker);

    // ── Phase 4: boot B with same data + daemon dir ──────────────────
    appB = await launch({ dataDir, daemonDir, userDataDir: userDataB });
    const winB = await readyWindow(appB);

    // Give the boot-time reconcileAndDeclareSessions a beat to run.
    await new Promise((r) => setTimeout(r, 1_500));

    // ── Phase 5: bootstrap.reallocated should return our session ─────
    const reallocs = (await winB.evaluate(() =>
      (
        window as unknown as {
          api: {
            bootstrap: {
              reallocated: () => Promise<
                Array<{
                  sessionId: string;
                  oldPorts: Record<string, number>;
                  newPorts: Record<string, number>;
                }>
              >;
            };
          };
        }
      ).api.bootstrap.reallocated(),
    )) as Array<{
      sessionId: string;
      oldPorts: Record<string, number>;
      newPorts: Record<string, number>;
    }>;

    const ours = reallocs.find((r) => r.sessionId === sessionId);
    expect(
      ours,
      `reallocated queue did NOT contain our session — sync.declare reconciliation didn't run, or didn't detect the collision. queue=${JSON.stringify(reallocs)}`,
    ).toBeDefined();
    expect(ours!.oldPorts).toMatchObject(oldPorts);
    // At least the stolen port must have changed.
    expect(ours!.newPorts[Object.keys(oldPorts)[0]!]).not.toBe(stolen);

    // ── Phase 6: DB + .env reflect the new ports ─────────────────────
    const projectsAfter = (await winB.evaluate(() =>
      (
        window as unknown as {
          api: { db: { projects: { list: () => Promise<unknown[]> } } };
        }
      ).api.db.projects.list(),
    )) as Array<{ sessions: Array<{ id: string; ports: Record<string, number> | null }> }>;
    const sessAfter = projectsAfter[0]!.sessions.find((s) => s.id === sessionId);
    expect(sessAfter?.ports).toMatchObject(ours!.newPorts);

    // .env file
    const envPath = join(
      projectPath,
      ".agentdock",
      "worktrees",
      sessionId,
      ".env",
    );
    expect(existsSync(envPath), `.env missing at ${envPath}`).toBe(true);
    const envBody = readFileSync(envPath, "utf-8");
    const firstKey = Object.keys(ours!.newPorts)[0]!;
    expect(envBody).toMatch(
      new RegExp(`^${firstKey}=${ours!.newPorts[firstKey]}\\b`, "m"),
    );
  } finally {
    for (const s of blockers) {
      await new Promise<void>((r) => s.close(() => r()));
    }
    if (appB) await appB.close().catch(() => {});
    if (appA) await appA.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 1_000));
    for (const d of [dataDir, daemonDir, userDataA, userDataB]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  }
});
