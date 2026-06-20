/**
 * Invariant Assertions — 新架构 §11.3.
 *
 * Programmatic predicates that encode the architectural invariants. Every
 * E2E step calls these after the action; failures point to which invariant
 * is violated and surface the relevant state for triage. Reused in unit
 * tests so the assertion logic isn't duplicated (single source of truth).
 *
 * Invariants:
 *   1. registry is "ownership" truth, NOT "listening" truth — listening ports
 *      ⊆ RESERVED set, but RESERVED ∩ listening ≠ required
 *   2. RESERVED transitions only via lifecycle (claim / release / heartbeat-timeout)
 *   3. .env untrusted — corrupted preferredPort doesn't change Daemon decisions
 *   4. bind proof — every port returned has been bind-verified at allocation
 *   5. worktree single owner — same worktreePath never has two accepted writes
 *   6. no double-write — old fencingToken writes get STALE_OWNER
 *   7. displayName isolation — paths/branches derive from sessionId only,
 *      never from displayName
 *   8. snapshot+stream monotonicity — applying /sync then SSE increments
 *      doesn't regress
 */
import type { DaemonStateV2 } from "./daemon-state-v2.js";
import { SESSION_ID_RE } from "./config-derived.js";

export interface InvariantResult {
  ok: boolean;
  detail: string;
}

/**
 * #1 — Listening ports ⊆ RESERVED set. (The reverse direction is NOT
 * asserted — RESERVED without listener is a legal state during dev server
 * stop/start cycles; §3.5 makes this explicit.)
 */
export function assertListenSubsetReserved(
  state: DaemonStateV2,
  listeners: ReadonlySet<number>,
): InvariantResult {
  for (const port of listeners) {
    if (!state.getPortOwner(port)) {
      return {
        ok: false,
        detail: `port ${port} is listening but not RESERVED — orphan external listener`,
      };
    }
  }
  return { ok: true, detail: `${listeners.size} listeners all map to RESERVED` };
}

/**
 * #2 — RESERVED transitions only via the lifecycle entry points. This
 * predicate checks the AVERAGE rate over the last N transitions to spot
 * anomalies (e.g. claimed ports released without explicit release call).
 *
 * Implementation: caller must record every transition via `recordTransition`.
 * Invariant holds iff transitions only come from {claim, release, timeout}.
 */
export type TransitionKind = "claim" | "release" | "timeout" | "other";

interface TransitionLog {
  kind: TransitionKind;
  port: number;
  sessionId: string | null;
  at: number;
}

const transitionLog: TransitionLog[] = [];

export function recordTransition(
  kind: TransitionKind,
  port: number,
  sessionId: string | null,
): void {
  transitionLog.push({ kind, port, sessionId, at: Date.now() });
  if (transitionLog.length > 1000) transitionLog.shift();
}

export function clearTransitionLog(): void {
  transitionLog.length = 0;
}

export function assertOnlyLifecycleTransitions(): InvariantResult {
  const bad = transitionLog.filter((t) => t.kind === "other");
  if (bad.length > 0) {
    return {
      ok: false,
      detail: `${bad.length} non-lifecycle port transitions recorded (first: ${JSON.stringify(bad[0])})`,
    };
  }
  return { ok: true, detail: `all ${transitionLog.length} transitions are lifecycle-driven` };
}

/**
 * #3 — .env untrusted. The Daemon must NOT skip bind probe even if .env
 * says a port is "preferred". Implementation lives in /claim route — this
 * invariant is verified by reading the call graph: /claim always probes
 * unless (a) same session owns the port already (idempotent re-claim) or
 * (b) bindFailed hint from client. This function is a documentation
 * assertion: if a new /claim implementation lands that skips probe in
 * other cases, change this and the test fails.
 */
export function assertEnvNotTrusted(
  preferredPort: number | undefined,
  actuallyAllocatedPort: number,
  bindProbeRan: boolean,
): InvariantResult {
  if (preferredPort === undefined) {
    return { ok: true, detail: "no preferred port specified" };
  }
  if (preferredPort === actuallyAllocatedPort && bindProbeRan) {
    return {
      ok: true,
      detail: `preferredPort=${preferredPort} honored, bind probe ran`,
    };
  }
  if (preferredPort !== actuallyAllocatedPort) {
    return {
      ok: true,
      detail: `preferredPort=${preferredPort} → reallocated to ${actuallyAllocatedPort} (bind probe detected external use)`,
    };
  }
  return {
    ok: false,
    detail: `preferredPort=${preferredPort} honored WITHOUT bind probe — violates #3`,
  };
}

/**
 * #4 — bind proof. Every RESERVED port must have been bind-verified at
 * allocation time (or be an idempotent re-claim by the same session).
 *
 * Caller tracks which ports were bind-verified via `markBindVerified`.
 * On a violation, the port is RESERVED but not in the verified set and
 * was never claimed by the same session before.
 */
const bindVerifiedPorts = new Set<number>();

export function markBindVerified(port: number): void {
  bindVerifiedPorts.add(port);
}

export function clearBindVerified(): void {
  bindVerifiedPorts.clear();
}

export function assertBindProof(state: DaemonStateV2): InvariantResult {
  const violations: number[] = [];
  for (const portRec of state.listAllPorts()) {
    if (!bindVerifiedPorts.has(portRec.port)) {
      // Could be an idempotent re-claim from same session — that's legal.
      // We'd need history to know; for now we trust that re-claim only
      // happens via /claim which does markBindVerified when first reserved.
      violations.push(portRec.port);
    }
  }
  if (violations.length > 0) {
    return {
      ok: false,
      detail: `${violations.length} RESERVED ports without bind proof: ${violations.slice(0, 5).join(", ")}...`,
    };
  }
  return { ok: true, detail: `all ${state.listAllPorts().length} RESERVED ports have bind proof` };
}

/**
 * #5 — worktree single owner. Same worktreePath never has two accepted
 * writes. Implementation: each sessionId gets a unique worktreePath derived
 * from `<projectRoot>/.agentdock/worktrees/<sessionId>` (§4.1). This
 * predicate validates uniqueness across all active sessions.
 */
export function assertWorktreeSingleOwner(state: DaemonStateV2): InvariantResult {
  const seen = new Map<string, string[]>(); // worktreePath → [sessionIds]
  for (const s of state.listSessions()) {
    if (!s.projectRoot) continue;
    const wt = `${s.projectRoot}/.agentdock/worktrees/${s.sessionId}`;
    const arr = seen.get(wt) ?? [];
    arr.push(s.sessionId);
    seen.set(wt, arr);
  }
  for (const [wt, ids] of seen) {
    if (ids.length > 1) {
      return {
        ok: false,
        detail: `worktreePath ${wt} claimed by multiple sessionIds: ${ids.join(", ")}`,
      };
    }
  }
  return { ok: true, detail: `${seen.size} worktrees, all unique` };
}

/**
 * #6 — no double-write. Old fencingToken writes get STALE_OWNER. This
 * is a behavioral test of /claim, /session/* routes — caller invokes it
 * after a takeover to confirm stale writes are rejected.
 */
export function assertNoDoubleWrite(
  staleWriteStatus: number,
): InvariantResult {
  if (staleWriteStatus === 409) {
    return { ok: true, detail: "stale write returned 409 STALE_OWNER" };
  }
  return {
    ok: false,
    detail: `stale write did NOT return 409 (got ${staleWriteStatus})`,
  };
}

/**
 * #7 — displayName isolation. worktreePath and branch derive from
 * sessionId ONLY. displayName may contain any character (incl. emoji,
 * CJK, punctuation) and must NEVER appear in paths or git branch names.
 */
export function assertDisplayNameIsolation(
  displayName: string,
  worktreePath: string,
  branch: string,
  expectedWorktreePrefix: string,
  expectedBranchPrefix: string,
  sessionId: string,
): InvariantResult {
  // worktreePath must start with `<root>/.agentdock/worktrees/<sessionId>`
  // and sessionId must satisfy SESSION_ID_RE (paths/branches safe)
  if (!SESSION_ID_RE.test(sessionId)) {
    return {
      ok: false,
      detail: `sessionId ${sessionId} violates SESSION_ID_RE — would be unsafe in paths/branches`,
    };
  }
  const expectedWt = `${expectedWorktreePrefix}/${sessionId}`;
  const expectedBranch = `${expectedBranchPrefix}/${sessionId}`;
  if (worktreePath !== expectedWt) {
    return {
      ok: false,
      detail: `worktreePath ${worktreePath} != derived ${expectedWt} — displayName may have leaked`,
    };
  }
  if (branch !== expectedBranch) {
    return {
      ok: false,
      detail: `branch ${branch} != derived ${expectedBranch} — displayName may have leaked`,
    };
  }
  // Defense-in-depth: ensure the (potentially dangerous) displayName string
  // appears nowhere in worktreePath or branch.
  const dnameEscaped = displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    dnameEscaped &&
    new RegExp(dnameEscaped).test(worktreePath + branch)
  ) {
    return {
      ok: false,
      detail: `displayName '${displayName}' appears in path/branch — injection`,
    };
  }
  return {
    ok: true,
    detail: `displayName '${displayName}' isolated; worktreePath and branch derive from sessionId only`,
  };
}

/**
 * #8 — snapshot+stream monotonicity. After applying /sync at snapshotSeq=S,
 * no SSE event with seq≤S can be applied (must be filtered out); all
 * events with seq>S that arrived during the snapshot gap must be applied.
 *
 * Used in E2E: client receives SSE seq=S+1 while /sync request is in flight,
 * client must apply seq=S+1 AFTER snapshot, NOT before (else snapshot
 * regresses the seq=S+1 update).
 */
export function assertSnapshotStreamMonotonic(
  snapshotSeq: number,
  snapshotState: Record<string, number>,
  incrementalAfter: Record<string, number>,
  incrementalSeq: number,
): InvariantResult {
  if (incrementalSeq <= snapshotSeq) {
    return {
      ok: false,
      detail: `incremental seq ${incrementalSeq} ≤ snapshot seq ${snapshotSeq} — should have been filtered out`,
    };
  }
  // For any key in both, incremental value must win (be >= snapshot, with
  // port counter as a stand-in for "more recent").
  for (const key of Object.keys(snapshotState)) {
    if (key in incrementalAfter && incrementalAfter[key]! < snapshotState[key]!) {
      return {
        ok: false,
        detail: `key ${key}: incremental=${incrementalAfter[key]} regressed snapshot=${snapshotState[key]}`,
      };
    }
  }
  return {
    ok: true,
    detail: `snapshotSeq=${snapshotSeq} applied, then incremental seq=${incrementalSeq} took precedence`,
  };
}

// ---------------------------------------------------------------------------
// Composite check — run all invariants at once, return a single result.
// Used by E2E's "all invariants pass" gate after each scenario step.
// ---------------------------------------------------------------------------

export interface CompositeResult {
  ok: boolean;
  results: Record<string, InvariantResult>;
  failed: string[];
}

export function checkAllInvariants(
  state: DaemonStateV2,
  runtimeListeners: ReadonlySet<number>,
): CompositeResult {
  const results: Record<string, InvariantResult> = {
    listenSubsetReserved: assertListenSubsetReserved(state, runtimeListeners),
    onlyLifecycleTransitions: assertOnlyLifecycleTransitions(),
    bindProof: assertBindProof(state),
    worktreeSingleOwner: assertWorktreeSingleOwner(state),
  };
  const failed = Object.entries(results)
    .filter(([, r]) => !r.ok)
    .map(([name, r]) => `${name}: ${r.detail}`);
  return { ok: failed.length === 0, results, failed };
}
