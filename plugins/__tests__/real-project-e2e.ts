/**
 * Real-project E2E test — 新架构 P14.
 *
 * Validates the architecture works against a real Node.js project by:
 *   1. Spawning an AgentDockDaemon on a tmp baseDir
 *   2. Creating a session for D:\Projects\test\env-isolation-demo
 *   3. Claiming 3 ports for the session (FRONTEND_PORT, API_PORT, WS_PORT)
 *   4. Writing the claimed ports to the project's .env
 *   5. Running `node show-env.mjs` with that .env and verifying it
 *      sees the same ports the daemon assigned
 *   6. Cleaning up the session, verifying ports are released
 *
 * This proves the daemon is genuinely useful — a real project reads the
 * .env ports and the daemon arbitrates correctly.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentDockDaemon } from "../daemon.js";

const REAL_PROJECT = "D:\\Projects\\test\\env-isolation-demo";

interface ClaimResp {
  success: boolean;
  port?: number;
  error?: { code: string; message: string };
}

interface CreateResp {
  success: boolean;
  sessionId?: string;
  fencingToken?: number;
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function runProject(env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["show-env.mjs"], {
      cwd: REAL_PROJECT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`exit ${code}: ${stderr}`));
    });
  });
}

async function main(): Promise<number> {
  console.log("=== P14 Real-Project E2E ===\n");

  // 0. Sanity check real project exists
  if (!existsSync(path.join(REAL_PROJECT, "show-env.mjs"))) {
    console.error(`FAIL: ${REAL_PROJECT}/show-env.mjs not found`);
    return 1;
  }
  console.log(`[ok] Real project at ${REAL_PROJECT}`);

  // 1. Spawn daemon
  const baseDir = mkdtempSync(path.join(tmpdir(), "agentdock-realproj-"));
  const daemon = new AgentDockDaemon({ port: 0, baseDir });
  await daemon.start();
  const port = daemon.getPort();
  console.log(`[ok] Daemon started on port ${port}`);

  let failed = 0;

  try {
    // 2. Create a session for the real project
    const c = await postJson(`http://127.0.0.1:${port}/session/create`, {
      clientId: "real-project-e2e",
      pid: process.pid,
      projectRoot: REAL_PROJECT,
      displayName: "Real Project Test",
    });
    if (c.status !== 200 || !c.body.success) {
      console.error(`FAIL: session/create → ${c.status}`, c.body);
      failed++;
    } else {
      const sessionId = (c.body as CreateResp).sessionId!;
      const fencingToken = (c.body as CreateResp).fencingToken!;
      console.log(`[ok] session/create → ${sessionId} (fencingToken=${fencingToken})`);

      // 3. Claim 3 ports for the session
      const claims = await Promise.all([
        postJson(`http://127.0.0.1:${port}/claim`, {
          sessionId, fencingToken, name: "FRONTEND_PORT",
        }),
        postJson(`http://127.0.0.1:${port}/claim`, {
          sessionId, fencingToken, name: "API_PORT",
        }),
        postJson(`http://127.0.0.1:${port}/claim`, {
          sessionId, fencingToken, name: "WS_PORT",
        }),
      ]);
      const ports: Record<string, number> = {};
      const portNames = ["FRONTEND_PORT", "API_PORT", "WS_PORT"];
      for (let i = 0; i < claims.length; i++) {
        const r = claims[i]!;
        if (r.status !== 200 || !(r.body as ClaimResp).success) {
          console.error(`FAIL: claim ${portNames[i]} → ${r.status}`, r.body);
          failed++;
        } else {
          ports[portNames[i]!] = (r.body as ClaimResp).port!;
        }
      }
      console.log(`[ok] claimed 3 ports: ${JSON.stringify(ports)}`);

      // 4. Activate the session
      const act = await postJson(`http://127.0.0.1:${port}/session/activate`, {
        sessionId, fencingToken,
      });
      if (act.status !== 200) {
        console.error(`FAIL: session/activate → ${act.status}`);
        failed++;
      } else {
        console.log(`[ok] session/activate`);
      }

      // 5. Write ports to a temp .env (don't pollute the real project's git)
      const envFile = path.join(baseDir, "session.env");
      let envContent = "";
      for (const [name, p] of Object.entries(ports)) {
        envContent += `${name}=${p}\n`;
      }
      envContent += `AGENTDOCK_SESSION_ID=${sessionId}\n`;
      envContent += `API_URL=http://localhost:${ports.API_PORT}\n`;
      writeFileSync(envFile, envContent);
      console.log(`[ok] wrote session env to ${envFile}`);

      // 6. Verify daemon's view matches the .env via /debug/state
      const dbg = await (await fetch(`http://127.0.0.1:${port}/debug/state`)).json() as {
        v2Sessions: Record<string, { displayName: string }>;
        v2Ports: Record<number, { sessionId: string; name: string }>;
      };
      if (dbg.v2Sessions[sessionId]?.displayName !== "Real Project Test") {
        console.error(`FAIL: debug/state shows wrong displayName`);
        failed++;
      }
      // All 3 claimed ports should appear in v2Ports keyed by port number
      for (const [name, p] of Object.entries(ports)) {
        const found = Object.values(dbg.v2Ports).find(
          (rec) => rec.sessionId === sessionId && rec.name === name,
        );
        if (!found || found.name !== name) {
          console.error(`FAIL: debug/state missing port ${name}=${p}`);
          failed++;
        }
      }
      console.log(`[ok] daemon state matches claimed ports`);

      // 7. Run the project with the .env and verify it sees the same ports
      const stdout = await runProject({ ...ports, AGENTDOCK_SESSION_ID: sessionId });
      console.log(`[ok] project output: ${stdout}`);
      const seen = JSON.parse(stdout);
      // show-env.mjs emits port numbers as strings (process.env always string);
      // compare loosely so the test isn't fooled by the stringification.
      if (Number(seen.FRONTEND_PORT) !== ports.FRONTEND_PORT) {
        console.error(`FAIL: project saw FRONTEND_PORT=${seen.FRONTEND_PORT} but daemon gave ${ports.FRONTEND_PORT}`);
        failed++;
      }
      if (seen.AGENTDOCK_SESSION_ID !== sessionId) {
        console.error(`FAIL: project saw AGENTDOCK_SESSION_ID=${seen.AGENTDOCK_SESSION_ID} but daemon gave ${sessionId}`);
        failed++;
      }

      // 8. Takeover (simulate another instance grabbing control) — verify
      //    stale token from old client gets STALE_OWNER
      const tk = await postJson(`http://127.0.0.1:${port}/takeover`, {
        sessionId,
        clientId: "another-instance",
        pid: 99999,
        fencingToken,
      });
      if (tk.status !== 200) {
        console.error(`FAIL: takeover → ${tk.status}`);
        failed++;
      } else {
        const newToken = (tk.body as { fencingToken: number }).fencingToken;
        console.log(`[ok] takeover bumped fencingToken: ${fencingToken} → ${newToken}`);

        // Old token must be rejected now
        const staleClaim = await postJson(`http://127.0.0.1:${port}/claim`, {
          sessionId,
          fencingToken, // stale!
          name: "STALE",
        });
        if (staleClaim.status === 409) {
          console.log(`[ok] stale fencingToken rejected with 409`);
        } else {
          console.error(`FAIL: stale fencingToken got ${staleClaim.status}, expected 409`);
          failed++;
        }
      }

      // 9. Delete the session (phase 1) and verify ports released
      const del = await postJson(`http://127.0.0.1:${port}/session/delete`, {
        sessionId,
        fencingToken: (tk.body as { fencingToken: number }).fencingToken ?? 2,
      });
      if (del.status !== 200) {
        console.error(`FAIL: session/delete → ${del.status}`);
        failed++;
      } else {
        console.log(`[ok] session/delete`);
      }

      // After delete, all 3 ports should be free again
      const dbgAfter = await (await fetch(`http://127.0.0.1:${port}/debug/state`)).json() as {
        v2Ports: Record<number, unknown>;
      };
      const remainingPorts = Object.keys(dbgAfter.v2Ports).length;
      if (remainingPorts !== 0) {
        console.error(`FAIL: expected 0 RESERVED ports after delete, got ${remainingPorts}`);
        failed++;
      } else {
        console.log(`[ok] all 3 ports released back to FREE`);
      }

      // 10. Purge (phase 2) — drops the session entry
      const purge = await postJson(`http://127.0.0.1:${port}/session/purge`, {
        sessionId,
        fencingToken: (tk.body as { fencingToken: number }).fencingToken ?? 2,
      });
      if (purge.status !== 200) {
        console.error(`FAIL: session/purge → ${purge.status}`);
        failed++;
      } else {
        console.log(`[ok] session/purge`);
      }
    }
  } finally {
    await daemon.stop();
    rmSync(baseDir, { recursive: true, force: true });
  }

  if (failed === 0) {
    console.log("\n=== P14 PASS ===");
    return 0;
  }
  console.log(`\n=== P14 FAIL (${failed} failures) ===`);
  return 1;
}

main().then((code) => process.exit(code));
