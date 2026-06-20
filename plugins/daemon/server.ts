/**
 * AgentDockDaemon — backward-compatible wrapper around the Hono app.
 *
 * Phase 1: keeps the same public surface (`new AgentDockDaemon(opts)`,
 * `.start()`, `.stop()`, `.getPort()`) so the 8 existing daemon test files
 * that import from `plugins/daemon.js` continue to work without changes.
 *
 * Internally:
 *   - constructs a DaemonContext (state, wal, allocator, mutex, registry)
 *   - builds a Hono app via createApp(ctx)
 *   - serves it via @hono/node-server on 127.0.0.1
 *   - schedules a heartbeat timer for stale-client cleanup
 *   - schedules a RECOVERING → READY tick (新架构 §5.2)
 *   - handles EADDRINUSE by retrying on a random port (matches old behavior)
 *
 * The class doesn't own route logic — that's all in plugins/daemon/routes/*.ts.
 */
import { serve, type ServerType } from "@hono/node-server";
import { writeDaemonInfo, deleteDaemonInfo } from "../daemon-discovery.js";
import { log } from "../logger.js";
import { createApp } from "./app.js";
import {
  cleanupStaleClients,
  HEARTBEAT_CHECK_INTERVAL_MS,
  makeContext,
  type DaemonContext,
  type DaemonOptions,
} from "./context.js";
import {
  createRecoveringController,
  RECOVERING_TICK_INTERVAL_MS,
} from "../recovering-controller.js";

export class AgentDockDaemon {
  private ctx: DaemonContext;
  private server: ServerType | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private recoveringTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DaemonOptions = {}) {
    this.ctx = makeContext(options);
  }

  /**
   * Start listening on 127.0.0.1. Resolves once the server has a bound port.
   *
   * If the configured port (or restored port from WAL) is in use, falls back
   * to OS-assigned random port (matches old AgentDockDaemon.start behavior).
   */
  async start(): Promise<void> {
    const app = createApp(this.ctx);

    return new Promise<void>((resolve, reject) => {
      let firstError: Error | null = null;

      const onListen = () => {
        const addr = this.server!.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : this.ctx.port;
        this.ctx.actualPort = actualPort;
        this.ctx.state.setDaemonPort(actualPort);
        this.ctx.wal.persist(this.ctx.state);
        // v2 mirror — keep daemonPort and lifecycle state in sync with v1
        // on first listen. v2 routes persist on their own mutations.
        this.ctx.stateV2.setDaemonPort(actualPort);
        this.ctx.walV2.persist(this.ctx.stateV2);

        try {
          writeDaemonInfo(process.pid, actualPort);
        } catch (err) {
          log.warn({ err }, "failed to write daemon.json (non-fatal)");
        }

        this.heartbeatTimer = setInterval(() => {
          cleanupStaleClients(this.ctx).catch((err) => {
            log.warn({ err }, "stale-client cleanup failed");
          });
        }, HEARTBEAT_CHECK_INTERVAL_MS);

        // 新架构 §5.2 — RECOVERING → READY state machine tick.
        // Uses the v2 sessionIds set as the "expected" count. For a fresh
        // install (empty state), expected=0 and softMin triggers early exit.
        const expected = new Set(this.ctx.stateV2.listSessions().map((s) => s.sessionId));
        const recovering = createRecoveringController(this.ctx.stateV2, {
          expectedSessionIds: expected,
          onTransition: (next, reason) => {
            log.info({ state: next, reason }, "lifecycle state transition");
            this.ctx.walV2.persist(this.ctx.stateV2);
          },
        });
        this.recoveringTimer = setInterval(() => {
          recovering.tick();
        }, RECOVERING_TICK_INTERVAL_MS);
        // Tick once immediately so empty installs exit RECOVERING fast.
        recovering.tick();

        log.info({ port: actualPort }, "daemon listening");
        resolve();
      };

      const tryListen = (port: number) => {
        try {
          this.server = serve(
            {
              fetch: app.fetch,
              port,
              hostname: "127.0.0.1",
              createServer: undefined as never, // @hono/node-server picks http.Server
            },
            onListen,
          );
          this.server.on("error", (err: NodeJS.ErrnoException) => {
            // EADDRINUSE on a non-zero port → fall back to random.
            if (err.code === "EADDRINUSE" && port !== 0 && !firstError) {
              firstError = err;
              log.warn({ port }, "port in use, retrying with random port");
              this.ctx.port = 0;
              tryListen(0);
              return;
            }
            reject(firstError ?? err);
          });
        } catch (err) {
          reject(err as Error);
        }
      };

      tryListen(this.ctx.port);
    });
  }

  /**
   * Stop the daemon gracefully: clear heartbeat timer, close the server,
   * delete the discovery file.
   */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.recoveringTimer) {
      clearInterval(this.recoveringTimer);
      this.recoveringTimer = null;
    }
    if (!this.server) {
      try {
        deleteDaemonInfo();
      } catch {
        /* ignore */
      }
      return;
    }
    return new Promise<void>((resolve) => {
      this.server!.close(() => {
        try {
          deleteDaemonInfo();
        } catch {
          /* ignore */
        }
        resolve();
      });
    });
  }

  /**
   * The actual port the server is bound to. Useful when port=0 was used
   * and the OS assigned one. Returns 0 before start() resolves.
   */
  getPort(): number {
    if (this.server) {
      const addr = this.server.address();
      if (typeof addr === "object" && addr) return addr.port;
    }
    return this.ctx.actualPort;
  }
}

/**
 * CLI entry point — invoked when this module is run as `bun plugins/daemon.ts`.
 * Spawning via plugins/daemon-manager.ts still works because plugins/daemon.ts
 * re-exports AgentDockDaemon and a thin `runDaemon()` helper.
 */
export async function runDaemon(options: DaemonOptions = {}): Promise<AgentDockDaemon> {
  const envPort = process.env.AGENTDOCK_DAEMON_PORT
    ? Number(process.env.AGENTDOCK_DAEMON_PORT)
    : 0;
  const port = options.port ?? envPort;
  const daemon = new AgentDockDaemon({ ...options, port });
  await daemon.start();
  return daemon;
}

// Auto-start when invoked as the main module.
// (matches the original plugins/daemon.ts:1005-1016 behavior)
if (
  process.argv[1] &&
  (process.argv[1].endsWith("daemon.ts") || process.argv[1].endsWith("daemon.js"))
) {
  runDaemon()
    .then((daemon) => {
      console.log(`[daemon] listening on http://127.0.0.1:${daemon.getPort()}`);
    })
    .catch((err) => {
      console.error("[daemon] failed to start:", err);
      process.exit(1);
    });
}