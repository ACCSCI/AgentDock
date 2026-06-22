/**
 * RECOVERING state machine controller — 新架构 §5.2.
 *
 * Manages the daemon's transition out of RECOVERING into READY. Uses a
 * dynamic convergence window: early-exit when all expected sessions have
 * reported, but cap at RECOVERING_HARD_MAX regardless.
 *
 * Expected count comes from the WAL snapshot at boot. If WAL is empty
 * (fresh install), expected=0 → early-exit after RECOVERING_SOFT_MIN.
 *
 * State transitions:
 *   boot → RECOVERING
 *     ↓ soft_min elapsed AND reports_in == expected_in_wal
 *     ↓ OR hard_max elapsed
 *   RECOVERING → READY
 *
 * During RECOVERING:
 *   - new /claim for unknown sessionIds → return RECOVERING error
 *   - recovery /claim (sessionId in wal OR already-reported-this-window) → allowed
 *   - reconciliation pauses C1/C2 takeover (§4.4 — RECOVERING期间暂缓卡死判定)
 */
import {
  RECOVERING_HARD_MAX_MS,
  RECOVERING_SOFT_MIN_MS,
} from "./constants.js";
import type { DaemonStateV2, DaemonLifecycleState } from "./daemon-state-v2.js";

/** How often the daemon's RECOVERING controller ticks (daemon-side). */
export const RECOVERING_TICK_INTERVAL_MS = 500;

export interface RecoveringConfig {
  expectedSessionIds: ReadonlySet<string>;
  softMinMs?: number; // override RECOVERING_SOFT_MIN_MS
  hardMaxMs?: number; // override RECOVERING_HARD_MAX_MS
  now?: () => number; // injectable clock for tests
  onTransition?: (next: DaemonLifecycleState, reason: string) => void;
}

export interface RecoveringController {
  /** True iff currently in RECOVERING. */
  isRecovering(): boolean;
  /** Mark a sessionId as having reported in. Counts toward early-exit. */
  recordReport(sessionId: string): void;
  /** Tick the state machine — call periodically (e.g. every 500ms). */
  tick(): DaemonLifecycleState;
  /** Force transition (e.g. /admin endpoint, tests). */
  forceReady(reason: string): void;
  /** Snapshot of state for /debug/state. */
  snapshot(): {
    state: DaemonLifecycleState;
    elapsedMs: number;
    expected: number;
    reported: number;
    softMinMs: number;
    hardMaxMs: number;
  };
}

/**
 * Create a RECOVERING state machine tied to a DaemonStateV2. The controller
 * mutates `state.state` directly when transitioning.
 */
export function createRecoveringController(
  state: DaemonStateV2,
  cfg: RecoveringConfig,
): RecoveringController {
  const softMin = cfg.softMinMs ?? RECOVERING_SOFT_MIN_MS;
  const hardMax = cfg.hardMaxMs ?? RECOVERING_HARD_MAX_MS;
  const now = cfg.now ?? Date.now;

  const enteredAt = now();
  const reported = new Set<string>();

  // Force RECOVERING at controller creation — this is the only place that
  // enters the state. Daemon boot wires this in right after WAL load.
  state.setState("RECOVERING");

  function recordReport(sessionId: string): void {
    if (cfg.expectedSessionIds.has(sessionId)) {
      reported.add(sessionId);
    }
  }

  function transition(next: DaemonLifecycleState, reason: string): void {
    if (state.state === next) return;
    state.setState(next);
    cfg.onTransition?.(next, reason);
  }

  function tick(): DaemonLifecycleState {
    if (state.state !== "RECOVERING") return state.state;
    const elapsed = now() - enteredAt;

    // Early exit: soft_min elapsed AND all expected reports are in
    const allReported =
      reported.size >= cfg.expectedSessionIds.size &&
      cfg.expectedSessionIds.size > 0;
    const noExpected = cfg.expectedSessionIds.size === 0;

    if (elapsed >= softMin && (allReported || noExpected)) {
      transition("READY", `early-exit: all ${reported.size} expected reported`);
      return state.state;
    }

    // Hard cap: force READY even if reports incomplete
    if (elapsed >= hardMax) {
      transition(
        "READY",
        `hard-cap at ${hardMax}ms with ${reported.size}/${cfg.expectedSessionIds.size} reported`,
      );
      return state.state;
    }

    return "RECOVERING";
  }

  function forceReady(reason: string): void {
    transition("READY", reason);
  }

  function snapshot() {
    return {
      state: state.state,
      elapsedMs: now() - enteredAt,
      expected: cfg.expectedSessionIds.size,
      reported: reported.size,
      softMinMs: softMin,
      hardMaxMs: hardMax,
    };
  }

  return {
    isRecovering: () => state.state === "RECOVERING",
    recordReport,
    tick,
    forceReady,
    snapshot,
  };
}

/**
 * RECOVERING gating predicate — should this claim be allowed?
 *
 * Returns { allow: true } if:
 *   - state is READY, OR
 *   - state is RECOVERING AND sessionId is in expected set (recovery re-registration)
 *
 * Returns { allow: false, code: 'RECOVERING' } otherwise.
 */
export function gateClaimInRecovering(
  state: DaemonStateV2,
  sessionId: string,
  expectedSessionIds: ReadonlySet<string>,
  alreadyReportedThisWindow: ReadonlySet<string>,
):
  | { allow: true }
  | { allow: false; code: "RECOVERING"; message: string } {
  if (state.isReady()) return { allow: true };
  // RECOVERING — only recovery claims pass
  if (
    expectedSessionIds.has(sessionId) ||
    alreadyReportedThisWindow.has(sessionId)
  ) {
    return { allow: true };
  }
  return {
    allow: false,
    code: "RECOVERING",
    message:
      "Daemon is in RECOVERING; non-recovery claims are rejected. Retry after READY.",
  };
}
