// @ts-nocheck
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
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
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
import {
  createReconciler,
  RECONCILER_TUNING,
  type Reconciler,
  type WorktreeDirEntry,
} from "../reconciler.js";

export class AgentDockDaemon {
  private ctx: DaemonContext;
  private server: ServerType | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private recoveringTimer: ReturnType<typeof setInterval> | null = null;
  private reconcilerTimer: ReturnType<typeof setInterval> | null = null;
  private reconciler: Reconciler | null = null;

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
          // daemon.json is the contract between the daemon and the
          // DaemonManager — without it, the manager can't find this
          // daemon and will treat it as a failed spawn. Earlier we
          // logged-and-continued, but that left a zombie process: the
          // server kept serving /health, the manager's waitForReady
          // returned early on the health check, and then readDaemonInfo
          // returned null → "Daemon started but did not write
          // daemon.json" → app.exit(1). This is the root cause of
          // E2E flakes (session-lifecycle, session-orphan-ui,
          // session-terminal-typing) under load, where the tmpfile
          // rename can fail intermittently on Windows. Exiting here
          // lets the manager retry cleanly on a new port.
          log.error({ err }, "failed to write daemon.json — exiting so the manager can retry");
          process.exit(1);
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
          // Tests can opt out of the RECOVERING soft-min wait by passing
          // `recoveringSoftMinMs: 0` via DaemonOptions (production stays at
          // RECOVERING_SOFT_MIN_MS = 2s).
          softMinMs: this.ctx.recoveringSoftMinMs,
          onTransition: (next, reason) => {
            log.info({ state: next, reason }, "lifecycle state transition");
            this.ctx.walV2.persist(this.ctx.stateV2);
            // P8: when transitioning to READY, mark grace window start so
            // the reconciler gives each in-flight session a full LEASE_TTL
            // to renew before judging abandoned (§4.4 末段).
            if (next === "READY") {
              this.reconciler?.setReady(Date.now());
            }
          },
        });
        // §5.2 — 把 RECOVERING 闸门 + expected 集合暴露给 v2 routes (/claim,
        // /session/*) 以执行 "RECOVERING 期只放行恢复性 claim" 判定.
        this.ctx.recovering = recovering;
        this.ctx.expectedSessionIds = expected;
        this.ctx.alreadyReportedThisWindow = new Set<string>();
        this.recoveringTimer = setInterval(() => {
          recovering.tick();
        }, RECOVERING_TICK_INTERVAL_MS);
        // Tick once immediately so empty installs exit RECOVERING fast.
        recovering.tick();

        // P8: 三表对账 (C1-C5 残缺态分类, 新架构 §4.3).
        // Tick every RECOVERING_HARD_MAX/2 = 7.5s. The reconciler
        // self-skips during RECOVERING and during the LEASE_TTL grace
        // window after entering READY (§4.4 末段).
        this.reconciler = createReconciler({
          stateV2: this.ctx.stateV2,
          getOwnerLastHeartbeat: (clientId: string) => {
            // v1 state carries the per-client lastHeartbeat.
            const c = this.ctx.state.getClient(clientId);
            return c?.lastHeartbeat ?? null;
          },
          isProcessAlive: (pid: number) => this.ctx.isProcessAlive(pid),
          // §4.3 C4: 扫 .agentdock/worktrees/* 找 DB 无记录者.
          // 永不自动删, 仅 emit C4-orphan-dir 由 UI 决定 (§4.3 原则).
          scanWorktreeDirs: (projectRoot: string): WorktreeDirEntry[] => {
            const wtDir = path.join(projectRoot, ".agentdock", "worktrees");
            try {
              const entries = readdirSync(wtDir, { withFileTypes: true });
              const out: WorktreeDirEntry[] = [];
              for (const e of entries) {
                if (!e.isDirectory()) continue;
                const wt = path.join(wtDir, e.name);
                try {
                  // 必须是目录 (非 symlink 悬挂)
                  const st = statSync(wt);
                  if (!st.isDirectory()) continue;
                } catch {
                  continue;
                }
                out.push({
                  sessionIdGuess: e.name,
                  worktreePath: wt,
                });
              }
              return out;
            } catch (err) {
              // 目录不存在 = 项目没建过 session, 静默 noop
              if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
              log.warn({ err, projectRoot }, "scanWorktreeDirs failed");
              return [];
            }
          },
          // §4.3 C2 接管续删 — lease 死的 deleting session 由 reconciler
          // 续跑物理清理 + 三表 purge. 步骤:
          //   1. git worktree remove --force worktreePath (幂等)
          //   2. git worktree prune (清 .git/worktrees 悬挂登记)
          //   3. fs.rm 重试兜底 (Windows 上 §4.2 句柄轮询)
          //   4. mutex 内 /session/purge 删三表项
          // 整段幂等可重试 (§4.2 delete 两段) — 旧 owner 复活或本轮重跑
          // 都不会破坏最终一致.
          takeOverDelete: async (
            sessionId: string,
            _projectRoot: string,
            worktreePath: string,
          ): Promise<void> => {
            // Defense-in-depth: ensure the path is a per-session worktree
            // under .agentdock/worktrees/, never the base directory itself.
            const resolved = path.resolve(worktreePath);
            const basename = path.basename(resolved);
            if (!basename || basename === "worktrees" || basename === ".agentdock") {
              log.error({ worktreePath }, "C2 takeover-delete: refusing non-session path");
              return;
            }
            log.info({ sessionId, worktreePath }, "C2 takeover-delete: physical cleanup");
            // 1. git worktree remove --force (幂等: 不存在不报错)
            try {
              await execFile("git", [
                "-C",
                worktreePath,
                "worktree",
                "remove",
                "--force",
                worktreePath,
              ]);
            } catch (err) {
              log.debug({ err, worktreePath }, "git worktree remove failed (may be already gone)");
            }
            // 2. 从父 repo 跑 git worktree prune 清悬挂登记
            const projectRoot = path.dirname(path.dirname(path.dirname(worktreePath)));
            try {
              await execFile("git", ["-C", projectRoot, "worktree", "prune"]);
            } catch (err) {
              log.debug({ err, projectRoot }, "git worktree prune failed");
            }
            // 3. fs.rm 兜底
            try {
              if (existsSync(worktreePath)) {
                rmSync(worktreePath, { recursive: true, force: true });
              }
            } catch (err) {
              log.warn({ err, worktreePath }, "fs.rm fallback failed");
            }
            // 4. 三表 purge (走 mutex 串行). owner 可能已不存在
            // (C2 接管时原 owner 已死), 用 0/0 token 让 purgeSession 走
            // 幂等分支 (status==missing → 静默 OK).
            await this.ctx.mutex.runExclusive("state", () => {
              try {
                // 跳过 fencingToken 校验 (原 owner 已死) — 直接调
                // purgeSession 内部 status 判断, 不存在则幂等 OK.
                this.ctx.stateV2.purgeSession(sessionId);
                this.ctx.walV2.persist(this.ctx.stateV2);
              } catch (err) {
                log.warn({ err, sessionId }, "C2 purgeSession failed");
              }
            });
            // 5. SSE 通知监听端
            this.ctx.sseBus.publish("session-purged", { sessionId });
          },
          // §4.3 C1 回滚 — lease 死的 creating session 未过提交点
          // (键值不匹配 / 缺端口键) 时, reconciler 回滚删除三表项.
          // 不做 worktree 清理 (creating 状态本就没建好 worktree, 或
          // worktree 物理残留由 §4.3 C4 在下一轮对账中处理).
          rollbackCreate: async (sessionId: string): Promise<void> => {
            log.info({ sessionId }, "C1 rollback: purge half-created session");
            await this.ctx.mutex.runExclusive("state", () => {
              try {
                this.ctx.stateV2.purgeSession(sessionId);
                this.ctx.walV2.persist(this.ctx.stateV2);
              } catch (err) {
                log.warn({ err, sessionId }, "C1 rollback purgeSession failed");
              }
            });
            this.ctx.sseBus.publish("session-purged", { sessionId });
          },
        });
        this.reconcilerTimer = setInterval(() => {
          this.reconciler?.tick().catch((err) => {
            log.warn({ err }, "reconciler tick failed");
          });
        }, RECONCILER_TUNING.TICK_INTERVAL_MS);
        // Tick once immediately so first reconcile runs as soon as daemon
        // enters READY (will be no-op if still in grace window).
        this.reconciler.tick().catch((err) => {
          log.warn({ err }, "reconciler initial tick failed");
        });

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
    if (this.reconcilerTimer) {
      clearInterval(this.reconcilerTimer);
      this.reconcilerTimer = null;
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
  /\bdaemon\.(ts|js|cjs|mjs)$/.test(process.argv[1])
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
