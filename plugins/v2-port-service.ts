/**
 * v2 PortService — 新架构 §4.2 + §4.4.
 *
 * Drop-in replacement for the v1 PortService (allocateSession/releaseSession)
 * that drives the daemon's v2 three-table API. Used by session-lifecycle.ts
 * via dependency injection — the orchestrator stays daemon-agnostic.
 *
 * SessionId is unified: the client generates it, the daemon accepts it.
 * No appToV2Ids mapping — the same sessionId is used everywhere.
 *
 * Lifecycle in v2:
 *   /session/create → lease=15s, status=creating, fencingToken=1
 *   /claim × N      → ports allocated one by one
 *   /session/activate → status=active, lease cleared
 *   /session/delete  → ports released, status=deleting, lease=15s
 *   /session/purge   → 3-table entries dropped
 *   /session/heartbeat → lease refresh (creating/deleting only)
 *   /session/reclaim → unconditional ownership takeover
 *
 * State owned by this module (closure-scoped):
 *   tokens:     Map<sessionId, fencingToken>
 *   statuses:   Map<sessionId, "creating"|"active"|"deleting">
 *   renewals:   Map<sessionId, lease-renewal-tick state>
 *
 * The lease-renewal timer (LEASERENEWINTERVAL_MS = 5_000) keeps `creating`
 * and `deleting` sessions warm while hooks run. Active sessions are never
 * in the renewal map. Three consecutive heartbeat failures remove the
 * entry to prevent hammering a dead daemon.
 *
 * STALE_OWNER recovery: if a /session/heartbeat returns 409, the service
 * reads the new fencingToken from /debug/state (single GET) and retries
 * on the next tick. Never throws STALE_OWNER back to the caller — that's
 * an internal concern.
 */
import { LEASE_RENEW_INTERVAL_MS } from "./constants.js";
import { PORT_KEYS_DEFAULT } from "./config.js";
import type { SessionPorts } from "./daemon-state.js";
import type { PortService } from "./session-lifecycle.js";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * parseEnvFilePorts — 解析 .env 文件, 提取形如 `KEY=number` 的行.
 * 跳过空行/注释/非数字值. 用于 §4.2 提交点值匹配.
 */
function parseEnvFilePorts(contents: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    const n = Number(val);
    if (!Number.isFinite(n)) continue;
    out[key] = n;
  }
  return out;
}

/**
 * verifyCommitPoint — §4.2 提交点内联校验.
 *
 * session-lifecycle.ts 在 `writePortsToEnv(wt, ports)` 后**立即**调本函数,
 * 读 .env 实际写入的端口值, 与 daemon claim 返回的端口**逐项比对**:
 *   - .env 端口键齐全 (== N) **且每个键值 == daemon claim 返回的端口** → 通过
 *   - 任一项不匹配 → 抛 Error (含具体哪个键不匹配)
 *
 * 与 reconciler C1 提交点判定的区别:
 *   - 本函数: create 流程**立即**失败, 不等 lease 过期
 *   - C1: 兜底, 30s+ 后 reconciler 巡检时回滚
 *
 * syncResources 的 `mergeEnvFileSync` 可能把旧端口值合并进来 — 仅按
 * "键数 == N" 判通过会把脏 .env 误判为已提交. 本函数做**逐项值匹配**
 * (架构 §4.2 不变式).
 */
export function verifyCommitPoint(
  worktreePath: string,
  claimedPorts: SessionPorts,
): void {
  const envFile = path.join(worktreePath, ".env");
  let envContents: string;
  try {
    envContents = readFileSync(envFile, "utf-8");
  } catch (err) {
    throw new Error(
      `commit-point verify: cannot read ${envFile}: ${(err as Error).message}`,
    );
  }
  const envValues = parseEnvFilePorts(envContents);
  const claimedEntries = Object.entries(claimedPorts);
  if (claimedEntries.length === 0) {
    throw new Error("commit-point verify: no claimed ports");
  }
  for (const [name, port] of claimedEntries) {
    const envVal = envValues[name];
    if (envVal === undefined) {
      throw new Error(`commit-point verify: .env missing port key ${name}`);
    }
    if (envVal !== port) {
      throw new Error(
        `commit-point verify: .env ${name}=${envVal} != daemon port ${port}`,
      );
    }
  }
}

export interface V2PortServiceDeps {
  /** http://127.0.0.1:<port> */
  baseUrl: string;
  /** Stable per-cwd identity (same one the v1 daemon uses for /client/register). */
  clientId: string;
  pid: number;
  /** Project root used for /session/create's projectRoot field. */
  getProjectRoot: () => string;
  /**
   * How often to send /session/heartbeat for in-flight sessions.
   * Defaults to LEASE_RENEW_INTERVAL_MS (5s) — LEASE_TTL_MS (15s) leaves
   * 3× safety margin against the daemon timing us out.
   */
  heartbeatIntervalMs?: number;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
}

export interface V2PortServiceHandle {
  /** Satisfies plugins/session-lifecycle.ts PortService. */
  service: PortService;
  /** Current fencingToken for a session, or null if unknown. */
  getToken(sessionId: string): number | null;
  /** Current daemon-side status, or null if unknown. */
  getStatus(sessionId: string): "creating" | "active" | "deleting" | null;
  /** /reassign — re-pick ports for a session. */
  reassign(appSessionId: string): Promise<SessionPorts>;
  /** v2-only: phase 2 of delete — drop 3-table entries. */
  completeDeletion(appSessionId: string): Promise<void>;
  /**
   * §5.3 — 列出本地已知的所有 active/creating sessions.
   * 用于断线重连时对每个 session 主动 /claim 重注册, 走 daemon
   * RECOVERING 闸门重建 registry. 纯只读快照, 不触发任何 daemon 调用.
   */
  listKnownSessions(): Array<{
    sessionId: string;
    fencingToken: number;
    status: "creating" | "active" | "deleting";
    portKeys: string[];
  }>;
  /**
   * Unconditionally reclaim a session on the daemon: if it already exists,
   * swap owner; if not, create it. Used by silentTakeover for orphaned
   * worktrees on disk.
   */
  claimOrReuse(params: {
    sessionId: string;
    projectPath: string;
    portKeys?: string[];
    displayName?: string;
  }): Promise<SessionPorts>;
  /** Stop the lease timer + abort in-flight renewals. Call on app quit. */
  dispose(): void;
}

type Phase = "creating" | "active" | "deleting";

interface RenewalEntry {
  v2Sid: string;
  token: number;
  phase: Exclude<Phase, "active">;
  lastSent: number;
  failureCount: number;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

const HEARTBEAT_FAILURE_BUDGET = 3;

export function createV2PortService(deps: V2PortServiceDeps): V2PortServiceHandle {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const heartbeatInterval = deps.heartbeatIntervalMs ?? LEASE_RENEW_INTERVAL_MS;

  // Internal state — closure-scoped, not module-global, so multiple Electron
  // windows / tests can have independent services.
  const tokens = new Map<string, number>();
  const statuses = new Map<string, Phase>();
  const renewals = new Map<string, RenewalEntry>();
  /** §5.3 — 创建时的 portKeys, 用于断线重连时按相同 keys 重 claim. */
  const sessionPortKeys = new Map<string, string[]>();

  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  async function postJson(path: string, body: unknown): Promise<FetchResponseLike> {
    const res = await fetchImpl(`${deps.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res as unknown as FetchResponseLike;
  }

  async function getJson(path: string): Promise<unknown | null> {
    try {
      const res = await fetchImpl(`${deps.baseUrl}${path}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function getDebugState(): Promise<{
    v2Owners?: Record<string, { fencingToken: number }>;
    v2Ports?: Record<number, { port: number; sessionId: string; name: string }>;
  } | null> {
    return (await getJson("/debug/state")) as {
      v2Owners?: Record<string, { fencingToken: number }>;
      v2Ports?: Record<number, { port: number; sessionId: string; name: string }>;
    } | null;
  }

  function startLeaseRenewal(
    appSid: string,
    v2Sid: string,
    token: number,
    phase: Exclude<Phase, "active">,
  ): void {
    renewals.set(appSid, {
      v2Sid,
      token,
      phase,
      lastSent: Date.now(),
      failureCount: 0,
    });
    if (!timer && !disposed) {
      timer = setInterval(() => {
        void tick();
      }, heartbeatInterval);
      // Don't keep the event loop alive just for heartbeats.
      if (typeof timer.unref === "function") timer.unref();
    }
  }

  function stopLeaseRenewal(appSid: string): void {
    if (renewals.delete(appSid) && renewals.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function tick(): Promise<void> {
    if (disposed) return;
    const now = Date.now();
    // Snapshot to avoid mutation during iteration.
    const entries = Array.from(renewals.entries());
    for (const [appSid, entry] of entries) {
      if (now - entry.lastSent < heartbeatInterval) continue;
      try {
        const res = await postJson("/session/heartbeat", {
          sessionId: entry.v2Sid,
          fencingToken: entry.token,
          phase: entry.phase,
        });
        if (res.ok) {
          entry.lastSent = now;
          entry.failureCount = 0;
          continue;
        }
        // STALE_OWNER — refresh token from /debug/state and retry next tick.
        if (res.status === 409) {
          const state = await getDebugState();
          const owner = state?.v2Owners?.[entry.v2Sid];
          if (owner) {
            entry.token = owner.fencingToken;
            tokens.set(appSid, owner.fencingToken);
            entry.lastSent = now;
            entry.failureCount = 0;
          } else {
            entry.failureCount++;
          }
          continue;
        }
        entry.failureCount++;
      } catch {
        entry.failureCount++;
      }
      if (entry.failureCount >= HEARTBEAT_FAILURE_BUDGET) {
        // Give up — the orchestrator's failure path will eventually call
        // releaseSession which clears the entry anyway.
        renewals.delete(appSid);
      }
    }
  }

  function clearAll(appSid: string): void {
    tokens.delete(appSid);
    statuses.delete(appSid);
    sessionPortKeys.delete(appSid);
    stopLeaseRenewal(appSid);
  }

  const service: PortService = {
    async allocateSession(params): Promise<SessionPorts> {
      const { sessionId, projectPath, portKeys, displayName } = params;
      if (disposed) throw new Error("v2PortService disposed");
      // The orchestrator passes the actual projectPath (the per-session
      // project being opened, not the active cwd). Fall back to
      // `getProjectRoot()` only when not provided.
      const projectRoot = projectPath ?? deps.getProjectRoot();

      // F6 (新架构 §4.1) — pass the user-supplied displayName through to
      // the daemon verbatim. The daemon's `sanitizeDisplayName` does the
      // minimum cleansing (strip control chars, cap at 128). We fall
      // back to `sessionId` only when the caller did not supply one —
      // defensive default that mirrors the schema's `displayName?` field.
      const effectiveDisplayName = displayName ?? sessionId;

      // 1. Create — client provides sessionId, daemon accepts it. Returns fencingToken=1.
      const create = await postJson("/session/create", {
        sessionId,
        clientId: deps.clientId,
        pid: deps.pid,
        projectRoot,
        displayName: effectiveDisplayName,
      });
      if (!create.ok) {
        throw new Error(`v2 /session/create failed: ${create.status}`);
      }
      const createBody = (await create.json()) as {
        sessionId: string;
        fencingToken: number;
      };
      tokens.set(sessionId, createBody.fencingToken);
      statuses.set(sessionId, "creating");
      startLeaseRenewal(
        sessionId,
        sessionId,
        createBody.fencingToken,
        "creating",
      );

      try {
        // 2. Claim each port key.
        const keys = portKeys ?? PORT_KEYS_DEFAULT;
        // §5.3 — 记下创建时用的 portKeys, 断线重连时按相同 keys 重建
        sessionPortKeys.set(sessionId, [...keys]);
        const ports: SessionPorts = {};
        for (const name of keys) {
          const claim = await postJson("/claim", {
            sessionId,
            fencingToken: tokens.get(sessionId)!,
            name,
          });
          if (!claim.ok) {
            throw new Error(`v2 /claim ${name} failed: ${claim.status}`);
          }
          const claimBody = (await claim.json()) as {
            port: number;
            picked: boolean;
          };
          ports[name] = claimBody.port;
          if (claimBody.picked) {
            // Daemon moved us — refresh token.
            const state = await getDebugState();
            const owner = state?.v2Owners?.[sessionId];
            if (owner) {
              tokens.set(sessionId, owner.fencingToken);
            }
          }
        }

        // 3. Activate — commits the session to active.
        const activate = await postJson("/session/activate", {
          sessionId,
          fencingToken: tokens.get(sessionId)!,
        });
        if (!activate.ok) {
          throw new Error(`v2 /session/activate failed: ${activate.status}`);
        }
        statuses.set(sessionId, "active");
        stopLeaseRenewal(sessionId);
        return ports;
      } catch (err) {
        // Best-effort rollback so the daemon doesn't leak a `creating` row.
        const token = tokens.get(sessionId);
        if (token !== undefined) {
          await postJson("/session/delete", {
            sessionId,
            fencingToken: token,
          }).catch(() => {});
          await postJson("/session/purge", {
            sessionId,
            fencingToken: token,
          }).catch(() => {});
        }
        clearAll(sessionId);
        throw err;
      }
    },

    async releaseSession(sessionId: string): Promise<void> {
      if (disposed) return;
      const token = tokens.get(sessionId);
      if (token === undefined) {
        // Already gone or never owned — best-effort no-op.
        return;
      }
      // Phase 1: /session/delete (releases ports, status=deleting).
      const res = await postJson("/session/delete", {
        sessionId,
        fencingToken: token,
      });
      // 404 is fine — daemon may have been restarted and lost state.
      if (!res.ok && res.status !== 404) {
        // Roll forward: log + continue. Orchestrator's remove() still needs
        // to clean up the worktree.
      }
      statuses.set(sessionId, "deleting");
      startLeaseRenewal(sessionId, sessionId, token, "deleting");
      // Phase 2 (/session/purge) is deferred to completeDeletion() which
      // the orchestrator's IPC handler calls after the worktree is gone.
    },

    async completeDeletion(sessionId: string): Promise<void> {
      const token = tokens.get(sessionId);
      if (token === undefined) return;
      try {
        await postJson("/session/purge", {
          sessionId,
          fencingToken: token,
        });
      } catch {
        /* best-effort */
      }
      clearAll(sessionId);
    },
  };

  return {
    service,
    getToken: (sid) => tokens.get(sid) ?? null,
    getStatus: (sid) => statuses.get(sid) ?? null,
    async reassign(appSessionId: string): Promise<SessionPorts> {
      const token = tokens.get(appSessionId);
      if (token === undefined) {
        throw new Error(`v2 session not found: ${appSessionId}`);
      }
      const res = await postJson("/reassign", {
        sessionId: appSessionId,
        fencingToken: token,
      });
      if (!res.ok) {
        throw new Error(`v2 /reassign failed: ${res.status}`);
      }
      const body = (await res.json()) as { ports: SessionPorts };
      return body.ports;
    },
    completeDeletion: service.completeDeletion!,
    async claimOrReuse(params: {
      sessionId: string;
      projectPath: string;
      portKeys?: string[];
      displayName?: string;
    }): Promise<SessionPorts> {
      const { sessionId, projectPath, portKeys, displayName } = params;
      // 1. Unconditionally reclaim — daemon has it → swap owner; doesn't → create.
      const reclaim = await postJson("/session/reclaim", {
        sessionId,
        clientId: deps.clientId,
        pid: deps.pid,
        projectRoot: projectPath,
        displayName: displayName ?? sessionId,
      });
      if (!reclaim.ok) {
        throw new Error(`v2 /session/reclaim failed: ${reclaim.status}`);
      }
      const reclaimBody = (await reclaim.json()) as {
        fencingToken: number;
        created: boolean;
      };
      tokens.set(sessionId, reclaimBody.fencingToken);
      statuses.set(sessionId, "active");

      // 2. If daemon just created this session, claim ports + activate.
      if (reclaimBody.created) {
        const keys = portKeys ?? PORT_KEYS_DEFAULT;
        sessionPortKeys.set(sessionId, [...keys]);
        const ports: SessionPorts = {};
        let token = reclaimBody.fencingToken;
        for (const name of keys) {
          const claim = await postJson("/claim", {
            sessionId,
            fencingToken: token,
            name,
          });
          if (!claim.ok) {
            throw new Error(`v2 /claim ${name} failed: ${claim.status}`);
          }
          const claimBody = (await claim.json()) as {
            port: number;
            picked: boolean;
          };
          ports[name] = claimBody.port;
          if (claimBody.picked) {
            const state = await getDebugState();
            const owner = state?.v2Owners?.[sessionId];
            if (owner) {
              token = owner.fencingToken;
              tokens.set(sessionId, owner.fencingToken);
            }
          }
        }
        // Activate
        const activate = await postJson("/session/activate", {
          sessionId,
          fencingToken: tokens.get(sessionId)!,
        });
        if (!activate.ok) {
          throw new Error(`v2 /session/activate failed: ${activate.status}`);
        }
        return ports;
      }

      // 3. Daemon already had this session (active, ports already claimed).
      //    Return daemon's current port state via /debug/state.
      const state = await getDebugState();
      const sessionPorts = state?.v2Ports
        ? Object.values(state.v2Ports)
            .filter((p) => p.sessionId === sessionId)
            .reduce((acc, p) => ({ ...acc, [p.name]: p.port }), {} as SessionPorts)
        : {};
      return sessionPorts;
    },
    // §5.3 — 列出本地已知的所有 active/creating sessions, 给断线重连
    // 触发器用. 只读快照, 不调任何 daemon.
    listKnownSessions(): Array<{
      sessionId: string;
      fencingToken: number;
      status: "creating" | "active" | "deleting";
      portKeys: string[];
    }> {
      const out: Array<{
        sessionId: string;
        fencingToken: number;
        status: "creating" | "active" | "deleting";
        portKeys: string[];
      }> = [];
      for (const [sid, status] of statuses.entries()) {
        const token = tokens.get(sid);
        const keys = sessionPortKeys.get(sid) ?? [...PORT_KEYS_DEFAULT];
        if (token === undefined) continue;
        // 过滤 deleting — 已在 phase 1, 不需要重 claim
        if (status === "deleting") continue;
        out.push({
          sessionId: sid,
          fencingToken: token,
          status,
          portKeys: keys,
        });
      }
      return out;
    },
    dispose() {
      disposed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      renewals.clear();
    },
  };
}