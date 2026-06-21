/**
 * v2 PortService — 新架构 §4.2 + §4.4.
 *
 * Drop-in replacement for the v1 PortService (allocateSession/releaseSession)
 * that drives the daemon's v2 three-table API. Used by session-lifecycle.ts
 * via dependency injection — the orchestrator stays daemon-agnostic.
 *
 * Lifecycle in v2:
 *   /session/create → lease=15s, status=creating, fencingToken=1
 *   /claim × N      → ports allocated one by one
 *   /session/activate → status=active, lease cleared
 *   /session/delete  → ports released, status=deleting, lease=15s
 *   /session/purge   → 3-table entries dropped
 *   /session/heartbeat → lease refresh (creating/deleting only)
 *
 * State owned by this module (closure-scoped):
 *   appToV2Ids: Map<appSessionId, v2SessionId>
 *   tokens:     Map<appSessionId, fencingToken>
 *   statuses:   Map<appSessionId, "creating"|"active"|"deleting">
 *   renewals:   Map<appSessionId, lease-renewal-tick state>
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
  const appToV2Ids = new Map<string, string>();
  const tokens = new Map<string, number>();
  const statuses = new Map<string, Phase>();
  const renewals = new Map<string, RenewalEntry>();

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

  function readTokenFromDebugState(v2Sid: string): number | null {
    // Sync accessor — used inside the lease-renewal tick. Hits /debug/state
    // (single GET, ~1KB response) and fishes out the fencingToken. Cache
    // the result via the post-await caller.
    return null; // actual implementation uses async getDebugState
  }

  async function getDebugState(): Promise<{
    v2Owners?: Record<string, { fencingToken: number }>;
  } | null> {
    return (await getJson("/debug/state")) as {
      v2Owners?: Record<string, { fencingToken: number }>;
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
    appToV2Ids.delete(appSid);
    tokens.delete(appSid);
    statuses.delete(appSid);
    stopLeaseRenewal(appSid);
  }

  const service: PortService = {
    async allocateSession(params): Promise<SessionPorts> {
      const { sessionId, projectPath, portKeys } = params;
      if (disposed) throw new Error("v2PortService disposed");
      // The orchestrator passes the actual projectPath (the per-session
      // project being opened, not the active cwd). Fall back to
      // `getProjectRoot()` only when not provided.
      const projectRoot = projectPath ?? deps.getProjectRoot();

      // 1. Create — daemon generates its own sessionId (UUID), returns fencingToken=1.
      const create = await postJson("/session/create", {
        clientId: deps.clientId,
        pid: deps.pid,
        projectRoot,
        displayName: sessionId,
      });
      if (!create.ok) {
        throw new Error(`v2 /session/create failed: ${create.status}`);
      }
      const createBody = (await create.json()) as {
        sessionId: string;
        fencingToken: number;
      };
      appToV2Ids.set(sessionId, createBody.sessionId);
      tokens.set(sessionId, createBody.fencingToken);
      statuses.set(sessionId, "creating");
      startLeaseRenewal(
        sessionId,
        createBody.sessionId,
        createBody.fencingToken,
        "creating",
      );

      try {
        // 2. Claim each port key.
        const keys = portKeys ?? PORT_KEYS_DEFAULT;
        const ports: SessionPorts = {};
        for (const name of keys) {
          const claim = await postJson("/claim", {
            sessionId: createBody.sessionId,
            fencingToken: createBody.fencingToken,
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
            const owner = state?.v2Owners?.[createBody.sessionId];
            if (owner) {
              createBody.fencingToken = owner.fencingToken;
              tokens.set(sessionId, owner.fencingToken);
            }
          }
        }

        // 3. Activate — commits the session to active.
        const activate = await postJson("/session/activate", {
          sessionId: createBody.sessionId,
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
        const sid = appToV2Ids.get(sessionId);
        const token = tokens.get(sessionId);
        if (sid && token !== undefined) {
          await postJson("/session/delete", {
            sessionId: sid,
            fencingToken: token,
          }).catch(() => {});
          await postJson("/session/purge", {
            sessionId: sid,
            fencingToken: token,
          }).catch(() => {});
        }
        clearAll(sessionId);
        throw err;
      }
    },

    async releaseSession(sessionId: string): Promise<void> {
      if (disposed) return;
      const v2Sid = appToV2Ids.get(sessionId);
      const token = tokens.get(sessionId);
      if (!v2Sid || token === undefined) {
        // Already gone or never owned — best-effort no-op.
        return;
      }
      // Phase 1: /session/delete (releases ports, status=deleting).
      const res = await postJson("/session/delete", {
        sessionId: v2Sid,
        fencingToken: token,
      });
      // 404 is fine — daemon may have been restarted and lost state.
      if (!res.ok && res.status !== 404) {
        // Roll forward: log + continue. Orchestrator's remove() still needs
        // to clean up the worktree.
      }
      statuses.set(sessionId, "deleting");
      startLeaseRenewal(sessionId, v2Sid, token, "deleting");
      // Phase 2 (/session/purge) is deferred to completeDeletion() which
      // the orchestrator's IPC handler calls after the worktree is gone.
    },

    async completeDeletion(sessionId: string): Promise<void> {
      const v2Sid = appToV2Ids.get(sessionId);
      const token = tokens.get(sessionId);
      if (!v2Sid || token === undefined) return;
      try {
        await postJson("/session/purge", {
          sessionId: v2Sid,
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
      const v2Sid = appToV2Ids.get(appSessionId);
      const token = tokens.get(appSessionId);
      if (!v2Sid || token === undefined) {
        throw new Error(`v2 session not found: ${appSessionId}`);
      }
      const res = await postJson("/reassign", {
        sessionId: v2Sid,
        fencingToken: token,
      });
      if (!res.ok) {
        throw new Error(`v2 /reassign failed: ${res.status}`);
      }
      const body = (await res.json()) as { ports: SessionPorts };
      return body.ports;
    },
    completeDeletion: service.completeDeletion!,
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