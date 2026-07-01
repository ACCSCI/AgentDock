// @ts-nocheck
/**
 * DaemonState v2 — three-table normalized model (新架构 §4.1, §3.5).
 *
 * Tables:
 *   ports    : Map<portNumber, { port, sessionId, name }>  — RESERVED only
 *   owners   : Map<sessionId, { clientId, pid, fencingToken }>
 *   sessions : Map<sessionId, { projectRoot, displayName, status,
 *                             leaseExpiresAt, createdAt }>
 *
 * Invariants (新架构 §0, §11.3):
 *   - Each table keyed by sessionId shares the same key set; orphan keys are
 *     reconciliation drift (§4.3).
 *   - ports only stores RESERVED entries. "FREE" = not in map.
 *   - One session's N ports are reserved/released as a whole (整批语义).
 *   - sessionId is the single source of identity (§4); displayName is pure
 *     free text, never enters filesystem or git paths.
 *
 * This class is pure in-memory. Persistence is the job of plugins/daemon-wal.ts.
 */
import { PORT_KEYS_DEFAULT } from "./config.js";

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

export const CURRENT_SCHEMA_VERSION = 2 as const;

/**
 * RESERVED port — there is no FREE state in the registry because free ports
 * are simply absent from the map. Bind probing (§3.3) happens at allocation
 * time only.
 */
export interface PortRecord {
  port: number;
  sessionId: string;
  name: string; // e.g. "FRONTEND_PORT" — the port variable name from config
}

export interface OwnerRecord {
  clientId: string;
  pid: number;
  fencingToken: number;
}

export type SessionStatus = "creating" | "active" | "deleting";

export interface SessionRecord {
  projectRoot: string;
  displayName: string;
  status: SessionStatus;
  leaseExpiresAt: number | null; // ms epoch, null = no in-flight transaction
  createdAt: number;
}

export type DaemonLifecycleState = "RECOVERING" | "READY";

export interface SerializedV2 {
  schemaVersion: 2;
  ports: Record<number, PortRecord>;
  owners: Record<string, OwnerRecord>;
  sessions: Record<string, SessionRecord>;
  daemonPort: number | null;
  state: DaemonLifecycleState;
}

// ---------------------------------------------------------------------------
// Mutex-friendly in-memory store
// ---------------------------------------------------------------------------

/**
 * Lookup table of sessionId → its set of reserved port numbers.
 * Derived state — never persisted; rebuilt from the `ports` map on demand.
 * Keeps `claim` / `release` for a whole session O(1) per port without
 * scanning the entire ports map.
 */
export class DaemonStateV2 {
  readonly ports = new Map<number, PortRecord>();
  readonly owners = new Map<string, OwnerRecord>();
  readonly sessions = new Map<string, SessionRecord>();

  private readonly sessionPorts = new Map<string, Set<number>>();
  private readonly sessionNames = new Map<string, Set<string>>();

  daemonPort: number | null = null;
  state: DaemonLifecycleState = "READY";

  // -------------------------------------------------------------------------
  // Lifecycle state transitions (§5.2)
  // -------------------------------------------------------------------------

  setState(next: DaemonLifecycleState): void {
    this.state = next;
  }

  isReady(): boolean {
    return this.state === "READY";
  }

  isRecovering(): boolean {
    return this.state === "RECOVERING";
  }

  // -------------------------------------------------------------------------
  // Session lifecycle (§4.2)
  // -------------------------------------------------------------------------

  /**
   * Create a session in `creating` state, allocate its first owner with
   * fencingToken=1. The caller is the new owner (no token required to
   * initiate create — new session = new owner).
   */
  createSession(args: {
    sessionId: string;
    projectRoot: string;
    displayName: string;
    clientId: string;
    pid: number;
    leaseExpiresAt: number;
  }): void {
    if (this.sessions.has(args.sessionId)) {
      throw new Error(`Session ${args.sessionId} already exists`);
    }
    if (this.owners.has(args.sessionId)) {
      throw new Error(`Owner for ${args.sessionId} already exists`);
    }
    this.sessions.set(args.sessionId, {
      projectRoot: args.projectRoot,
      displayName: args.displayName,
      status: "creating",
      leaseExpiresAt: args.leaseExpiresAt,
      createdAt: Date.now(),
    });
    this.owners.set(args.sessionId, {
      clientId: args.clientId,
      pid: args.pid,
      fencingToken: 1,
    });
    this.sessionPorts.set(args.sessionId, new Set());
    this.sessionNames.set(args.sessionId, new Set());
  }

  /**
   * Unconditionally reclaim a session: if the daemon already has it, swap
   * the owner; if not, create it. Used by silentTakeover when the old daemon
   * is dead and a new instance picks up orphaned worktrees from disk.
   *
   * Returns `created: true` when a new session was created (caller should
   * claim ports + activate), `created: false` when ownership was swapped
   * (session already active, ports already claimed).
   */
  reclaimSession(args: {
    sessionId: string;
    projectRoot: string;
    displayName: string;
    clientId: string;
    pid: number;
    leaseExpiresAt: number;
  }): { fencingToken: number; created: boolean } {
    const existing = this.sessions.get(args.sessionId);
    if (existing) {
      // Daemon already knows this session — unconditionally swap owner.
      this.setOwner(args.sessionId, args.clientId, args.pid, 1);
      return { fencingToken: 1, created: false };
    }
    // Session not in daemon — create fresh.
    this.createSession(args);
    return { fencingToken: 1, created: true };
  }

  /**
   * Mark session as active — ports have been claimed and .env is fully written
   * (commit point reached, §4.2). Lease cleared (no in-flight transaction).
   */
  activateSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    if (s.status !== "creating") {
      throw new Error(
        `Session ${sessionId} cannot activate from status=${s.status}`,
      );
    }
    s.status = "active";
    s.leaseExpiresAt = null;
  }

  /**
   * Rename — only the displayName field changes. branch / worktreePath are
   * derived from sessionId (§4.1) and never touched here.
   */
  renameSession(sessionId: string, displayName: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    if (s.status !== "active") {
      throw new Error(`Cannot rename session in status=${s.status}`);
    }
    s.displayName = displayName;
  }

  /**
   * Phase 1 of delete (§4.2): mark deleting, set lease, return ports to FREE.
   * Phase 2 (purge) deletes the three-table entries.
   *
   * Idempotent — repeated delete calls on a session already in `deleting`
   * are no-ops for the already-released ports.
   */
  beginDelete(sessionId: string, leaseExpiresAt: number): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    s.status = "deleting";
    s.leaseExpiresAt = leaseExpiresAt;
    this.releaseAllPorts(sessionId);
  }

  /**
   * Phase 2 of delete — drop the session, owner, and any leftover
   * session-port / session-name bookkeeping. Called after the client has
   * physically cleaned the worktree.
   *
   * §13.2 SESSION_NOT_DELETABLE: throws if the session is not in
   * `deleting` state. The two-phase delete is:
   *   1. /session/delete (beginDelete) → status=deleting, ports released
   *   2. /session/purge (purgeSession) → drop 3-table entries
   * Skipping phase 1 (calling purge on an active session) is a client bug.
   */
  purgeSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) {
      // 幂等: 已 purge / 不存在, 静默 OK (§4.2 delete 末段)
      this.releaseAllPorts(sessionId);
      this.owners.delete(sessionId);
      this.sessionPorts.delete(sessionId);
      this.sessionNames.delete(sessionId);
      return;
    }
    if (s.status !== "deleting") {
      throw new SessionNotDeletableError(sessionId, s.status);
    }
    this.releaseAllPorts(sessionId);
    this.sessions.delete(sessionId);
    this.owners.delete(sessionId);
    this.sessionPorts.delete(sessionId);
    this.sessionNames.delete(sessionId);
  }

  // -------------------------------------------------------------------------
  // Port claim / release (§3.3, §3.5)
  // -------------------------------------------------------------------------

  /**
   * Reserve a single port for the given session under the given variable name.
   * Throws if the port is reserved by another session (caller must pick a new
   * port via pickFreePort and retry). Idempotent if the same (sessionId, port)
   * is re-claimed.
   */
  claimPort(sessionId: string, port: number, name: string): void {
    const existing = this.ports.get(port);
    if (existing && existing.sessionId !== sessionId) {
      throw new PortConflictError(
        port,
        existing.sessionId,
        `port ${port} reserved by session ${existing.sessionId}`,
      );
    }
    if (existing && existing.name !== name) {
      // Same session re-uses the port under a different name? Logically the
      // agentdock config is the source of truth for N (§3.5); treat as
      // overwrite-with-warning rather than throw, so transient reorders
      // during recovery don't deadlock.
      existing.name = name;
    }
    if (!existing) {
      this.ports.set(port, { port, sessionId, name });
    }
    this.sessionPorts.get(sessionId)?.add(port);
    this.sessionNames.get(sessionId)?.add(name);
  }

  /**
   * Release a single port. Returns true if it was actually removed.
   * Idempotent for already-free ports.
   */
  releasePort(sessionId: string, port: number): boolean {
    const rec = this.ports.get(port);
    if (!rec || rec.sessionId !== sessionId) return false;
    this.ports.delete(port);
    this.sessionPorts.get(sessionId)?.delete(port);
    return true;
  }

  /** Release every port currently reserved for a session. */
  releaseAllPorts(sessionId: string): void {
    const set = this.sessionPorts.get(sessionId);
    if (!set) return;
    for (const port of [...set]) {
      this.ports.delete(port);
    }
    set.clear();
    this.sessionNames.get(sessionId)?.clear();
  }

  /** All port numbers reserved for this session (immutable copy). */
  getSessionPorts(sessionId: string): number[] {
    return [...(this.sessionPorts.get(sessionId) ?? [])];
  }

  /** All port variable names reserved for this session. */
  getSessionPortNames(sessionId: string): string[] {
    return [...(this.sessionNames.get(sessionId) ?? [])];
  }

  /** Look up the owner of a port — null if FREE. */
  getPortOwner(port: number): { sessionId: string; name: string } | null {
    const rec = this.ports.get(port);
    return rec ? { sessionId: rec.sessionId, name: rec.name } : null;
  }

  /** Snapshot of all RESERVED ports for /debug/state. */
  listAllPorts(): PortRecord[] {
    return [...this.ports.values()];
  }

  // -------------------------------------------------------------------------
  // Ownership / fencing (§6.1)
  // -------------------------------------------------------------------------

  /**
   * Take over a session: bump fencingToken, swap clientId/pid. Caller passes
   * the current (stale) token; the new token is returned. Caller is
   * responsible for atomic persist-then-return (§6.1 last paragraph).
   *
   * Throws if no session, or if `providedToken` does not match the current
   * registry token. Both `null` and mismatch mean STALE_OWNER. No owner →
   * NOT_OWNER (§13.2).
   */
  takeover(
    sessionId: string,
    newClientId: string,
    newPid: number,
    providedToken: number | null,
  ): { fencingToken: number } {
    const owner = this.owners.get(sessionId);
    if (!owner) throw new NotOwnerError(sessionId);
    if (providedToken !== owner.fencingToken) {
      throw new StaleOwnerError(sessionId, owner.fencingToken, providedToken);
    }
    owner.fencingToken += 1;
    owner.clientId = newClientId;
    owner.pid = newPid;
    return { fencingToken: owner.fencingToken };
  }

  /**
   * Verify the caller holds the current fencing token for a write. Throws
   * StaleOwnerError if not. Does NOT mutate state — purely a gate check.
   *
   * If no owner is registered at all, throws NotOwnerError (§13.2 NOT_OWNER).
   */
  assertFencingToken(sessionId: string, providedToken: number | null): void {
    const owner = this.owners.get(sessionId);
    if (!owner) {
      throw new NotOwnerError(sessionId);
    }
    if (providedToken !== owner.fencingToken) {
      throw new StaleOwnerError(sessionId, owner.fencingToken, providedToken);
    }
  }

  setOwner(
    sessionId: string,
    clientId: string,
    pid: number,
    fencingToken: number,
  ): void {
    this.owners.set(sessionId, { clientId, pid, fencingToken });
  }

  getOwner(sessionId: string): OwnerRecord | null {
    return this.owners.get(sessionId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Liveness lease (§4.4)
  // -------------------------------------------------------------------------

  /** Heartbeat from a running lifecycle executor — refresh leaseExpiresAt. */
  renewLease(sessionId: string, leaseTtlMs: number): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    s.leaseExpiresAt = Date.now() + leaseTtlMs;
  }

  clearLease(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.leaseExpiresAt = null;
  }

  /**
   * Reconciliation predicate (§4.4): a session is "abandoned" iff its owner's
   * heartbeat has timed out AND its lease has expired. Returns true for
   * in-flight (creating/deleting) sessions only — pure-active sessions are
   * not subject to per-session lease judgement.
   */
  isSessionAbandoned(
    sessionId: string,
    now: number,
    instanceHeartbeatTimeoutMs: number,
    ownerLastHeartbeat: number | null,
  ): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    if (s.status === "active") return false;
    if (s.leaseExpiresAt === null) return false;
    if (now < s.leaseExpiresAt) return false;
    // §6.1 race window guard: when the owner heartbeat is null (e.g. transient
    // gap during lease renewal / takeover), conservatively report NOT abandoned
    // so we never prematurely take over a session actively being deleted.
    if (ownerLastHeartbeat === null) return false;
    return now - ownerLastHeartbeat > instanceHeartbeatTimeoutMs;
  }

  // -------------------------------------------------------------------------
  // Read helpers
  // -------------------------------------------------------------------------

  getSession(sessionId: string): SessionRecord | null {
    return this.sessions.get(sessionId) ?? null;
  }

  listSessions(): Array<{ sessionId: string } & SessionRecord> {
    return [...this.sessions.entries()].map(([sessionId, s]) => ({
      sessionId,
      ...s,
    }));
  }

  listOwners(): Array<{ sessionId: string } & OwnerRecord> {
    return [...this.owners.entries()].map(([sessionId, o]) => ({
      sessionId,
      ...o,
    }));
  }

  /**
   * Find a session whose projectRoot matches and which has at least one port
   * name collision. Used for debug snapshot, not for allocation.
   */
  setDaemonPort(port: number | null): void {
    this.daemonPort = port;
  }

  /**
   * Pick N candidate ports excluding already-RESERVED ports. This is a pure
   * enumeration helper — it does NOT bind-probe. The caller is responsible
   * for probing each candidate before calling claimPort (see
   * plugins/port-allocator.ts pickFreePort).
   *
   * Defaults to OS-random port selection (port=0) when possible, falling
   * back to PORT_RANGE_START..END random scan only if caller supplies a range.
   */
  // (Implementation lives in port-allocator; this method intentionally absent
  // so DaemonState stays free of OS-level logic.)

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  serialize(): SerializedV2 {
    return {
      schemaVersion: 2,
      ports: Object.fromEntries(this.ports),
      owners: Object.fromEntries(this.owners),
      sessions: Object.fromEntries(this.sessions),
      daemonPort: this.daemonPort,
      state: this.state,
    };
  }

  /**
   * Restore from a serialized snapshot. Validates schemaVersion; throws on
   * missing fields. Does not preserve sessionPorts / sessionNames caches —
   * those are rebuilt from the ports table below.
   */
  static deserialize(json: string): DaemonStateV2 {
    const raw = JSON.parse(json) as Partial<SerializedV2>;
    if (raw.schemaVersion !== 2) {
      throw new Error(
        `Cannot deserialize: schemaVersion=${raw.schemaVersion}, expected 2`,
      );
    }
    const state = new DaemonStateV2();
    for (const [portStr, rec] of Object.entries(raw.ports ?? {})) {
      const port = Number(portStr);
      state.ports.set(port, rec);
      let names = state.sessionPorts.get(rec.sessionId);
      if (!names) {
        names = new Set();
        state.sessionPorts.set(rec.sessionId, names);
      }
      names.add(port);
      let nameSet = state.sessionNames.get(rec.sessionId);
      if (!nameSet) {
        nameSet = new Set();
        state.sessionNames.set(rec.sessionId, nameSet);
      }
      nameSet.add(rec.name);
    }
    for (const [sid, owner] of Object.entries(raw.owners ?? {})) {
      state.owners.set(sid, owner);
    }
    for (const [sid, sess] of Object.entries(raw.sessions ?? {})) {
      state.sessions.set(sid, sess);
      if (!state.sessionPorts.has(sid)) {
        state.sessionPorts.set(sid, new Set());
        state.sessionNames.set(sid, new Set());
      }
    }
    state.daemonPort = raw.daemonPort ?? null;
    state.state = raw.state === "RECOVERING" ? "RECOVERING" : "READY";
    return state;
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PortConflictError extends Error {
  constructor(
    public readonly port: number,
    public readonly ownerSessionId: string,
    message: string,
  ) {
    super(message);
    this.name = "PortConflictError";
  }
}

export class StaleOwnerError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly currentToken: number,
    public readonly providedToken: number | null,
  ) {
    super(
      `Stale owner for ${sessionId}: current fencingToken=${currentToken}, provided=${providedToken}`,
    );
    this.name = "StaleOwnerError";
  }
}

/**
 * NotOwnerError — §13.2 NOT_OWNER.
 *
 * 触发: 没有任何 owner 记录, 但 caller 试图写 (理论上 fencingToken
 * 不匹配也走 STALE_OWNER; NOT_OWNER 是"owner 根本不存在"分支).
 */
export class NotOwnerError extends Error {
  constructor(public readonly sessionId: string) {
    super(`No owner for session ${sessionId}`);
    this.name = "NotOwnerError";
  }
}

/**
 * SessionNotDeletableError — §13.2 SESSION_NOT_DELETABLE.
 *
 * 触发: 试图 purge 一个不处于可删状态的 session (active 但还没走
 * /session/delete; 已 purge 重复 purge). 客户端刷新本地视图后按对账
 * 结果处理.
 */
export class SessionNotDeletableError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly currentStatus: SessionStatus | "missing",
  ) {
    super(
      `Session ${sessionId} is not deletable (current status: ${currentStatus})`,
    );
    this.name = "SessionNotDeletableError";
  }
}

/**
 * RecoveringError — §13.2 RECOVERING.
 *
 * 触发: daemon 处于 RECOVERING 期, 陌生 sessionId 的 claim 被闸门拒.
 * 客户端退避后重试, 等待 daemon 收敛到 READY.
 */
export class RecoveringError extends Error {
  constructor(
    public readonly sessionId: string | null,
    message?: string,
  ) {
    super(
      message ??
        (sessionId
          ? `Daemon is in RECOVERING; non-recovery claim for ${sessionId} is rejected`
          : "Daemon is in RECOVERING; retry after READY"),
    );
    this.name = "RecoveringError";
  }
}

/**
 * SessionBusyError — §13.2 SESSION_BUSY.
 *
 * 触发: lease 未过期(creating/deleting 中)+ 收到试图插入另一条生命周期事务
 * 的写. 客户端等待续约方完成, 勿强抢.
 */
export class SessionBusyError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly leaseExpiresAt: number,
  ) {
    super(
      `Session ${sessionId} is busy (lease expires at ${leaseExpiresAt})`,
    );
    this.name = "SessionBusyError";
  }
}

// Re-exported for convenience — consumers importing PORT_KEYS_DEFAULT should
// import from plugins/config.js (single source of truth, §14.1).
export { PORT_KEYS_DEFAULT };
