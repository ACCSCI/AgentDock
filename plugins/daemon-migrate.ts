// @ts-nocheck
/**
 * WAL schema migrations — 新架构 §5.1.1.
 *
 * Each migration is a pure function (state) => state. The chain runs in
 * memory (read JSON → run all version links → write once). No half-written
 * intermediate files on disk — the atomic write-rename happens only after
 * the whole chain succeeds.
 *
 * Crash safety: the entire migration is in-memory before the single
 * write-rename. If the daemon crashes mid-migration, the on-disk file is
 * the original (rename not yet committed) — next start re-runs the chain
 * idempotently.
 *
 * Reject downgrade: if the persisted schemaVersion is HIGHER than CURRENT,
 * we throw immediately. A newer daemon wrote this; an older daemon must
 * not silently truncate or rewrite the file (would corrupt upstream state).
 */
import { CURRENT_SCHEMA_VERSION } from "./daemon-state-v2.js";

export type AnyState = Record<string, unknown>;

/**
 * Migration registry. Keys are the FROM version; the function transforms
 * a state at version `k` to version `k+1`. The chain is iterated until
 * state.schemaVersion === CURRENT_SCHEMA_VERSION.
 *
 * Keys MUST be contiguous integers starting at 1, otherwise the loader
 * rejects the migration plan (gap means missing intermediate step).
 */
export const MIGRATIONS: Record<number, (state: AnyState) => AnyState> = {
  1: migrate_v1_to_v2,
};

export const SUPPORTED_VERSIONS: readonly number[] = Object.keys(MIGRATIONS)
  .map(Number)
  .sort((a, b) => a - b);

/**
 * Migrate a raw state object to CURRENT_SCHEMA_VERSION.
 *
 * @throws if state.schemaVersion > CURRENT (downgrade forbidden)
 * @throws if migration chain has gaps (caller bug)
 * @returns the migrated state object
 */
export function migrateToCurrent(raw: AnyState): AnyState {
  const fromVersion =
    typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1;

  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Refusing to downgrade: WAL schemaVersion=${fromVersion} > current=${CURRENT_SCHEMA_VERSION}. ` +
        `This file was written by a newer daemon. Aborting to prevent data loss.`,
    );
  }
  if (fromVersion === CURRENT_SCHEMA_VERSION) {
    return raw;
  }

  let state = raw;
  for (let v = fromVersion; v < CURRENT_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) {
      throw new Error(
        `Migration gap: no migrator from v${v} to v${v + 1}. ` +
          `Available migrators: [${Object.keys(MIGRATIONS).join(", ")}]`,
      );
    }
    state = step(state);
    if (state.schemaVersion !== v + 1) {
      throw new Error(
        `Migration v${v}→v${v + 1} did not bump schemaVersion (got ${state.schemaVersion})`,
      );
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// v1 → v2 — 4-map → 3-table normalized (§5.1.1)
// ---------------------------------------------------------------------------

interface V1SessionEntry {
  sessionId: string;
  worktreePath: string;
  projectPath: string;
  ports: Record<string, number>;
  ownerClientId: string;
  ownerPid: number;
  createdAt: string;
}

interface V1ClientEntry {
  clientId: string;
  pid: number;
  projectPaths: string[];
  lastHeartbeat: number;
}

interface V1Serialized {
  sessions: Record<string, V1SessionEntry>;
  clients: Record<string, V1ClientEntry>;
  allocatedPorts: number[];
  worktreeIndex: Record<string, string>;
  daemonPort?: number;
}

/**
 * Real v1 shape (no schemaVersion field) → v2 three-table.
 *
 * Strategy: walk every entry in `sessions` and split into the three tables.
 * This preserves truth in places where v1's auxiliary indexes (allocatedPorts,
 * worktreeIndex) had drifted.
 *
 * Edge cases handled:
 * - v1 `fencingToken` does not exist → init to 1 (matches §4.2 new sessions)
 * - v1 `projectPath` may be missing → derive from `worktreePath` by stripping
 *   the trailing `/.agentdock/worktrees/<sessionId>` segment
 * - `allocatedPorts` is cross-checked against the union of session.ports;
 *   mismatch warns but doesn't block (sessions are the source of truth)
 * - `worktreeIndex` is dropped — v2 derives worktreePath from sessionId live
 */
function migrate_v1_to_v2(raw: AnyState): AnyState {
  const v1 = raw as unknown as Partial<V1Serialized>;
  const sessions = v1.sessions ?? {};
  const clients = v1.clients ?? {};
  const v1Allocated = new Set(v1.allocatedPorts ?? []);

  const ports: Record<number, unknown> = {};
  const owners: Record<string, unknown> = {};
  const sessionsOut: Record<string, unknown> = {};
  const warnings: string[] = [];

  const allV1Ports = new Set<number>();

  for (const [sessionId, entry] of Object.entries(sessions)) {
    // --- owners table ---
    owners[sessionId] = {
      clientId: entry.ownerClientId,
      pid: entry.ownerPid,
      fencingToken: 1, // v1 had no fencing — initialize to 1 (§5.1.1)
    };

    // --- ports table (expand name → port entries) ---
    for (const [name, port] of Object.entries(entry.ports ?? {})) {
      if (typeof port !== "number") continue;
      if (ports[port]) {
        // Two sessions claiming same port in v1 — keep the first, warn.
        warnings.push(
          `port ${port} appeared in multiple v1 sessions; kept first (${(ports[port] as { sessionId: string }).sessionId}), skipped ${sessionId}`,
        );
        continue;
      }
      ports[port] = { port, sessionId, name, state: "RESERVED" };
      allV1Ports.add(port);
    }

    // --- sessions table (with projectRoot fallback from worktreePath) ---
    let projectRoot = entry.projectPath ?? "";
    if (!projectRoot && entry.worktreePath) {
      // Try reverse-derive: strip "/.agentdock/worktrees/<id>" suffix
      const marker = `/.agentdock/worktrees/${sessionId}`;
      const idx = entry.worktreePath.indexOf(marker);
      if (idx >= 0) {
        projectRoot = entry.worktreePath.slice(0, idx);
      } else {
        warnings.push(
          `v1 session ${sessionId}: no projectPath and worktreePath does not contain expected suffix; projectRoot left empty`,
        );
      }
    }

    sessionsOut[sessionId] = {
      projectRoot,
      displayName: deriveDisplayName(sessionId, entry),
      status: "active", // v1 had no status — assume active
      leaseExpiresAt: null,
      createdAt: parseCreatedAt(entry.createdAt),
    };
  }

  // Cross-check v1.allocatedPorts vs union of session.ports
  for (const port of v1Allocated) {
    if (!allV1Ports.has(port)) {
      warnings.push(
        `v1 allocatedPorts contains ${port} but no session claimed it — dropped from registry`,
      );
    }
  }

  // Clients map (v1) → not the same as owners. v1 clients are the per-process
  // heartbeat registry; v2 doesn't need it as a separate concept since
  // owners carry the same identity via clientId. We don't persist clients
  // separately — instance heartbeat state is recovered from /client/register
  // calls at runtime. The clients map is intentionally dropped.

  return {
    schemaVersion: 2,
    ports,
    owners,
    sessions: sessionsOut,
    daemonPort: typeof v1.daemonPort === "number" ? v1.daemonPort : null,
    state: "RECOVERING", // Always start in RECOVERING after upgrade — caller
    // (daemon boot) will transition to READY after the soft/hard window
    // (§5.2) or earlier if expected reports are all in.
    _migrationWarnings: warnings, // Diagnostic only — not read by deserialize.
  };
}

function deriveDisplayName(sessionId: string, entry: V1SessionEntry): string {
  // v1 had no displayName. Use first 8 chars of sessionId as a stable
  // identifier so UI has SOMETHING to show. Caller can rename later.
  return sessionId.slice(0, 8);
}

function parseCreatedAt(raw: string | undefined): number {
  if (!raw) return Date.now();
  const t = Date.parse(raw);
  return Number.isNaN(t) ? Date.now() : t;
}

// ---------------------------------------------------------------------------
// Validation (used by the WAL loader)
// ---------------------------------------------------------------------------

/**
 * Sanity-check a v2 state object before deserialization. Returns the list of
 * validation problems; empty array means OK.
 */
export function validateV2State(raw: AnyState): string[] {
  const problems: string[] = [];
  if (raw.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion=${String(raw.schemaVersion)} (expected ${CURRENT_SCHEMA_VERSION})`,
    );
  }
  if (typeof raw.ports !== "object" || raw.ports === null) {
    problems.push("ports is not an object");
  }
  if (typeof raw.owners !== "object" || raw.owners === null) {
    problems.push("owners is not an object");
  }
  if (typeof raw.sessions !== "object" || raw.sessions === null) {
    problems.push("sessions is not an object");
  }
  return problems;
}
